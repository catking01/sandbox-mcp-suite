import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultPermissionsConfig } from "../console/permissions.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer(configPath, receiptPath, permissionsPath, handoffStateRoot = path.join(path.dirname(configPath || receiptPath), "handoff-state"), extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "local-evidence-mcp.mjs"), ...(configPath ? [configPath] : [])], {
    cwd: repoRoot,
    env: { ...process.env, LOCAL_EVIDENCE_RECEIPT_PATH: receiptPath, LOCAL_EVIDENCE_PERMISSIONS_CONFIG: permissionsPath, SANDBOX_HANDOFF_STATE_ROOT: handoffStateRoot, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  let stderrBuffer = "";
  const protocolEvents = [];
  child.stderr.on("data", chunk => {
    const text = chunk.toString();
    stderr += text;
    stderrBuffer += text;
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() || "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.schema_version === "local_evidence_protocol_event.v1") protocolEvents.push(event);
      } catch {
        // Preserve non-JSON stderr for process-exit diagnostics.
      }
    }
  });
  lines.on("line", line => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter.resolve(message); }
  });
  child.once("exit", code => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited ${code}: ${stderr}`));
    pending.clear();
  });
  let nextId = 1;
  return {
    child,
    protocolEvents,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    }
  };
}

function toolValue(response) {
  assert.equal(response.error, undefined, response.error?.message);
  return JSON.parse(response.result.content[0].text);
}

function toolErrorValue(response) {
  assert.equal(response.error, undefined, response.error?.message);
  assert.equal(response.result.isError, true);
  return JSON.parse(response.result.content[0].text);
}

function waitForExit(child, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`process ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function createManagedServerFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const project = path.join(root, "project");
  const configPath = path.join(root, "projects.json");
  const permissionsPath = path.join(root, "permissions.json");
  const receiptPath = path.join(root, "receipts.jsonl");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "visible text\n");
  fs.writeFileSync(permissionsPath, `${JSON.stringify(defaultPermissionsConfig(), null, 2)}\n`);
  fs.writeFileSync(configPath, `${JSON.stringify({
    schema_version: "local_evidence_projects.v1",
    projects: { fixture: { root: project, mode: "read_only", enabled: true, allowed_globs: ["README.md"], denied_globs: [".env"] } }
  }, null, 2)}\n`);
  return { root, configPath, permissionsPath, receiptPath };
}

test("managed MCP requests a full parent restart when its protocol output pipe closes", async () => {
  const { root, configPath, permissionsPath, receiptPath } = createManagedServerFixture("sandbox-mcp-epipe-");
  const serverPath = path.join(repoRoot, "scripts", "local-evidence-mcp.mjs");
  const wrapperSource = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, [${JSON.stringify(serverPath)}, ${JSON.stringify(configPath)}], {
      cwd: ${JSON.stringify(repoRoot)},
      env: {
        ...process.env,
        LOCAL_EVIDENCE_RECEIPT_PATH: ${JSON.stringify(receiptPath)},
        LOCAL_EVIDENCE_PERMISSIONS_CONFIG: ${JSON.stringify(permissionsPath)},
        SANDBOX_HANDOFF_STATE_ROOT: ${JSON.stringify(path.join(root, "handoff-state"))},
        SANDBOX_MCP_TUNNEL_MANAGED: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stderr.pipe(process.stderr);
    child.once("spawn", () => {
      child.stdout.destroy();
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\\n");
    });
    setTimeout(() => process.exit(99), 3000);
  `;
  const wrapper = spawn(process.execPath, ["-e", wrapperSource], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  wrapper.stderr.on("data", chunk => { stderr += chunk.toString(); });
  try {
    const exited = await waitForExit(wrapper);
    assert.equal(exited.code, null);
    assert.equal(exited.signal, "SIGTERM");
    assert.match(stderr, /local_evidence_protocol_output_failure\.v1/);
    assert.match(stderr, /"code":"EPIPE"/);
    assert.match(stderr, /"parent_restart_requested":true/);
    assert.doesNotMatch(stderr, /Unhandled 'error' event/);
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed MCP requests a full parent restart when its protocol input closes", async () => {
  const { root, configPath, permissionsPath, receiptPath } = createManagedServerFixture("sandbox-mcp-input-close-");
  const serverPath = path.join(repoRoot, "scripts", "local-evidence-mcp.mjs");
  const wrapperSource = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, [${JSON.stringify(serverPath)}, ${JSON.stringify(configPath)}], {
      cwd: ${JSON.stringify(repoRoot)},
      env: {
        ...process.env,
        LOCAL_EVIDENCE_RECEIPT_PATH: ${JSON.stringify(receiptPath)},
        LOCAL_EVIDENCE_PERMISSIONS_CONFIG: ${JSON.stringify(permissionsPath)},
        SANDBOX_HANDOFF_STATE_ROOT: ${JSON.stringify(path.join(root, "handoff-state"))},
        SANDBOX_MCP_TUNNEL_MANAGED: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stderr.pipe(process.stderr);
    child.once("spawn", () => child.stdin.end());
    setTimeout(() => process.exit(99), 3000);
  `;
  const wrapper = spawn(process.execPath, ["-e", wrapperSource], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  wrapper.stderr.on("data", chunk => { stderr += chunk.toString(); });
  try {
    const exited = await waitForExit(wrapper);
    assert.equal(exited.code, null);
    assert.equal(exited.signal, "SIGTERM");
    assert.match(stderr, /local_evidence_protocol_input_close\.v1/);
    assert.match(stderr, /"parent_restart_requested":true/);
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("read-only MCP exposes only read tools and enforces the file denylist", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-mcp-readonly-"));
  const project = path.join(root, "project");
  const configPath = path.join(root, "projects.json");
  const permissionsPath = path.join(root, "permissions.json");
  const receiptPath = path.join(root, "receipts", "calls.jsonl");
  const outsideFile = path.join(root, "outside.txt");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "visible text\n");
  fs.writeFileSync(path.join(project, "CURRENT_STATE.md"), "verdict: LOCAL_ONLY\n");
  fs.writeFileSync(path.join(project, ".env"), "SECRET=must-not-leak\n");
  fs.writeFileSync(path.join(project, "not-allowlisted.md"), "allowlist bypass\n");
  fs.writeFileSync(path.join(project, "too-big.md"), Buffer.alloc(1_048_577, "x"));
  fs.writeFileSync(outsideFile, "symlink escape content\n");
  fs.symlinkSync(outsideFile, path.join(project, "escape-link.md"));
  fs.writeFileSync(permissionsPath, `${JSON.stringify(defaultPermissionsConfig(), null, 2)}\n`);
  fs.writeFileSync(configPath, `${JSON.stringify({
    schema_version: "local_evidence_projects.v1",
    projects: { fixture: { root: project, description: "fixture progress", project_line: "research_development", mode: "read_only", enabled: true, allowed_globs: ["README.md", "CURRENT_STATE.md", "escape-link.md", "too-big.md"], denied_globs: [".env"], progress_files: [
      { path: "CURRENT_STATE.md", role: "current_state" },
      { path: ".env", role: "denied_state" },
      { path: "not-allowlisted.md", role: "allowlist_rejected" },
      { path: "../outside.txt", role: "parent_escape_rejected" },
      { path: outsideFile, role: "absolute_path_rejected" },
      { path: "escape-link.md", role: "symlink_escape_rejected" },
      { path: "too-big.md", role: "oversize_rejected" }
    ] } }
  }, null, 2)}\n`);
  const server = startServer(configPath, receiptPath, permissionsPath);
  try {
    const initialized = await server.request("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "local-evidence-test", version: "1.0.0" } });
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result.serverInfo.version, "0.2.3");
    assert.match(initialized.result.instructions, /Start with project\.list_projects/);
    assert.match(initialized.result.instructions, /local evidence only/);

    const listed = await server.request("tools/list");
    assert.equal(listed.error, undefined);
    const names = listed.result.tools.map(tool => tool.name);
    assert.equal(names.length, 19);
    assert.equal(names.filter(name => name.startsWith("project.")).length, 14);
    assert.equal(names.filter(name => name.startsWith("handoff.")).length, 5);
    assert.equal(names.every(name => name.startsWith("project.") || name.startsWith("handoff.")), true);
    assert.equal(names.some(name => name.includes("write") || name.includes("delegated")), false);
    assert.equal(listed.result.tools.every(tool => tool.annotations?.readOnlyHint === true), true);

    for (const name of ["project.write_text_file", "project.create_delegated_execution_request"]) {
      const rejected = await server.request("tools/call", { name, arguments: { project_id: "fixture", path: "README.md", text: "forbidden write", expected_previous_hash: null } });
      assert.match(rejected.error?.message ?? "", /禁用/);
    }
    assert.equal(fs.readFileSync(path.join(project, "README.md"), "utf8"), "visible text\n");

    const projects = toolValue(await server.request("tools/call", { name: "project.list_projects", arguments: {} }));
    assert.deepEqual(projects.projects.map(item => item.project_id), ["fixture"]);
    assert.equal(projects.projects[0].description, "fixture progress");
    assert.equal(projects.projects[0].project_line, "research_development");
    assert.equal(projects.projects[0].progress_file_count, 7);

    const handoff = toolValue(await server.request("tools/call", { name: "handoff.get_status", arguments: {} }));
    assert.deepEqual(handoff.tasks, []);

    const progress = toolValue(await server.request("tools/call", { name: "project.get_project_progress", arguments: { project_id: "fixture" } }));
    assert.equal(progress.documents[0].status, "available");
    assert.equal(progress.project_line, "research_development");
    assert.equal(progress.documents[0].text, "verdict: LOCAL_ONLY\n");
    assert.deepEqual(progress.documents.slice(1).map(document => document.status), Array(6).fill("unavailable"));
    assert.match(progress.documents[1].reason, /denied/i);
    assert.match(progress.documents[2].reason, /allowlist/i);
    assert.match(progress.documents[3].reason, /escapes project root/i);
    assert.match(progress.documents[4].reason, /absolute paths/i);
    assert.match(progress.documents[5].reason, /escapes project root/i);
    assert.match(progress.documents[6].reason, /max_text_bytes/i);
    const serializedProgress = JSON.stringify(progress);
    assert.equal(serializedProgress.includes("SECRET=must-not-leak"), false);
    assert.equal(serializedProgress.includes("allowlist bypass"), false);
    assert.equal(serializedProgress.includes("symlink escape content"), false);
    assert.equal(serializedProgress.includes("x".repeat(100)), false);

    const read = toolValue(await server.request("tools/call", { name: "project.read_text_file", arguments: { project_id: "fixture", path: "README.md" } }));
    assert.equal(read.text, "visible text\n");

    const fileSearch = toolValue(await server.request("tools/call", { name: "project.search_text", arguments: { project_id: "fixture", path: "README.md", query: "visible text" } }));
    assert.equal(fileSearch.matches.length, 1);
    assert.equal(fileSearch.matches[0].path, "README.md");
    assert.equal(fileSearch.matches[0].line_number, 1);

    const directorySearch = toolValue(await server.request("tools/call", { name: "project.search_text", arguments: { project_id: "fixture", path: ".", query: "visible text" } }));
    assert.equal(directorySearch.matches.some(match => match.path === "README.md"), true);

    const denied = await server.request("tools/call", { name: "project.read_text_file", arguments: { project_id: "fixture", path: ".env" } });
    assert.match(toolErrorValue(denied).error, /denied/i);
    const readAfterDenied = toolValue(await server.request("tools/call", { name: "project.read_text_file", arguments: { project_id: "fixture", path: "README.md" } }));
    assert.equal(readAfterDenied.text, "visible text\n");
    const receiptText = fs.readFileSync(receiptPath, "utf8");
    assert.equal(receiptText.includes("SECRET=must-not-leak"), false);
    const receipts = receiptText.trim().split("\n").map(line => JSON.parse(line));
    const deniedReceipt = receipts.findLast(receipt => receipt.decision === "reject" && receipt.path_original === ".env");
    assert.ok(deniedReceipt);
    assert.match(deniedReceipt.reason, /denied/i);
    assert.equal(deniedReceipt.content_returned, false);
    assert.equal(deniedReceipt.rpc_method, "tools/call");
    assert.equal(Number.isInteger(deniedReceipt.rpc_request_id), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(server.protocolEvents.some(event => event.method === "initialize"), true);
    assert.equal(server.protocolEvents.some(event => event.method === "tools/list"), true);
    assert.equal(server.protocolEvents.some(event => event.method === "tools/call"), true);
  } finally {
    server.child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP permission policy removes disabled tools and rejects direct calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-mcp-permission-"));
  const project = path.join(root, "project");
  const configPath = path.join(root, "projects.json");
  const permissionsPath = path.join(root, "permissions.json");
  const receiptPath = path.join(root, "receipts", "calls.jsonl");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "visible text\n");
  fs.writeFileSync(configPath, `${JSON.stringify({ schema_version: "local_evidence_projects.v1", projects: { fixture: { root: project, mode: "read_only", enabled: true, allowed_globs: ["**"], denied_globs: [".env"] } } }, null, 2)}\n`);
  const permissions = defaultPermissionsConfig();
  permissions.profiles.readonly.tools["project.search_text"] = false;
  fs.writeFileSync(permissionsPath, `${JSON.stringify(permissions, null, 2)}\n`);
  const server = startServer(configPath, receiptPath, permissionsPath);
  try {
    const listed = await server.request("tools/list");
    const names = listed.result.tools.map(tool => tool.name);
    assert.equal(names.includes("project.search_text"), false);
    const disabled = await server.request("tools/call", { name: "project.search_text", arguments: { project_id: "fixture", query: "visible" } });
    assert.match(disabled.error.message, /权限策略禁用/);
  } finally {
    server.child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP bounds oversized responses and isolates missing project roots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-mcp-response-"));
  const project = path.join(root, "project");
  const configPath = path.join(root, "projects.json");
  const permissionsPath = path.join(root, "permissions.json");
  const receiptPath = path.join(root, "receipts", "calls.jsonl");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "x".repeat(65536));
  fs.writeFileSync(permissionsPath, `${JSON.stringify(defaultPermissionsConfig(), null, 2)}\n`);
  fs.writeFileSync(configPath, `${JSON.stringify({
    schema_version: "local_evidence_projects.v1",
    projects: {
      fixture: { root: project, mode: "read_only", enabled: true, allowed_globs: ["**"], denied_globs: [] },
      missing: { root: path.join(root, "does-not-exist"), mode: "read_only", enabled: true, allowed_globs: ["**"], denied_globs: [] }
    }
  }, null, 2)}\n`);
  const server = startServer(configPath, receiptPath, permissionsPath, undefined, { LOCAL_EVIDENCE_MAX_MCP_RESPONSE_BYTES: "32768" });
  try {
    const projects = toolValue(await server.request("tools/call", { name: "project.list_projects", arguments: {} }));
    assert.deepEqual(projects.projects.map(item => item.project_id), ["fixture"]);
    assert.equal(projects.startup_issues.length, 1);
    assert.equal(projects.startup_issues[0].project_id, "missing");
    assert.equal(projects.startup_issues[0].code, "ENOENT");

    const oversized = await server.request("tools/call", { name: "project.read_text_file", arguments: { project_id: "fixture", path: "README.md" } });
    const oversizedError = toolErrorValue(oversized);
    assert.match(oversizedError.error, /response-size limit/);
    assert.equal(oversizedError.error_data.max_response_bytes, 32768);
    assert.ok(oversizedError.error_data.response_bytes > oversizedError.error_data.max_response_bytes);

    const ping = await server.request("ping");
    assert.deepEqual(ping.result, {});
  } finally {
    server.child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP reads large text and binary files through bounded chunks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-mcp-chunks-"));
  const project = path.join(root, "project");
  const configPath = path.join(root, "projects.json");
  const permissionsPath = path.join(root, "permissions.json");
  const receiptPath = path.join(root, "receipts", "calls.jsonl");
  const text = "0123456789abcdef".repeat(400000);
  const binary = Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 256));
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "large.txt"), text);
  fs.writeFileSync(path.join(project, "large.bin"), binary);
  fs.writeFileSync(permissionsPath, `${JSON.stringify(defaultPermissionsConfig(), null, 2)}\n`);
  fs.writeFileSync(configPath, `${JSON.stringify({
    schema_version: "local_evidence_projects.v1",
    projects: { fixture: { root: project, mode: "read_only", enabled: true, allowed_globs: ["**"], denied_globs: [] } }
  }, null, 2)}\n`);
  const server = startServer(configPath, receiptPath, permissionsPath);
  try {
    const firstText = toolValue(await server.request("tools/call", { name: "project.read_text_file", arguments: { project_id: "fixture", path: "large.txt", offset_bytes: 0, max_bytes: 32768 } }));
    assert.equal(firstText.chunked, true);
    assert.equal(firstText.byte_offset, 0);
    assert.equal(firstText.byte_length, 32768);
    assert.equal(firstText.total_byte_length, Buffer.byteLength(text));
    assert.equal(firstText.eof, false);

    const secondText = toolValue(await server.request("tools/call", { name: "project.read_text_file", arguments: { project_id: "fixture", path: "large.txt", offset_bytes: 32768, max_bytes: 32768 } }));
    assert.equal(secondText.byte_offset, 32768);
    assert.equal(firstText.text + secondText.text, text.slice(0, 4096 * 16));

    const binaryChunk = toolValue(await server.request("tools/call", { name: "project.read_file_base64", arguments: { project_id: "fixture", path: "large.bin", offset_bytes: 1024, max_bytes: 4096 } }));
    assert.equal(binaryChunk.chunked, true);
    assert.deepEqual(Buffer.from(binaryChunk.base64, "base64"), binary.subarray(1024, 5120));

    const tooWide = await server.request("tools/call", { name: "project.read_text_file", arguments: { project_id: "fixture", path: "large.txt", max_bytes: 5 * 1024 * 1024 } });
    assert.match(toolErrorValue(tooWide).error, /max_mcp_chunk_bytes/);
    assert.deepEqual((await server.request("ping")).result, {});
  } finally {
    server.child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh product configuration admits no projects and keeps state outside the installation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-mcp-fresh-"));
  const productHome = path.join(root, "product home");
  const configDir = path.join(productHome, "config");
  fs.mkdirSync(configDir, { recursive: true });
  for (const name of ["local-evidence-projects.json", "local-evidence-permissions.json", "local-evidence-denylist.json", "local-evidence-file-policy.json"]) {
    fs.copyFileSync(path.join(repoRoot, "config", name), path.join(configDir, name));
  }
  const receiptPath = path.join(productHome, "logs", "readonly", "tool-receipts.jsonl");
  const server = startServer(undefined, receiptPath, path.join(configDir, "local-evidence-permissions.json"), path.join(productHome, "state", "handoff"), { SANDBOX_MCP_HOME: productHome });
  try {
    const projects = toolValue(await server.request("tools/call", { name: "project.list_projects", arguments: {} }));
    assert.deepEqual(projects.projects, []);
    const denied = await server.request("tools/call", { name: "project.read_text_file", arguments: { project_id: "unadmitted", path: "README.md" } });
    assert.equal(denied.result.isError, true);
    assert.ok(fs.existsSync(receiptPath));
    const check = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "local-evidence-mcp.mjs"), "--self-test"], {
      env: { ...process.env, SANDBOX_MCP_HOME: productHome }, encoding: "utf8", timeout: 5000
    });
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(JSON.parse(check.stdout), { ok: true, mode: "read_only", projects: 0, tools: 19 });
  } finally {
    const closed = waitForExit(server.child); server.child.stdin.end(); await closed;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readonly rejects writable project modes and writable permission keys before serving", () => {
  const f = createManagedServerFixture("sandbox-mcp-strict-readonly-");
  try {
    const original = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
    const env = { ...process.env, LOCAL_EVIDENCE_PERMISSIONS_CONFIG: f.permissionsPath, LOCAL_EVIDENCE_RECEIPT_PATH: f.receiptPath };
    const check = () => spawnSync(process.execPath, [path.join(repoRoot, "scripts", "local-evidence-mcp.mjs"), f.configPath, "--self-test"], { env, encoding: "utf8", timeout: 5000 });
    for (const enabled of [true, false]) {
      const config = structuredClone(original);
      config.projects.fixture.mode = "restricted_write";
      config.projects.fixture.enabled = enabled;
      config.projects.fixture.write_allowed_globs = ["**"];
      fs.writeFileSync(f.configPath, JSON.stringify(config));
      const output = check();
      assert.equal(output.status, 1);
      assert.match(output.stderr, /rejects non-read_only/);
      assert.doesNotMatch(output.stdout, /"ok":true/);
    }
    fs.writeFileSync(f.configPath, JSON.stringify(original));
    const permissions = defaultPermissionsConfig();
    permissions.profiles.readonly.tools["project.write_text_file"] = true;
    fs.writeFileSync(f.permissionsPath, JSON.stringify(permissions));
    const output = check();
    assert.equal(output.status, 1);
    assert.match(output.stderr, /未知 MCP 工具权限/);
    assert.equal(fs.readFileSync(path.join(f.root, "project", "README.md"), "utf8"), "visible text\n");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("self-test fails when an admitted project cannot be loaded", () => {
  const f = createManagedServerFixture("sandbox-mcp-selftest-");
  try {
    const config = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
    config.projects.fixture.root = path.join(f.root, "absent");
    fs.writeFileSync(f.configPath, JSON.stringify(config));
    const check = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "local-evidence-mcp.mjs"), f.configPath, "--self-test"], {
      env: { ...process.env, LOCAL_EVIDENCE_PERMISSIONS_CONFIG: f.permissionsPath }, encoding: "utf8", timeout: 5000
    });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /Project validation failed/);
    assert.doesNotMatch(check.stdout, /"ok":true/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
