import { resolvePaths } from '../lib/paths.mjs';
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_STATE_ROOT = path.join(resolvePaths().stateDir, "handoff");
export const TASK_SCHEMA_PATH = path.join(scriptRoot, "schemas", "TASK_CONTRACT.schema.json");
export const RECEIPT_SCHEMA_PATH = path.join(scriptRoot, "schemas", "EXECUTION_RECEIPT.schema.json");

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function now() {
  return new Date().toISOString();
}

function assertNoSecretText(value) {
  const body = typeof value === "string" ? value : stableJson(value);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(body))) throw new Error("计划内容疑似包含 secret material");
}

function assertSafeId(value, fieldName = "task_id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(value)) {
    throw new Error(`${fieldName} 格式无效`);
  }
  return value;
}

function assertNotSymlink(filePath, label = filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`${label} 不能是符号链接`);
  return stat;
}

function ensureDirectory(directory) {
  const resolved = path.resolve(directory);
  if (fs.existsSync(resolved)) {
    const stat = assertNotSymlink(resolved, `目录 ${resolved}`);
    if (!stat.isDirectory()) throw new Error(`路径不是目录: ${resolved}`);
  } else {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  return resolved;
}

export function stateRoot(input = process.env.SANDBOX_HANDOFF_STATE_ROOT || DEFAULT_STATE_ROOT) {
  return ensureDirectory(input);
}

function safeStatePath(root, relativePath) {
  const normalized = path.posix.normalize(String(relativePath).replaceAll(path.sep, "/")).replace(/^\.\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(relativePath)) {
    throw new Error(`状态路径越界: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalized);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`状态路径越界: ${relativePath}`);
  if (fs.existsSync(resolvedRoot)) assertNotSymlink(resolvedRoot, `状态根目录 ${resolvedRoot}`);
  let cursor = resolvedRoot;
  for (const segment of path.relative(resolvedRoot, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor)) assertNotSymlink(cursor, `状态路径 ${cursor}`);
  }
  return target;
}

function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  if (fs.existsSync(filePath)) assertNotSymlink(filePath, filePath);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return filePath;
}

function readJson(filePath) {
  assertNotSymlink(filePath, filePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function appendJsonl(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  if (fs.existsSync(filePath)) assertNotSymlink(filePath, filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function git(root, args) {
  try {
    const result = await execFileAsync("git", args, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    return { status: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    throw new Error(`git ${args.join(" ")} 失败: ${(error.stderr || error.message || "").trim()}`);
  }
}

export async function gitSnapshot(inputRoot) {
  const requestedRoot = fs.realpathSync(path.resolve(inputRoot));
  const top = (await git(requestedRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const repository = fs.realpathSync(top);
  if (repository !== requestedRoot) throw new Error(`目标路径不是 Git 根目录: ${requestedRoot}`);
  const [head, tree, branch, status] = await Promise.all([
    git(repository, ["rev-parse", "HEAD"]),
    git(repository, ["rev-parse", "HEAD^{tree}"]),
    git(repository, ["branch", "--show-current"]),
    git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  const statusText = status.stdout;
  const snapshot = {
    schema_version: "project_snapshot.v1",
    repository,
    branch: branch.stdout.trim(),
    base_commit: head.stdout.trim(),
    tree_hash: tree.stdout.trim(),
    dirty: statusText.length > 0,
    status_hash: sha256(statusText)
  };
  snapshot.snapshot_id = `snapshot_${crypto.createHash("sha256").update(stableJson(snapshot)).digest("hex").slice(0, 32)}`;
  return snapshot;
}

export async function createSnapshot({ root, state = stateRoot() }) {
  const snapshot = await gitSnapshot(root);
  const filePath = safeStatePath(state, `snapshots/${snapshot.snapshot_id}.json`);
  if (fs.existsSync(filePath)) {
    const current = readJson(filePath);
    if (stableJson(current) !== stableJson(snapshot)) throw new Error("snapshot_id 冲突，拒绝覆盖历史快照");
  } else {
    writeJson(filePath, snapshot);
  }
  return { ...snapshot, path: filePath };
}

function normalizeContractPath(input, fieldName) {
  if (typeof input !== "string" || input.trim() === "") throw new Error(`${fieldName} 不能为空`);
  const raw = input.trim().replaceAll("\\", "/");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\0")) throw new Error(`${fieldName} 必须是相对路径: ${input}`);
  const normalized = path.posix.normalize(raw).replace(/^\.\/+/, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`${fieldName} 不能越界或开放整个根目录: ${input}`);
  return normalized;
}

function validatePathList(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${fieldName} 必须是非空数组`);
  return value.map((entry) => normalizeContractPath(entry, `${fieldName}[]`));
}

function validateStringList(value, fieldName, required = false) {
  if (!Array.isArray(value) || (required && value.length === 0) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${fieldName} 必须是字符串数组`);
  }
  return value.map((entry) => entry.trim());
}

export function contractPlanHash(contract) {
  const copy = clone(contract);
  delete copy.plan_sha256;
  return sha256(stableJson(copy));
}

export function validateContract(contract, { allowMissingHash = false } = {}) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error("TASK_CONTRACT 必须是对象");
  if (contract.schema_version !== "web_pro_codex_task_contract.v1") throw new Error("TASK_CONTRACT schema_version 无效");
  assertSafeId(contract.task_id);
  if (typeof contract.repository !== "string" || !path.isAbsolute(contract.repository)) throw new Error("repository 必须是绝对路径");
  if (typeof contract.branch !== "string") throw new Error("branch 必须是字符串");
  const snapshot = contract.snapshot;
  if (!snapshot || typeof snapshot !== "object") throw new Error("snapshot 缺失");
  if (typeof snapshot.snapshot_id !== "string" || !/^snapshot_[0-9a-f]{32}$/.test(snapshot.snapshot_id)) throw new Error("snapshot_id 格式无效");
  for (const field of ["repository", "base_commit", "tree_hash", "status_hash"]) {
    if (typeof snapshot[field] !== "string" || snapshot[field].length === 0) throw new Error(`snapshot.${field} 无效`);
  }
  if (!/^[0-9a-f]{40}$/.test(snapshot.base_commit) || !/^[0-9a-f]{40}$/.test(snapshot.tree_hash)) throw new Error("snapshot commit/tree hash 必须是 40 位 SHA-1");
  if (!/^sha256:[0-9a-f]{64}$/.test(snapshot.status_hash) || typeof snapshot.dirty !== "boolean") throw new Error("snapshot dirty/status_hash 无效");
  if (!contract.planner || typeof contract.planner !== "object" || typeof contract.planner.surface !== "string" || typeof contract.planner.context_mode !== "string") throw new Error("planner 无效");
  validateStringList(contract.goal, "goal", true);
  validateStringList(contract.non_goals, "non_goals");
  validatePathList(contract.allowed_paths, "allowed_paths");
  validatePathList(contract.forbidden_paths, "forbidden_paths");
  validateStringList(contract.validation_commands, "validation_commands");
  validateStringList(contract.required_artifacts, "required_artifacts", true);
  validateStringList(contract.stop_conditions, "stop_conditions", true);
  validateStringList(contract.pass_gates, "pass_gates", true);
  if (contract.executor !== undefined && (!contract.executor || contract.executor.sandbox !== "workspace-write")) throw new Error("executor.sandbox 必须是 workspace-write");
  assertNoSecretText(contract);
  const expectedHash = contractPlanHash(contract);
  if (allowMissingHash && contract.plan_sha256 === undefined) return { ...contract, plan_sha256: expectedHash };
  if (contract.plan_sha256 !== expectedHash) throw new Error(`plan_sha256 不匹配，期望 ${expectedHash}`);
  return contract;
}

function taskDirectory(state, taskId) {
  return safeStatePath(state, `tasks/${assertSafeId(taskId)}`);
}

function taskFile(state, taskId, name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`非法 task artifact 名称: ${name}`);
  return safeStatePath(state, `tasks/${assertSafeId(taskId)}/${name}`);
}

function snapshotFile(state, snapshotId) {
  if (!/^snapshot_[0-9a-f]{32}$/.test(snapshotId)) throw new Error("snapshot_id 格式无效");
  return safeStatePath(state, `snapshots/${snapshotId}.json`);
}

function loadStoredSnapshot(state, snapshotId) {
  const filePath = snapshotFile(state, snapshotId);
  if (!fs.existsSync(filePath)) throw new Error(`找不到本地冻结快照: ${snapshotId}`);
  return readJson(filePath);
}

function assertSnapshotBinding(contract, localSnapshot) {
  for (const field of ["snapshot_id", "repository", "base_commit", "tree_hash", "dirty", "status_hash"]) {
    if (contract.snapshot[field] !== localSnapshot[field]) throw new Error(`snapshot 绑定不匹配: ${field}`);
  }
  let contractRepository;
  try { contractRepository = fs.realpathSync(path.resolve(contract.repository)); }
  catch { throw new Error("contract repository 不存在或无法解析"); }
  if (contractRepository !== localSnapshot.repository) throw new Error("contract repository 与 snapshot 不匹配");
}

function parseStatusPaths(statusText) {
  return statusText.split("\n").filter(Boolean).map((line) => {
    const body = line.slice(3);
    if (body.includes(" -> ")) return body.split(" -> ").at(-1);
    return body;
  });
}

function globMatches(relPath, pattern) {
  const pathParts = relPath.replaceAll("\\", "/").split("/").filter(Boolean);
  const patternParts = pattern.replaceAll("\\", "/").split("/").filter(Boolean);
  const memo = new Map();
  function match(patternIndex, pathIndex) {
    const key = `${patternIndex}:${pathIndex}`;
    if (memo.has(key)) return memo.get(key);
    let result = false;
    if (patternIndex === patternParts.length) result = pathIndex === pathParts.length;
    else if (patternParts[patternIndex] === "**") {
      result = match(patternIndex + 1, pathIndex);
      for (let next = pathIndex; !result && next < pathParts.length; next += 1) result = match(patternIndex + 1, next + 1);
    } else if (pathIndex < pathParts.length) {
      const escaped = patternParts[patternIndex].replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
      result = new RegExp(`^${escaped}$`).test(pathParts[pathIndex]) && match(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  }
  return match(0, 0);
}

function pathAllowed(relPath, contract) {
  const allowed = contract.allowed_paths.some((pattern) => globMatches(relPath, pattern));
  const forbidden = contract.forbidden_paths.some((pattern) => globMatches(relPath, pattern));
  return allowed && !forbidden;
}

async function currentBinding(contract) {
  const current = await gitSnapshot(contract.repository);
  const expectedRepository = fs.realpathSync(path.resolve(contract.repository));
  if (current.repository !== expectedRepository) throw new Error("当前仓库根目录不匹配");
  if (contract.branch && current.branch !== contract.branch) throw new Error(`branch 已变化: ${current.branch}`);
  if (current.base_commit !== contract.snapshot.base_commit) throw new Error("base_commit 已变化");
  if (current.tree_hash !== contract.snapshot.tree_hash) throw new Error("tree_hash 已变化");
  if (contract.snapshot.dirty || current.dirty) throw new Error("计划或当前工作区 dirty，拒绝执行");
  if (current.status_hash !== contract.snapshot.status_hash) throw new Error("工作区状态哈希已变化");
  return current;
}

function readStoredContract(state, taskId) {
  const filePath = taskFile(state, taskId, "TASK_CONTRACT.json");
  if (!fs.existsSync(filePath)) throw new Error(`找不到任务契约: ${taskId}`);
  return { contract: readJson(filePath), filePath };
}

export async function importPlan({ file, state = stateRoot() }) {
  const raw = readJson(path.resolve(file));
  const contract = validateContract(raw, { allowMissingHash: true });
  const localSnapshot = loadStoredSnapshot(state, contract.snapshot.snapshot_id);
  assertSnapshotBinding(contract, localSnapshot);
  const directory = taskDirectory(state, contract.task_id);
  const contractPath = taskFile(state, contract.task_id, "TASK_CONTRACT.json");
  if (fs.existsSync(contractPath)) {
    const existing = readJson(contractPath);
    if (existing.plan_sha256 !== contract.plan_sha256) throw new Error("task_id 已存在不同 plan，必须使用 successor task_id");
    return { status: "already_imported", task_id: contract.task_id, plan_sha256: contract.plan_sha256, path: contractPath };
  }
  ensureDirectory(directory);
  writeJson(contractPath, contract);
  const receipt = {
    schema_version: "plan_import_receipt.v1",
    status: "imported",
    task_id: contract.task_id,
    plan_sha256: contract.plan_sha256,
    snapshot_id: contract.snapshot.snapshot_id,
    imported_at: now(),
    source_file: path.resolve(file),
    contract_path: contractPath
  };
  writeJson(taskFile(state, contract.task_id, "PLAN_IMPORT_RECEIPT.json"), receipt);
  return receipt;
}

export async function validatePlan({ taskId, state = stateRoot(), writeReceipt = true }) {
  const { contract } = readStoredContract(state, taskId);
  const started = now();
  let status = "PASS";
  let reason = null;
  let current = null;
  try {
    validateContract(contract);
    const localSnapshot = loadStoredSnapshot(state, contract.snapshot.snapshot_id);
    assertSnapshotBinding(contract, localSnapshot);
    current = await currentBinding(contract);
  } catch (error) {
    status = "HOLD";
    reason = error.message;
  }
  const receipt = {
    schema_version: "plan_validation_receipt.v1",
    status,
    task_id: contract.task_id,
    plan_sha256: contract.plan_sha256,
    snapshot_id: contract.snapshot?.snapshot_id ?? null,
    validated_at: now(),
    started_at: started,
    reason,
    current_binding: current ? { base_commit: current.base_commit, tree_hash: current.tree_hash, dirty: current.dirty, status_hash: current.status_hash } : null
  };
  if (writeReceipt) writeJson(taskFile(state, taskId, "VALIDATION_RECEIPT.json"), receipt);
  return receipt;
}

export async function approvePlan({ taskId, state = stateRoot(), yes = false }) {
  if (!yes) throw new Error("approve 需要显式 --yes");
  const { contract } = readStoredContract(state, taskId);
  const validation = await validatePlan({ taskId, state });
  if (validation.status !== "PASS") throw new Error(`计划未通过校验: ${validation.reason}`);
  const approval = {
    schema_version: "local_approval.v1",
    status: "approved",
    task_id: contract.task_id,
    plan_sha256: contract.plan_sha256,
    snapshot_id: contract.snapshot.snapshot_id,
    approved_at: now(),
    approved_by: process.env.USER || os.userInfo().username,
    approval_boundary: "local_only; does not merge, push, or produce final acceptance verdict"
  };
  writeJson(taskFile(state, taskId, "LOCAL_APPROVAL.json"), approval);
  return approval;
}

export async function rejectPlan({ taskId, state = stateRoot(), reason = "rejected_by_local_operator" }) {
  const { contract } = readStoredContract(state, taskId);
  assertNoSecretText(reason);
  const rejection = {
    schema_version: "local_rejection.v1",
    status: "rejected",
    task_id: contract.task_id,
    plan_sha256: contract.plan_sha256,
    rejected_at: now(),
    reason
  };
  writeJson(taskFile(state, taskId, "REJECTION.json"), rejection);
  return rejection;
}

function captureProcess(command, args, { cwd, input, env = process.env, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], timeout });
    } catch (error) {
      resolve({ started: false, error: error.message, exit_code: null, stdout: "", stderr: error.message, stdout_hash: sha256(""), stderr_hash: sha256(error.message) });
      return;
    }
    const stdoutHash = crypto.createHash("sha256");
    const stderrHash = crypto.createHash("sha256");
    let stdoutBytes = 0, stderrBytes = 0;
    let capturedStdoutBytes = 0, capturedStderrBytes = 0;
    let settled = false;
    const stdoutChunks = [], stderrChunks = [];
    const capture = (chunks, currentBytes, chunk) => {
      if (currentBytes >= MAX_CAPTURE_BYTES) return currentBytes;
      const remaining = MAX_CAPTURE_BYTES - currentBytes;
      const captured = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      chunks.push(captured);
      return currentBytes + captured.length;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdoutHash.update(chunk); stdoutBytes += chunk.length;
      capturedStdoutBytes = capture(stdoutChunks, capturedStdoutBytes, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrHash.update(chunk); stderrBytes += chunk.length;
      capturedStderrBytes = capture(stderrChunks, capturedStderrBytes, chunk);
    });
    child.once("error", (error) => finish({ started: false, error: error.message, exit_code: null, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), stdout_hash: `sha256:${stdoutHash.digest("hex")}`, stderr_hash: `sha256:${stderrHash.digest("hex")}`, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes }));
    child.once("close", (code, signal) => finish({ started: true, error: null, exit_code: code, signal, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8"), stdout_hash: `sha256:${stdoutHash.digest("hex")}`, stderr_hash: `sha256:${stderrHash.digest("hex")}`, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes }));
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    else child.stdin.end();
  });
}

async function commandVersion(executable, cwd) {
  const result = await captureProcess(executable, ["--version"], { cwd });
  return result.exit_code === 0 ? result.stdout.trim().split("\n")[0] : null;
}

async function collectDiffManifest(worktree, contract) {
  const [status, diff, cached, untracked] = await Promise.all([
    git(worktree, ["status", "--short", "--untracked-files=all"]),
    git(worktree, ["diff", "--name-status"]),
    git(worktree, ["diff", "--cached", "--name-status"]),
    git(worktree, ["ls-files", "--others", "--exclude-standard"])
  ]);
  const modifiedPaths = [...new Set(parseStatusPaths(status.stdout))].sort();
  const unexpected = modifiedPaths.filter((entry) => !pathAllowed(entry, contract));
  return {
    schema_version: "diff_manifest.v1",
    repository: contract.repository,
    worktree,
    base_commit: contract.snapshot.base_commit,
    status_porcelain: status.stdout.trim().split("\n").filter(Boolean),
    unstaged: diff.stdout.trim().split("\n").filter(Boolean),
    staged: cached.stdout.trim().split("\n").filter(Boolean),
    untracked_files: untracked.stdout.trim().split("\n").filter(Boolean),
    modified_paths: modifiedPaths,
    unexpected_modified_paths: unexpected,
    path_policy: { allowed_paths: contract.allowed_paths, forbidden_paths: contract.forbidden_paths }
  };
}

async function runValidationCommands(contract, worktree, commandsPath) {
  const results = [];
  for (const command of contract.validation_commands) {
    const startedAt = now();
    const result = await captureProcess("/bin/zsh", ["-lc", command], { cwd: worktree, env: { ...process.env, CI: "1" } });
    const item = { command, started_at: startedAt, ended_at: now(), exit_code: result.exit_code, stdout_hash: result.stdout_hash, stderr_hash: result.stderr_hash, stdout_bytes: result.stdout_bytes, stderr_bytes: result.stderr_bytes };
    results.push(item);
    appendJsonl(commandsPath, { kind: "validation", ...item });
  }
  return results;
}

function executionPrompt(contract, worktree) {
  return `You are the local Codex executor for a reviewed task contract.\n\nTask ID: ${contract.task_id}\nRepository worktree: ${worktree}\nBase commit: ${contract.snapshot.base_commit}\nTree hash: ${contract.snapshot.tree_hash}\n\nGoal:\n${contract.goal.map((item) => `- ${item}`).join("\n")}\n\nNon-goals:\n${contract.non_goals.map((item) => `- ${item}`).join("\n")}\n\nAllowed paths:\n${contract.allowed_paths.map((item) => `- ${item}`).join("\n")}\n\nForbidden paths:\n${contract.forbidden_paths.map((item) => `- ${item}`).join("\n")}\n\nRules:\n- Work only in this fresh worktree.\n- Do not merge, push, deploy, access credentials, or modify forbidden paths.\n- Run the requested validation only after implementation.\n- Report unresolved issues; do not declare final acceptance.\n`;
}

function writeBlockedExecutionArtifacts({ state, taskId, contract, codexBin, startedAt, reason, worktree = null, commands = [] }) {
  const commandsPath = taskFile(state, taskId, "commands.jsonl");
  for (const command of commands) appendJsonl(commandsPath, command);
  if (commands.length === 0) appendJsonl(commandsPath, { kind: "blocked", started_at: startedAt, ended_at: now(), reason });
  writeJson(taskFile(state, taskId, "test_results.json"), {
    schema_version: "test_results.v1",
    task_id: contract.task_id,
    plan_sha256: contract.plan_sha256,
    run_validation: false,
    results: [],
    all_passed: false,
    status: "not_run"
  });
  writeJson(taskFile(state, taskId, "diff_manifest.json"), {
    schema_version: "diff_manifest.v1",
    repository: contract.repository,
    worktree,
    base_commit: contract.snapshot.base_commit,
    status_porcelain: [],
    unstaged: [],
    staged: [],
    untracked_files: [],
    modified_paths: [],
    unexpected_modified_paths: [],
    path_policy: { allowed_paths: contract.allowed_paths, forbidden_paths: contract.forbidden_paths },
    status: "not_collected"
  });
  const receipt = {
    schema_version: "execution_receipt.v1",
    task_id: contract.task_id,
    plan_sha256: contract.plan_sha256,
    snapshot: contract.snapshot,
    status: "blocked",
    executor: { kind: "codex-cli", executable: codexBin, version: null, exit_code: null, stdout_hash: null, stderr_hash: null, last_message_hash: null },
    worktree: { path: worktree, base_commit: contract.snapshot.base_commit, created: false },
    started_at: startedAt,
    ended_at: now(),
    modified_paths: [],
    unexpected_modified_paths: [],
    commands_log: "commands.jsonl",
    test_results: "test_results.json",
    diff_manifest: "diff_manifest.json",
    unresolved_items: [reason],
    claims: ["no Codex execution occurred", "final acceptance verdict is intentionally absent"],
    acceptance_verdict: "not_produced_by_executor"
  };
  writeJson(taskFile(state, taskId, "EXECUTION_RECEIPT.json"), receipt);
  return receipt;
}

export async function executePlan({ taskId, state = stateRoot(), yes = false, runValidation = false, codexBin = process.env.SANDBOX_CODEX_BIN || "codex", model = null }) {
  if (!yes) throw new Error("execute 需要显式 --yes");
  const { contract } = readStoredContract(state, taskId);
  const rejectionPath = taskFile(state, taskId, "REJECTION.json");
  if (fs.existsSync(rejectionPath)) throw new Error("任务已被 reject，不能执行");
  const approvalPath = taskFile(state, taskId, "LOCAL_APPROVAL.json");
  if (!fs.existsSync(approvalPath)) throw new Error("缺少 LOCAL_APPROVAL.json，先执行 approve --yes");
  const approval = readJson(approvalPath);
  if (approval.plan_sha256 !== contract.plan_sha256) throw new Error("approval 与当前 plan_sha256 不匹配");
  const validation = await validatePlan({ taskId, state });
  const startedAt = now();
  if (validation.status !== "PASS") {
    return writeBlockedExecutionArtifacts({ state, taskId, contract, codexBin, startedAt, reason: `validation_${validation.status}: ${validation.reason}` });
  }
  const taskDir = taskDirectory(state, taskId);
  const worktree = path.join(taskDir, "worktree");
  if (fs.existsSync(worktree)) throw new Error(`fresh worktree 已存在，拒绝复用: ${worktree}`);
  const commandsPath = taskFile(state, taskId, "commands.jsonl");
  const promptPath = taskFile(state, taskId, "EXECUTION_PROMPT.md");
  const lastMessagePath = taskFile(state, taskId, "CODEX_LAST_MESSAGE.md");
  writeJson(taskFile(state, taskId, "EXECUTION_START.json"), { schema_version: "execution_start.v1", task_id: contract.task_id, plan_sha256: contract.plan_sha256, started_at: startedAt, worktree, base_commit: contract.snapshot.base_commit });
  fs.writeFileSync(promptPath, executionPrompt(contract, worktree), { encoding: "utf8", mode: 0o600, flag: "wx" });
  const worktreeResult = await captureProcess("git", ["worktree", "add", "--detach", worktree, contract.snapshot.base_commit], { cwd: fs.realpathSync(contract.repository) });
  appendJsonl(commandsPath, { kind: "git_worktree_add", command: "git worktree add --detach <worktree> <base_commit>", started_at: startedAt, ended_at: now(), exit_code: worktreeResult.exit_code, stdout_hash: worktreeResult.stdout_hash, stderr_hash: worktreeResult.stderr_hash });
  if (worktreeResult.exit_code !== 0) {
    return writeBlockedExecutionArtifacts({ state, taskId, contract, codexBin, startedAt, worktree, reason: `fresh worktree 创建失败: ${worktreeResult.stderr || worktreeResult.error}` });
  }
  const effectiveModel = model || contract.executor?.model || null;
  const codexArgs = ["exec", "--cd", worktree, "--sandbox", "workspace-write", "--ephemeral", "--color", "never", "--output-last-message", lastMessagePath];
  if (effectiveModel) codexArgs.push("--model", effectiveModel);
  codexArgs.push("-");
  const codexStarted = now();
  const codexVersion = await commandVersion(codexBin, worktree);
  const codexResult = await captureProcess(codexBin, codexArgs, { cwd: worktree, input: executionPrompt(contract, worktree), env: { ...process.env, SANDBOX_HANDOFF_TASK_ID: contract.task_id, SANDBOX_HANDOFF_CONTRACT: taskFile(state, taskId, "TASK_CONTRACT.json") } });
  appendJsonl(commandsPath, { kind: "codex_exec", executable: codexBin, argv: codexArgs, started_at: codexStarted, ended_at: now(), exit_code: codexResult.exit_code, stdout_hash: codexResult.stdout_hash, stderr_hash: codexResult.stderr_hash, stdout_bytes: codexResult.stdout_bytes, stderr_bytes: codexResult.stderr_bytes });
  const tests = runValidation ? await runValidationCommands(contract, worktree, commandsPath) : contract.validation_commands.map((command) => ({ command, status: "not_run" }));
  const testResults = { schema_version: "test_results.v1", task_id: contract.task_id, plan_sha256: contract.plan_sha256, run_validation: runValidation, results: tests, all_passed: runValidation && tests.length > 0 && tests.every((item) => item.exit_code === 0) };
  writeJson(taskFile(state, taskId, "test_results.json"), testResults);
  const diffManifest = await collectDiffManifest(worktree, contract);
  writeJson(taskFile(state, taskId, "diff_manifest.json"), diffManifest);
  const lastMessage = fs.existsSync(lastMessagePath) ? fs.readFileSync(lastMessagePath, "utf8") : "";
  const unresolved = [];
  if (codexResult.exit_code !== 0) unresolved.push(`codex_exit_${codexResult.exit_code ?? "unknown"}`);
  if (codexResult.error) unresolved.push(`codex_error: ${codexResult.error}`);
  if (diffManifest.unexpected_modified_paths.length > 0) unresolved.push(`unexpected_modified_paths: ${diffManifest.unexpected_modified_paths.join(", ")}`);
  if (runValidation && !testResults.all_passed) unresolved.push("validation_failed");
  const receipt = {
    schema_version: "execution_receipt.v1", task_id: contract.task_id, plan_sha256: contract.plan_sha256, snapshot: contract.snapshot,
    status: unresolved.length === 0 ? "completed" : "failed", executor: { kind: "codex-cli", executable: codexBin, version: codexVersion, exit_code: codexResult.exit_code, stdout_hash: codexResult.stdout_hash, stderr_hash: codexResult.stderr_hash, last_message_hash: sha256(lastMessage) },
    worktree: { path: worktree, base_commit: contract.snapshot.base_commit, created: true }, started_at: startedAt, ended_at: now(), modified_paths: diffManifest.modified_paths, unexpected_modified_paths: diffManifest.unexpected_modified_paths,
    commands_log: "commands.jsonl", test_results: "test_results.json", diff_manifest: "diff_manifest.json", unresolved_items: unresolved,
    claims: ["Codex executor result only", "no merge performed", "no push performed", "final acceptance verdict is intentionally absent"], acceptance_verdict: "not_produced_by_executor"
  };
  writeJson(taskFile(state, taskId, "EXECUTION_RECEIPT.json"), receipt);
  return receipt;
}

export function handoffStatus({ state = stateRoot() } = {}) {
  const tasksRoot = safeStatePath(state, "tasks");
  if (!fs.existsSync(tasksRoot)) return { schema_version: "handoff_status.v1", tasks: [] };
  assertNotSymlink(tasksRoot, tasksRoot);
  const tasks = fs.readdirSync(tasksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(entry.name)).map((entry) => {
    const taskId = entry.name;
    const contractPath = taskFile(state, taskId, "TASK_CONTRACT.json");
    const receiptPath = taskFile(state, taskId, "EXECUTION_RECEIPT.json");
    const importPath = taskFile(state, taskId, "PLAN_IMPORT_RECEIPT.json");
    const validationPath = taskFile(state, taskId, "VALIDATION_RECEIPT.json");
    const approvalPath = taskFile(state, taskId, "LOCAL_APPROVAL.json");
    const rejectionPath = taskFile(state, taskId, "REJECTION.json");
    const contract = fs.existsSync(contractPath) ? readJson(contractPath) : null;
    const receipt = fs.existsSync(receiptPath) ? readJson(receiptPath) : null;
    const imported = fs.existsSync(importPath) ? readJson(importPath) : null;
    const validation = fs.existsSync(validationPath) ? readJson(validationPath) : null;
    return { task_id: taskId, plan_sha256: contract?.plan_sha256 ?? null, snapshot_id: contract?.snapshot?.snapshot_id ?? null, repository: contract?.repository ?? null, status: rejectionPath && fs.existsSync(rejectionPath) ? "rejected" : receipt?.status ?? (approvalPath && fs.existsSync(approvalPath) ? "approved" : validation?.status ?? "imported"), execution_status: receipt?.status ?? null, validation_status: validation?.status ?? null, updated_at: receipt?.ended_at ?? validation?.validated_at ?? imported?.imported_at ?? null };
  });
  return { schema_version: "handoff_status.v1", tasks };
}

export function readHandoffArtifact({ state = stateRoot(), taskId, artifact = "receipt" } = {}) {
  assertSafeId(taskId);
  const names = { contract: "TASK_CONTRACT.json", receipt: "EXECUTION_RECEIPT.json", commands: "commands.jsonl", tests: "test_results.json", diff: "diff_manifest.json", import: "PLAN_IMPORT_RECEIPT.json", validation: "VALIDATION_RECEIPT.json" };
  const fileName = names[artifact];
  if (!fileName) throw new Error(`未知 handoff artifact: ${artifact}`);
  const filePath = taskFile(state, taskId, fileName);
  if (!fs.existsSync(filePath)) throw new Error(`找不到 handoff artifact: ${taskId}/${fileName}`);
  if (fileName.endsWith(".jsonl")) return { task_id: taskId, artifact, entries: fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).slice(-200).map((line) => JSON.parse(line)) };
  return { task_id: taskId, artifact, data: readJson(filePath) };
}

export function readTaskSchema(schemaName = "TASK_CONTRACT.schema.json") {
  const allowed = { "TASK_CONTRACT.schema.json": TASK_SCHEMA_PATH, "EXECUTION_RECEIPT.schema.json": RECEIPT_SCHEMA_PATH };
  if (!allowed[schemaName]) throw new Error("未知 schema");
  return readJson(allowed[schemaName]);
}
