import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALL_TOOL_NAMES, effectiveToolNames, validatePermissionsConfig } from "../console/permissions.mjs";
import { handoffStatus, readHandoffArtifact, readTaskSchema } from "./handoff-core.mjs";
import { resolvePaths } from "../lib/paths.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productPaths = resolvePaths();
const positional = process.argv.slice(2).filter(arg => arg !== "--self-test");
if (positional.length > 1 || positional.some(arg => arg.startsWith("--"))) throw new Error("Usage: local-evidence-mcp.mjs [projects.json] [--self-test]");
const handoffStateRoot = process.env.SANDBOX_HANDOFF_STATE_ROOT
  ? path.resolve(process.env.SANDBOX_HANDOFF_STATE_ROOT)
  : path.join(productPaths.stateDir, "handoff");
const configPath = path.resolve(positional[0] || process.env.SANDBOX_MCP_READONLY_CONFIG || path.join(productPaths.configDir, "local-evidence-projects.json"));
const permissionsPath = path.resolve(process.env.SANDBOX_MCP_PERMISSIONS_CONFIG || process.env.LOCAL_EVIDENCE_PERMISSIONS_CONFIG || path.join(productPaths.configDir, "local-evidence-permissions.json"));
function policyPath(name, override) {
  if (override) return path.resolve(override);
  const configured = path.join(productPaths.configDir, name);
  return fs.existsSync(configured) ? configured : path.join(repoRoot, "config", name);
}
const denylistPath = policyPath("local-evidence-denylist.json", process.env.LOCAL_EVIDENCE_DENYLIST_CONFIG);
const filePolicyPath = policyPath("local-evidence-file-policy.json", process.env.LOCAL_EVIDENCE_FILE_POLICY_CONFIG);
const receiptPath = process.env.LOCAL_EVIDENCE_RECEIPT_PATH
  ? path.resolve(process.env.LOCAL_EVIDENCE_RECEIPT_PATH)
  : path.join(productPaths.logsDir, "readonly", "tool-receipts.jsonl");
const runId = process.env.LOCAL_EVIDENCE_RUN_ID || `local-evidence-${process.pid}`;
const DEFAULT_MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024;
const browserToolAliases = process.env.LOCAL_EVIDENCE_BROWSER_TOOL_NAMES === "unprefixed";
const SERVER_INSTRUCTIONS = [
  "Sandbox MCP reads only explicitly admitted local projects. Start with project.list_projects, then use project.get_project_summary or project.get_project_progress before narrow list_tree, read_text_file, or search_text calls.",
  "Treat returned data as local evidence only, not proof of remote state, CI, deployment, production, or scientific validity.",
  "Do not retry unchanged failures. Connection or SSE HTTP 404 happens before local tool execution; local policy, path, and argument failures return MCP tool results with isError=true."
].join(" ");
const READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
});
let config = null;
let permissions = null;
let denylist = null;
let filePolicy = null;
let projectCache = new Map();
let projectStartupIssues = [];
let protocolOutputFailureHandled = false;
let protocolInputCloseHandled = false;

function handleProtocolOutputFailure(error) {
  if (protocolOutputFailureHandled) return;
  protocolOutputFailureHandled = true;
  const parentPid = process.ppid;
  const parentRestartRequested = process.env.SANDBOX_MCP_TUNNEL_MANAGED === "1" && parentPid > 1;
  try {
    fs.writeSync(2, `${JSON.stringify({
      schema_version: "local_evidence_protocol_output_failure.v1",
      run_id: runId,
      timestamp: new Date().toISOString(),
      code: error?.code ?? null,
      syscall: error?.syscall ?? null,
      parent_restart_requested: parentRestartRequested
    })}\n`);
  } catch {
    // A protocol-output failure must not recurse through the normal stream logger.
  }
  process.stdin.pause();
  setTimeout(() => {
    if (parentRestartRequested) {
      try { process.kill(parentPid, "SIGTERM"); } catch {}
    }
    process.exit(1);
  }, 10);
}

function writeProtocolLine(line) {
  if (protocolOutputFailureHandled) return false;
  try {
    return process.stdout.write(line);
  } catch (error) {
    handleProtocolOutputFailure(error);
    return false;
  }
}

process.stdout.on("error", handleProtocolOutputFailure);

function handleProtocolInputClose() {
  if (protocolInputCloseHandled || protocolOutputFailureHandled) return;
  protocolInputCloseHandled = true;
  const parentPid = process.ppid;
  const parentRestartRequested = process.env.SANDBOX_MCP_TUNNEL_MANAGED === "1" && parentPid > 1;
  if (!parentRestartRequested) return;
  try {
    fs.writeSync(2, `${JSON.stringify({
      schema_version: "local_evidence_protocol_input_close.v1",
      run_id: runId,
      timestamp: new Date().toISOString(),
      parent_restart_requested: true
    })}\n`);
  } catch {
    // An input-close recovery event must not depend on the protocol output pipe.
  }
  setTimeout(() => {
    try { process.kill(parentPid, "SIGTERM"); } catch {}
    process.exit(1);
  }, 10);
}

function maxMcpResponseBytes() {
  const environmentValue = Number(process.env.LOCAL_EVIDENCE_MAX_MCP_RESPONSE_BYTES);
  if (Number.isInteger(environmentValue) && environmentValue > 0) return environmentValue;
  const configuredValue = Number(filePolicy?.max_mcp_response_bytes);
  if (Number.isInteger(configuredValue) && configuredValue > 0) return configuredValue;
  return DEFAULT_MAX_MCP_RESPONSE_BYTES;
}

function maxTextBytes() {
  const configuredValue = Number(filePolicy?.max_text_bytes);
  return Number.isInteger(configuredValue) && configuredValue > 0 ? configuredValue : 1024 * 1024;
}

function maxInlineTextBytes() {
  const configuredValue = Number(filePolicy?.max_inline_text_bytes);
  return Number.isInteger(configuredValue) && configuredValue > 0 ? configuredValue : 1024 * 1024;
}

function maxMcpChunkBytes() {
  const configuredValue = Number(filePolicy?.max_mcp_chunk_bytes);
  return Number.isInteger(configuredValue) && configuredValue > 0 ? configuredValue : 4 * 1024 * 1024;
}

function parseByteInteger(value, fieldName, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${fieldName} must be an integer >= ${minimum}`);
  }
  return value;
}

function logProtocolRequest(message) {
  try {
    process.stderr.write(`${JSON.stringify({
      schema_version: "local_evidence_protocol_event.v1",
      run_id: runId,
      timestamp: new Date().toISOString(),
      direction: "request",
      method: typeof message?.method === "string" ? message.method : null,
      rpc_request_id: message?.id ?? null,
      notification: message?.id === undefined || message?.id === null
    })}\n`);
  } catch {
    // Protocol diagnostics must never break the MCP response path.
  }
}

function respond(id, result) {
  if (id === undefined || id === null) return;
  const response = { jsonrpc: "2.0", id, result };
  const serialized = JSON.stringify(response);
  const responseBytes = Buffer.byteLength(serialized, "utf8");
  const maxBytes = maxMcpResponseBytes();
  if (responseBytes > maxBytes) {
    const boundedError = {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32003,
        message: "MCP response exceeds the configured response-size limit; narrow the path or read a focused file",
        data: {
          response_bytes: responseBytes,
          max_response_bytes: maxBytes,
          response_size_guard: "local_evidence_mcp.v1"
        }
      }
    };
    writeProtocolLine(`${JSON.stringify(boundedError)}\n`);
    return;
  }
  writeProtocolLine(`${serialized}\n`);
}

function respondError(id, code, message) {
  if (id === undefined || id === null) return;
  const boundedMessage = String(message ?? "").slice(0, 2000);
  writeProtocolLine(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: boundedMessage } })}\n`);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function hashFile(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeRel(inputPath = ".") {
  const raw = String(inputPath || ".");
  if (path.isAbsolute(raw)) {
    throw Object.assign(new Error("Absolute paths are not allowed"), { evidencePath: raw });
  }
  const normalized = path.posix.normalize(raw.replaceAll(path.sep, "/"));
  return normalized === "." ? "." : normalized.replace(/^\.\/+/, "");
}

function normalizePolicyPath(relPath) {
  const normalized = String(relPath || ".").replaceAll(path.sep, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return normalized || ".";
}

function pathSegments(relPath) {
  const normalized = normalizePolicyPath(relPath);
  return normalized === "." ? [] : normalized.split("/");
}

function globSegments(pattern) {
  return normalizePolicyPath(pattern).split("/");
}

function segmentMatches(patternSegment, pathSegment) {
  const regex = patternSegment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${regex}$`).test(pathSegment);
}

function globMatches(relPath, pattern) {
  const relSegments = pathSegments(relPath);
  const patternSegments = globSegments(pattern);
  const memo = new Map();
  function match(patternIndex, relIndex) {
    const memoKey = `${patternIndex}:${relIndex}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    let matched = false;
    if (patternIndex === patternSegments.length) {
      matched = relIndex === relSegments.length;
    } else if (patternSegments[patternIndex] === "**") {
      matched = match(patternIndex + 1, relIndex);
      for (let nextRelIndex = relIndex; !matched && nextRelIndex < relSegments.length; nextRelIndex += 1) {
        matched = match(patternIndex + 1, nextRelIndex + 1);
      }
    } else if (relIndex < relSegments.length && segmentMatches(patternSegments[patternIndex], relSegments[relIndex])) {
      matched = match(patternIndex + 1, relIndex + 1);
    }
    memo.set(memoKey, matched);
    return matched;
  }
  return match(0, 0);
}

function matchesAny(relPath, patterns) {
  return patterns.some((pattern) => globMatches(relPath, pattern));
}

function canContainAllowed(relPath, patterns) {
  const relSegments = pathSegments(relPath);
  if (relSegments.length === 0) return true;
  return patterns.some((pattern) => {
    if (globMatches(relPath, pattern)) return true;
    const patternSegments = globSegments(pattern);
    let patternIndex = 0;
    for (let relIndex = 0; relIndex < relSegments.length; relIndex += 1) {
      const patternSegment = patternSegments[patternIndex];
      if (patternSegment === "**") return true;
      if (!patternSegment || !segmentMatches(patternSegment, relSegments[relIndex])) return false;
      patternIndex += 1;
    }
    return patternIndex < patternSegments.length;
  });
}

function loadConfig() {
  config = loadJson(configPath);
  if (config?.schema_version !== "local_evidence_projects.v1" || !config.projects || typeof config.projects !== "object" || Array.isArray(config.projects)) throw new Error("Invalid read-only project configuration");
  for (const [id, project] of Object.entries(config.projects)) {
    if (!project || project.mode !== "read_only") throw new Error(`Read-only server rejects non-read_only project: ${id}`);
    if (typeof project.root !== "string" || !path.isAbsolute(project.root)) throw new Error(`Project root must be absolute: ${id}`);
    if (!Array.isArray(project.allowed_globs) || !project.allowed_globs.length || project.allowed_globs.some(glob => typeof glob !== "string" || !glob)) throw new Error(`Project allowlist is required: ${id}`);
    if (!Array.isArray(project.denied_globs) || project.denied_globs.some(glob => typeof glob !== "string" || !glob)) throw new Error(`Project denylist is required: ${id}`);
    if (project.enabled !== undefined && typeof project.enabled !== "boolean") throw new Error(`Project enabled must be boolean: ${id}`);
  }
  permissions = loadJson(permissionsPath);
  validatePermissionsConfig(permissions);
  denylist = loadJson(denylistPath);
  filePolicy = loadJson(filePolicyPath);
  projectCache = new Map();
  projectStartupIssues = [];
  for (const [projectId, project] of Object.entries(config.projects ?? {})) {
    if (project.enabled !== true) continue;
    let root;
    let rootRealpath;
    try {
      root = path.resolve(project.root);
      rootRealpath = fs.realpathSync(root);
      if (!fs.statSync(rootRealpath).isDirectory()) {
        throw Object.assign(new Error("project root is not a directory"), { code: "ENOTDIR" });
      }
    } catch (error) {
      projectStartupIssues.push({
        project_id: projectId,
        root: root ?? (typeof project?.root === "string" ? project.root : null),
        code: error?.code ?? null,
        reason: error?.message || "project root could not be loaded"
      });
      continue;
    }
    projectCache.set(projectId, {
      project_id: projectId,
      ...project,
      root,
      root_realpath: rootRealpath,
      denied_globs: [...new Set([...(denylist.denied_globs ?? []), ...(project.denied_globs ?? [])])]
    });
  }
}

function getProject(projectId) {
  const project = projectCache.get(String(projectId || ""));
  if (!project) throw new Error(`Unknown or disabled project: ${projectId}`);
  return project;
}

function toProjectRelative(rootRealpath, realTarget) {
  const realRelative = path.relative(rootRealpath, realTarget);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    return null;
  }
  return normalizePolicyPath(realRelative || ".");
}

function assertPolicyPath(project, relPath, { allowContainer = false } = {}) {
  const normalized = normalizePolicyPath(relPath);
  if (matchesAny(normalized, project.denied_globs)) {
    throw Object.assign(new Error("Path denied by local evidence policy"), { evidencePath: normalized });
  }
  const allowed = matchesAny(normalized, project.allowed_globs);
  const containerAllowed = allowContainer && canContainAllowed(normalized, project.allowed_globs);
  if (normalized !== "." && !allowed && !containerAllowed) {
    throw Object.assign(new Error("Path is not allowed by project allowlist"), { evidencePath: normalized });
  }
}

function pathAllowed(project, relPath, { allowContainer = false } = {}) {
  try {
    assertPolicyPath(project, relPath, { allowContainer });
    return true;
  } catch {
    return false;
  }
}

function resolveProjectPath(project, inputPath = ".", options = {}) {
  const relPath = normalizeRel(inputPath);
  const lexicalTarget = path.resolve(project.root, relPath);
  const lexicalRelative = path.relative(project.root, lexicalTarget);
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw Object.assign(new Error("Path escapes project root"), { evidencePath: relPath });
  }
  assertPolicyPath(project, relPath, options);
  let realTarget;
  try {
    realTarget = fs.realpathSync(lexicalTarget);
  } catch (error) {
    throw Object.assign(error, { evidencePath: relPath });
  }
  const realRelative = toProjectRelative(project.root_realpath, realTarget);
  if (realRelative === null) {
    throw Object.assign(new Error("Path escapes project root"), { evidencePath: relPath, candidate_realpath: realTarget });
  }
  assertPolicyPath(project, realRelative, options);
  return { relPath, realPath: realRelative, realTarget };
}

function isBinaryBuffer(buffer) {
  return buffer.includes(0);
}

function readTextWithPolicy(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("Path is not a file");
  if (stat.size > maxTextBytes()) throw new Error("File exceeds local evidence max_text_bytes");
  if (stat.size > maxInlineTextBytes()) throw new Error("File exceeds local evidence max_text_bytes inline limit; use offset_bytes and max_bytes for chunked reading");
  const buffer = fs.readFileSync(filePath);
  if (filePolicy.binary_rejection && isBinaryBuffer(buffer)) throw new Error("Binary files are rejected");
  return buffer.toString("utf8");
}

function readArchiveBufferWithPolicy(buffer) {
  if (buffer.length > maxTextBytes()) throw new Error("Archive entry exceeds local evidence max_text_bytes");
  if (buffer.length > maxInlineTextBytes()) throw new Error("Archive entry exceeds local evidence max_text_bytes inline limit");
  if (filePolicy.binary_rejection && isBinaryBuffer(buffer)) throw new Error("Binary archive entries are rejected");
  return buffer.toString("utf8");
}

function resolveReadWindow(filePath, args, maxFileBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("Path is not a regular file");
  if (stat.size > maxFileBytes) throw new Error(`File exceeds local evidence file limit of ${maxFileBytes} bytes`);
  const offset = args?.offset_bytes === undefined ? 0 : parseByteInteger(args.offset_bytes, "offset_bytes");
  if (offset > stat.size) throw new Error("offset_bytes is beyond the end of the file");
  const remaining = stat.size - offset;
  const requestedLength = args?.max_bytes === undefined
    ? remaining
    : parseByteInteger(args.max_bytes, "max_bytes", 1);
  const length = Math.min(requestedLength, remaining);
  if (length > maxMcpChunkBytes()) {
    throw new Error(`Requested range exceeds local evidence max_mcp_chunk_bytes=${maxMcpChunkBytes()}; provide a smaller max_bytes`);
  }
  return {
    totalBytes: stat.size,
    offset,
    length,
    chunked: offset !== 0 || length !== stat.size
  };
}

function readFileWindow(filePath, window) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(window.length);
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const bytesRead = fs.readSync(descriptor, buffer, totalRead, buffer.length - totalRead, window.offset + totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return totalRead === buffer.length ? buffer : buffer.subarray(0, totalRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function outputJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function outputToolError(error) {
  const structuredContent = {
    error: String(error?.message ?? "Tool execution failed").slice(0, 2000)
  };
  if (error?.tool_error_data && typeof error.tool_error_data === "object") {
    structuredContent.error_data = error.tool_error_data;
  }
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true
  };
}

function assertToolResponseFits(rpcRequestId, result) {
  const responseBytes = Buffer.byteLength(JSON.stringify({
    jsonrpc: "2.0",
    id: rpcRequestId ?? null,
    result
  }), "utf8");
  const maxBytes = maxMcpResponseBytes();
  if (responseBytes <= maxBytes) return;
  throw Object.assign(
    new Error("MCP response exceeds the configured response-size limit; narrow the path or read a focused file"),
    {
      tool_error_data: {
        response_bytes: responseBytes,
        max_response_bytes: maxBytes,
        response_size_guard: "local_evidence_mcp.v1"
      }
    }
  );
}

function handoffTaskId(args) {
  const taskId = String(args?.task_id || "").trim();
  if (!taskId) throw new Error("task_id is required");
  return taskId;
}

function getHandoffStatus() {
  return handoffStatus({ state: handoffStateRoot });
}

function readHandoffContract(args) {
  return readHandoffArtifact({ state: handoffStateRoot, taskId: handoffTaskId(args), artifact: "contract" });
}

function readHandoffReceipt(args) {
  return readHandoffArtifact({ state: handoffStateRoot, taskId: handoffTaskId(args), artifact: "receipt" });
}

function readHandoffArtifactManifest(args) {
  const artifact = String(args?.artifact || "diff");
  if (!["commands", "tests", "diff", "import", "validation"].includes(artifact)) throw new Error(`未知 handoff artifact: ${artifact}`);
  return readHandoffArtifact({ state: handoffStateRoot, taskId: handoffTaskId(args), artifact });
}

function readHandoffSchema(args) {
  return { schema_name: args?.name || "TASK_CONTRACT.schema.json", schema: readTaskSchema(args?.name || "TASK_CONTRACT.schema.json") };
}

function activeToolNames() {
  return effectiveToolNames(permissions, "readonly");
}

function exposedToolName(canonicalName) {
  return browserToolAliases ? canonicalName.replace(/^project\./, "") : canonicalName;
}

function canonicalToolName(rawName) {
  const toolName = String(rawName || "");
  if (ALL_TOOL_NAMES.includes(toolName)) return toolName;
  const prefixedToolName = `project.${toolName}`;
  if (browserToolAliases && ALL_TOOL_NAMES.includes(prefixedToolName)) return prefixedToolName;
  return toolName;
}

function toolDefinitions() {
  const definitions = [
    { name: "project.list_projects", description: "Use this when you need the admitted project IDs before any project-specific read.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "project.get_project_summary", description: "Use this when you need one project's root, mode, Git status summary, and policy metadata.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false } },
    { name: "project.get_project_progress", description: "Use this when you need the configured current-state and active-contract documents in declared priority order.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false } },
    { name: "project.list_tree", description: "Use this when you need a bounded allowlisted directory listing before choosing exact files.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, path: { type: "string" }, depth: { type: "integer" } }, additionalProperties: false } },
    { name: "project.read_text_file", description: "Use this when you know the exact allowlisted UTF-8 file path. Large files require offset_bytes and max_bytes.", inputSchema: { type: "object", required: ["project_id", "path"], properties: { project_id: { type: "string" }, path: { type: "string" }, offset_bytes: { type: "integer", minimum: 0 }, max_bytes: { type: "integer", minimum: 1 } }, additionalProperties: false } },
    { name: "project.search_text", description: "Use this when you need a literal search within one allowlisted file or directory path.", inputSchema: { type: "object", required: ["project_id", "query"], properties: { project_id: { type: "string" }, query: { type: "string" }, path: { type: "string", description: "Allowlisted file or directory path; defaults to the project root." }, max_results: { type: "integer" } }, additionalProperties: false } },
    { name: "project.get_manifest", description: "Return hashes and sizes for allowlisted files.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false } },
    { name: "project.get_git_status", description: "Run fixed read-only git status for an admitted project.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false } },
    { name: "project.get_git_diff", description: "Run fixed read-only git diff, staged diff, untracked file, and status probes for an admitted project.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" } }, additionalProperties: false } },
    { name: "project.get_recent_artifacts", description: "List recent allowlisted artifacts by mtime.", inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, max_results: { type: "integer" } }, additionalProperties: false } },
    { name: "project.read_file_base64", description: "Read one allowlisted regular file as base64. Files larger than the inline chunk limit require offset_bytes and max_bytes.", inputSchema: { type: "object", required: ["project_id", "path"], properties: { project_id: { type: "string" }, path: { type: "string" }, offset_bytes: { type: "integer", minimum: 0 }, max_bytes: { type: "integer", minimum: 1 } }, additionalProperties: false } },
    { name: "project.list_archive_entries", description: "List safe visible entries inside an allowlisted .zip, .tar, .tgz, or .tar.gz archive without extracting it to disk.", inputSchema: { type: "object", required: ["project_id", "path"], properties: { project_id: { type: "string" }, path: { type: "string" }, max_results: { type: "integer" } }, additionalProperties: false } },
    { name: "project.read_archive_text_file", description: "Read one safe UTF-8 text entry inside an allowlisted .zip, .tar, .tgz, or .tar.gz archive without extracting it to disk.", inputSchema: { type: "object", required: ["project_id", "path", "entry_path"], properties: { project_id: { type: "string" }, path: { type: "string" }, entry_path: { type: "string" } }, additionalProperties: false } },
    { name: "project.read_archive_file_base64", description: "Read one allowlisted archive as base64. Large archives require offset_bytes and max_bytes.", inputSchema: { type: "object", required: ["project_id", "path"], properties: { project_id: { type: "string" }, path: { type: "string" }, offset_bytes: { type: "integer", minimum: 0 }, max_bytes: { type: "integer", minimum: 1 } }, additionalProperties: false } },
    { name: "handoff.get_status", description: "Read-only status of locally imported task contracts, frozen snapshots, approvals, validation, and execution receipts. This tool cannot execute or approve anything.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "handoff.read_contract", description: "Read one locally imported TASK_CONTRACT and its frozen snapshot binding.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } }, additionalProperties: false } },
    { name: "handoff.read_receipt", description: "Read one local execution receipt. The receipt never represents merge, push, or final acceptance.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" } }, additionalProperties: false } },
    { name: "handoff.read_artifact_manifest", description: "Read-only access to a task command log, test result, diff manifest, import receipt, or validation receipt.", inputSchema: { type: "object", required: ["task_id"], properties: { task_id: { type: "string" }, artifact: { type: "string", enum: ["commands", "tests", "diff", "import", "validation"] } }, additionalProperties: false } },
    { name: "handoff.read_schema", description: "Read one of the local handoff JSON schemas.", inputSchema: { type: "object", properties: { name: { type: "string", enum: ["TASK_CONTRACT.schema.json", "EXECUTION_RECEIPT.schema.json"] } }, additionalProperties: false } },
  ];
  const active = new Set(activeToolNames());
  return definitions.filter((tool) => active.has(tool.name)).map((tool) => ({
    ...tool,
    name: exposedToolName(tool.name),
    annotations: READ_ONLY_TOOL_ANNOTATIONS
  }));
}

function walkAllowed(project, startRel = ".", maxDepth = 3) {
  const start = resolveProjectPath(project, startRel, { allowContainer: true });
  const entries = [];
  const visitedDirs = new Set();
  function visit(realDir, relDir, depth) {
    if (depth < 0) return;
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);
    const dirEntries = fs.readdirSync(realDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const childRel = relDir === "." ? entry.name : `${relDir}/${entry.name}`;
      const lexicalChild = path.join(project.root, childRel);
      let childReal;
      try {
        childReal = fs.realpathSync(lexicalChild);
      } catch {
        continue;
      }
      const realRelative = toProjectRelative(project.root_realpath, childReal);
      if (realRelative === null) continue;
      const realStat = fs.statSync(childReal);
      const isDir = realStat.isDirectory();
      const isAllowed =
        pathAllowed(project, childRel, { allowContainer: false }) &&
        pathAllowed(project, realRelative, { allowContainer: false });
      const isAllowedContainer =
        pathAllowed(project, childRel, { allowContainer: true }) &&
        pathAllowed(project, realRelative, { allowContainer: true });
      if (isAllowed) {
        entries.push({
          path: childRel,
          type: isDir ? "directory" : "file",
          byte_length: isDir ? null : realStat.size,
          mtime: realStat.mtime.toISOString()
        });
      }
      if (isDir && depth > 0 && isAllowedContainer) {
        visit(childReal, childRel, depth - 1);
      }
    }
  }
  const stat = fs.statSync(start.realTarget);
  if (stat.isDirectory()) visit(start.realTarget, start.relPath, maxDepth);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function listProjects() {
  return {
    startup_issues: projectStartupIssues,
    projects: [...projectCache.values()].map((project) => ({
      project_id: project.project_id,
      description: typeof project.description === "string" ? project.description : null,
      project_line: typeof project.project_line === "string" ? project.project_line : null,
      root: project.root,
      mode: project.mode,
      enabled: project.enabled,
      progress_file_count: Array.isArray(project.progress_files) ? project.progress_files.length : 0,
      allowed_glob_count: project.allowed_globs.length,
      denied_glob_count: project.denied_globs.length
    }))
  };
}

function getGitStatus(project) {
  const child = spawnSync("git", ["status", "--short", "--branch"], { cwd: project.root, encoding: "utf8", timeout: 5000 });
  const lines = (child.stdout || "").trim().split("\n").filter(Boolean);
  return {
    project_id: project.project_id,
    branch: lines[0]?.replace(/^##\s*/, "") || "unknown",
    porcelain: lines.slice(1),
    exit_status: child.status,
    stderr_hash: sha256(child.stderr || "")
  };
}

function getGitDiff(project) {
  const status = spawnSync("git", ["status", "--porcelain=v1", "--branch"], { cwd: project.root, encoding: "utf8", timeout: 5000 });
  const stat = spawnSync("git", ["diff", "--stat"], { cwd: project.root, encoding: "utf8", timeout: 5000 });
  const names = spawnSync("git", ["diff", "--name-only"], { cwd: project.root, encoding: "utf8", timeout: 5000 });
  const cachedStat = spawnSync("git", ["diff", "--cached", "--stat"], { cwd: project.root, encoding: "utf8", timeout: 5000 });
  const cachedNames = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: project.root, encoding: "utf8", timeout: 5000 });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: project.root, encoding: "utf8", timeout: 5000 });
  return {
    project_id: project.project_id,
    status_porcelain: (status.stdout || "").trim().split("\n").filter(Boolean),
    stat: stat.stdout || "",
    files: (names.stdout || "").trim().split("\n").filter(Boolean),
    cached_stat: cachedStat.stdout || "",
    cached_files: (cachedNames.stdout || "").trim().split("\n").filter(Boolean),
    untracked_files: (untracked.stdout || "").trim().split("\n").filter(Boolean),
    exit_status: Math.max(status.status ?? 0, stat.status ?? 0, names.status ?? 0, cachedStat.status ?? 0, cachedNames.status ?? 0, untracked.status ?? 0),
    stderr_hash: sha256([status.stderr, stat.stderr, names.stderr, cachedStat.stderr, cachedNames.stderr, untracked.stderr].join("\n"))
  };
}

function getProjectSummary(args) {
  const project = getProject(args.project_id);
  return {
    project_id: project.project_id,
    description: typeof project.description === "string" ? project.description : null,
    project_line: typeof project.project_line === "string" ? project.project_line : null,
    root: project.root,
    root_realpath: project.root_realpath,
    mode: project.mode,
    allowed_globs: project.allowed_globs,
    write_allowed_globs_count: project.write_allowed_globs?.length ?? 0,
    denied_globs_count: project.denied_globs.length,
    max_text_bytes: maxTextBytes(),
    max_binary_transfer_bytes: maxBinaryTransferBytes(),
    max_inline_text_bytes: maxInlineTextBytes(),
    max_mcp_chunk_bytes: maxMcpChunkBytes(),
    max_mcp_response_bytes: maxMcpResponseBytes(),
    progress_files: Array.isArray(project.progress_files) ? project.progress_files : [],
    git_status: getGitStatus(project)
  };
}

function getProjectProgress(args) {
  const project = getProject(args.project_id);
  const configured = Array.isArray(project.progress_files) ? project.progress_files : [];
  const documents = configured.map((entry) => {
    const item = typeof entry === "string" ? { path: entry, role: "progress_document" } : entry;
    const role = typeof item?.role === "string" && item.role.trim() ? item.role.trim() : "progress_document";
    const configuredPath = typeof item?.path === "string" ? item.path : "";
    try {
      if (!configuredPath) throw new Error("Configured progress path is missing");
      const resolved = resolveProjectPath(project, configuredPath);
      const text = readTextWithPolicy(resolved.realTarget);
      const stat = fs.statSync(resolved.realTarget);
      return {
        role,
        path: resolved.relPath,
        status: "available",
        byte_length: Buffer.byteLength(text, "utf8"),
        mtime: stat.mtime.toISOString(),
        content_hash: sha256(text),
        text
      };
    } catch (error) {
      return {
        role,
        path: configuredPath || null,
        status: "unavailable",
        reason: error.message
      };
    }
  });
  return {
    project_id: project.project_id,
    description: typeof project.description === "string" ? project.description : null,
    project_line: typeof project.project_line === "string" ? project.project_line : null,
    evidence_ceiling: "configured local read-only progress documents; each document remains authoritative only within its own stated claim boundary",
    documents
  };
}

function listTree(args) {
  const project = getProject(args.project_id);
  return {
    project_id: project.project_id,
    path: args.path ?? ".",
    depth: Number.isInteger(args.depth) ? args.depth : 2,
    entries: walkAllowed(project, args.path ?? ".", Number.isInteger(args.depth) ? args.depth : 2)
  };
}

function readTextFile(args) {
  const project = getProject(args.project_id);
  const resolved = resolveProjectPath(project, args.path);
  const window = resolveReadWindow(resolved.realTarget, args, maxTextBytes());
  const buffer = readFileWindow(resolved.realTarget, window);
  if (filePolicy.binary_rejection && isBinaryBuffer(buffer)) throw new Error("Binary files are rejected");
  const text = buffer.toString("utf8");
  return {
    project_id: project.project_id,
    path: resolved.relPath,
    byte_length: buffer.length,
    total_byte_length: window.totalBytes,
    byte_offset: window.offset,
    eof: window.offset + buffer.length >= window.totalBytes,
    chunked: window.chunked,
    content_hash_scope: window.chunked ? "returned_text_chunk" : "returned_text_file",
    content_hash: sha256(text),
    text
  };
}

function searchText(args) {
  const project = getProject(args.project_id);
  const query = String(args.query || "");
  if (!query) throw new Error("query is required");
  const maxResults = Math.min(Math.max(Number(args.max_results || 20), 1), 100);
  const startPath = args.path ?? ".";
  const start = resolveProjectPath(project, startPath, { allowContainer: true });
  const startStat = fs.statSync(start.realTarget);
  const candidates = startStat.isFile()
    ? [{ path: start.relPath, type: "file", byte_length: startStat.size, mtime: startStat.mtime.toISOString() }]
    : startStat.isDirectory()
      ? walkAllowed(project, start.relPath, 6).filter((entry) => entry.type === "file")
      : (() => { throw new Error("Search path must be a regular file or directory"); })();
  const matches = [];
  for (const entry of candidates) {
    if (matches.length >= maxResults) break;
    let text;
    try {
      const resolved = resolveProjectPath(project, entry.path);
      text = readTextWithPolicy(resolved.realTarget);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
      if (lines[index].includes(query)) {
        matches.push({
          path: entry.path,
          line_number: index + 1,
          line_hash: sha256(lines[index]),
          snippet: lines[index].slice(0, 200)
        });
      }
    }
  }
  return { project_id: project.project_id, query, matches };
}

function getManifest(args) {
  const project = getProject(args.project_id);
  const files = walkAllowed(project, ".", 8)
    .filter((entry) => entry.type === "file")
    .map((entry) => {
      const resolved = resolveProjectPath(project, entry.path);
      return {
        path: entry.path,
        byte_length: entry.byte_length,
        content_hash: hashFile(resolved.realTarget)
      };
    });
  return { project_id: project.project_id, files };
}

function getRecentArtifacts(args) {
  const project = getProject(args.project_id);
  const maxResults = Math.min(Math.max(Number(args.max_results || 10), 1), 50);
  const artifactsRoot = path.join(project.root, "artifacts");
  if (!fs.existsSync(artifactsRoot)) {
    return { project_id: project.project_id, artifacts: [] };
  }
  const artifacts = walkAllowed(project, "artifacts", 5)
    .filter((entry) => entry.type === "file")
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, maxResults)
    .map((entry) => {
      const resolved = resolveProjectPath(project, entry.path);
      return {
        path: entry.path,
        byte_length: entry.byte_length,
        mtime: entry.mtime,
        content_hash: hashFile(resolved.realTarget)
      };
    });
  return { project_id: project.project_id, artifacts };
}

function archiveKind(archivePath) {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar") || lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tar";
  throw new Error("Unsupported archive type; expected .zip, .tar, .tgz, or .tar.gz");
}

function maxBinaryTransferBytes() {
  return Number.isInteger(filePolicy.max_binary_transfer_bytes) ? filePolicy.max_binary_transfer_bytes : maxTextBytes();
}

function normalizeArchiveEntryPath(inputPath) {
  const raw = String(inputPath || "");
  if (!raw) throw new Error("entry_path is required");
  if (path.isAbsolute(raw) || raw.startsWith("/") || raw.match(/^[A-Za-z]:/)) {
    throw new Error("Archive entry absolute paths are not allowed");
  }
  const normalized = path.posix.normalize(raw.replaceAll("\\", "/")).replace(/^\.\/+/, "");
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error("Archive entry escapes archive root");
  }
  return normalized;
}

function archiveEntryVisible(project, entryPath) {
  try {
    const normalized = normalizeArchiveEntryPath(entryPath);
    return !matchesAny(normalized, project.denied_globs ?? []);
  } catch {
    return false;
  }
}

function listArchiveEntries(args) {
  const project = getProject(args.project_id);
  const resolved = resolveProjectPath(project, args.path);
  const kind = archiveKind(resolved.realTarget);
  const maxResults = Math.min(Math.max(Number(args.max_results || 200), 1), 5000);
  const command = kind === "zip"
    ? { file: "/usr/bin/unzip", args: ["-Z1", resolved.realTarget] }
    : { file: "/usr/bin/tar", args: ["-tf", resolved.realTarget] };
  const child = spawnSync(command.file, command.args, { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  if (child.status !== 0) {
    throw new Error(`Archive listing failed: ${(child.stderr || child.stdout || "").slice(0, 200)}`);
  }
  const entries = [];
  for (const rawEntry of (child.stdout || "").split("\n")) {
    const entry = rawEntry.trim();
    if (!entry || entry.endsWith("/")) continue;
    if (!archiveEntryVisible(project, entry)) continue;
    entries.push({
      entry_path: normalizeArchiveEntryPath(entry),
      archive_kind: kind
    });
    if (entries.length >= maxResults) break;
  }
  return {
    project_id: project.project_id,
    path: resolved.relPath,
    archive_kind: kind,
    max_results: maxResults,
    entries
  };
}

function readArchiveTextFile(args) {
  const project = getProject(args.project_id);
  const resolved = resolveProjectPath(project, args.path);
  const kind = archiveKind(resolved.realTarget);
  const entryPath = normalizeArchiveEntryPath(args.entry_path);
  if (!archiveEntryVisible(project, entryPath)) {
    throw new Error("Archive entry denied by local evidence policy");
  }
  const list = listArchiveEntries({ project_id: project.project_id, path: resolved.relPath, max_results: 5000 });
  if (!list.entries.some((entry) => entry.entry_path === entryPath)) {
    throw new Error("Archive entry not found or not visible");
  }
  const command = kind === "zip"
    ? { file: "/usr/bin/unzip", args: ["-p", resolved.realTarget, entryPath] }
    : { file: "/usr/bin/tar", args: ["-xOf", resolved.realTarget, entryPath] };
  const child = spawnSync(command.file, command.args, {
    encoding: "buffer",
    timeout: 10000,
    maxBuffer: maxInlineTextBytes() + 1024
  });
  if (child.status !== 0) {
    const stderr = Buffer.isBuffer(child.stderr) ? child.stderr.toString("utf8") : String(child.stderr || "");
    throw new Error(`Archive entry read failed: ${stderr.slice(0, 200)}`);
  }
  const text = readArchiveBufferWithPolicy(child.stdout);
  return {
    project_id: project.project_id,
    path: resolved.relPath,
    archive_kind: kind,
    entry_path: entryPath,
    byte_length: Buffer.byteLength(text, "utf8"),
    content_hash: sha256(text),
    text
  };
}

function readArchiveFileBase64(args) {
  const project = getProject(args.project_id);
  const resolved = resolveProjectPath(project, args.path);
  const kind = archiveKind(resolved.realTarget);
  const window = resolveReadWindow(resolved.realTarget, args, maxBinaryTransferBytes());
  const buffer = readFileWindow(resolved.realTarget, window);
  return {
    project_id: project.project_id,
    path: resolved.relPath,
    archive_kind: kind,
    byte_length: buffer.length,
    total_byte_length: window.totalBytes,
    byte_offset: window.offset,
    eof: window.offset + buffer.length >= window.totalBytes,
    chunked: window.chunked,
    content_hash_scope: window.chunked ? "returned_binary_chunk" : "returned_binary_file",
    content_hash: sha256(buffer),
    base64: buffer.toString("base64")
  };
}

function readFileBase64(args) {
  const project = getProject(args.project_id);
  const resolved = resolveProjectPath(project, args.path);
  const window = resolveReadWindow(resolved.realTarget, args, maxBinaryTransferBytes());
  const buffer = readFileWindow(resolved.realTarget, window);
  return {
    project_id: project.project_id,
    path: resolved.relPath,
    real_path: resolved.realPath,
    file_kind: "regular_file",
    byte_length: buffer.length,
    total_byte_length: window.totalBytes,
    byte_offset: window.offset,
    eof: window.offset + buffer.length >= window.totalBytes,
    chunked: window.chunked,
    content_hash_scope: window.chunked ? "returned_binary_chunk" : "returned_binary_file",
    content_hash: sha256(buffer),
    base64: buffer.toString("base64")
  };
}

function appendReceipt(receipt) {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

function receiptBase(tool, args, project, decision, context = {}) {
  return {
    schema_version: "local_evidence_tool_receipt.v1",
    run_id: runId,
    timestamp: new Date().toISOString(),
    rpc_method: context.rpcMethod ?? "tools/call",
    rpc_request_id: context.rpcRequestId ?? null,
    tool,
    project_id: args?.project_id ?? null,
    path_original: args?.path ?? null,
    root_realpath: project?.root_realpath ?? null,
    decision,
    request_hash: sha256(stableJson({ tool, arguments: args ?? {} }))
  };
}

function handleToolCall(params, context = {}) {
  const tool = canonicalToolName(params?.name);
  const args = params?.arguments ?? {};
  let project = null;
  if (!activeToolNames().includes(tool)) {
    const error = new Error(`MCP 工具已被本地权限策略禁用: ${tool}`);
    appendReceipt({
      ...receiptBase(tool || "unknown", args, project, "reject", context),
      reason: error.message,
      candidate_realpath: null,
      content_returned: false,
      result_hash: sha256(stableJson({ decision: "reject", reason: error.message }))
    });
    throw error;
  }
  try {
    if (args.project_id) project = getProject(args.project_id);
    const result = (() => {
      switch (tool) {
        case "project.list_projects":
          return listProjects();
        case "project.get_project_summary":
          return getProjectSummary(args);
        case "project.get_project_progress":
          return getProjectProgress(args);
        case "project.list_tree":
          return listTree(args);
        case "project.read_text_file":
          return readTextFile(args);
        case "project.search_text":
          return searchText(args);
        case "project.get_manifest":
          return getManifest(args);
        case "project.get_git_status":
          return getGitStatus(getProject(args.project_id));
        case "project.get_git_diff":
          return getGitDiff(getProject(args.project_id));
        case "project.get_recent_artifacts":
          return getRecentArtifacts(args);
        case "project.read_file_base64":
          return readFileBase64(args);
        case "project.list_archive_entries":
          return listArchiveEntries(args);
        case "project.read_archive_text_file":
          return readArchiveTextFile(args);
        case "project.read_archive_file_base64":
          return readArchiveFileBase64(args);
        case "handoff.get_status":
          return getHandoffStatus();
        case "handoff.read_contract":
          return readHandoffContract(args);
        case "handoff.read_receipt":
          return readHandoffReceipt(args);
        case "handoff.read_artifact_manifest":
          return readHandoffArtifactManifest(args);
        case "handoff.read_schema":
          return readHandoffSchema(args);
        default:
          throw new Error(`Unknown tool: ${tool}`);
      }
    })();
    const toolResult = outputJson(result);
    assertToolResponseFits(context.rpcRequestId, toolResult);
    appendReceipt({
      ...receiptBase(tool, args, project, "allow", context),
      reason: "tool_call_ok",
      content_returned: true,
      result_hash: sha256(stableJson(result))
    });
    return toolResult;
  } catch (error) {
    const toolError = outputToolError(error);
    appendReceipt({
      ...receiptBase(tool || "unknown", args, project, "reject", context),
      reason: error.message,
      candidate_realpath: error.candidate_realpath ?? null,
      content_returned: false,
      result_hash: sha256(stableJson(toolError.structuredContent))
    });
    return toolError;
  }
}

function handleRequest(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  logProtocolRequest(message);
  try {
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "local-evidence-mcp", version: "0.2.3" },
          instructions: SERVER_INSTRUCTIONS
        });
        break;
      case "tools/list":
        respond(id, { tools: toolDefinitions() });
        break;
      case "tools/call":
        respond(id, handleToolCall(params, { rpcMethod: method, rpcRequestId: id }));
        break;
      case "ping":
        respond(id, {});
        break;
      default:
        respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    respondError(id, -32000, error.message);
  }
}

function selfTest() {
  loadConfig();
  if (projectStartupIssues.length) throw new Error(`Project validation failed: ${projectStartupIssues.map(item => item.project_id).join(", ")}`);
  const tools = toolDefinitions();
  if (tools.some(tool => tool.annotations?.readOnlyHint !== true)) throw new Error("Non-read-only tool exposed");
  process.stdout.write(JSON.stringify({ ok: true, mode: "read_only", projects: projectCache.size, tools: tools.length }) + "\n");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  loadConfig();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("close", handleProtocolInputClose);
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      handleRequest(JSON.parse(line));
    } catch (error) {
      respondError(null, -32700, error.message);
    }
  });
}
