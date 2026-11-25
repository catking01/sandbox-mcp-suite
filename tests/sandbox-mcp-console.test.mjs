import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { once } from "node:events";
import { ConfigStore, LaunchAgentManager, PermissionStore, atomicWriteJson, discoverCodingConfig, READONLY_LABEL, CODING_LABEL, validateProjectRoot } from "../console/core.mjs";
import { ALL_TOOL_NAMES, defaultPermissionsConfig } from "../console/permissions.mjs";
import { createConsoleServer } from "../console/server.mjs";

function servicePlist(label) { return `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>fixture-node</string></array></dict></plist>\n`; }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-mcp-console-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const configDir = path.join(home, ".sandbox-mcp", "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
  fs.mkdirSync(projectA); fs.mkdirSync(projectB);
  fs.writeFileSync(path.join(configDir, "local-evidence-projects.json"), `${JSON.stringify({ schema_version: "local_evidence_projects.v1", projects: { a: { root: projectA, mode: "read_only", enabled: true, allowed_globs: ["**"], denied_globs: [".env"] } } }, null, 2)}\n`);
  fs.writeFileSync(path.join(configDir, "local-evidence-permissions.json"), `${JSON.stringify(defaultPermissionsConfig(), null, 2)}\n`);
  fs.writeFileSync(path.join(configDir, "desktop-commander.json"), `${JSON.stringify({ schema_version: "sandbox_devspace_tool_modes.v1", tool_mode: "all", allowed_roots: [projectA] }, null, 2)}\n`);
  const services = {};
  for (const [profile, label] of [["readonly", READONLY_LABEL], ["coding", CODING_LABEL]]) {
    const plist = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
    fs.writeFileSync(plist, servicePlist(label), { mode: 0o600 });
    services[profile] = { label, plist };
  }
  fs.writeFileSync(path.join(configDir, "services.json"), JSON.stringify({ services }), { mode: 0o600 });
  return { root, repo, home, configDir, projectA, projectB };
}

test("config store safely adds and removes separate read-only and coding roots", () => {
  const f = fixture();
  try {
    const store = new ConfigStore({ repoRoot: f.repo, home: f.home, env: {} });
    const readAdded = store.add("readonly", f.projectB, "beta");
    assert.equal(readAdded.id, "beta");
    const readonly = JSON.parse(fs.readFileSync(store.readonlyPath, "utf8"));
    assert.equal(readonly.projects.beta.mode, "read_only");
    assert.deepEqual(readonly.projects.beta.allowed_globs, ["**"]);
    assert.ok(readonly.projects.beta.denied_globs.includes("**/.git/**"));
    store.remove("readonly", "beta");
    assert.equal(store.list("readonly").length, 1);

    store.add("coding", f.projectB);
    const canonicalA = fs.realpathSync(f.projectA), canonicalB = fs.realpathSync(f.projectB);
    assert.deepEqual(store.list("coding").map(item => fs.realpathSync(item.root)), [canonicalA, canonicalB]);
    store.remove("coding", canonicalB);
    assert.throws(() => store.remove("coding", f.projectA), /最后一个/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("permission store updates read tools atomically and keeps write tools fail-closed", () => {
  const f = fixture();
  try {
    const permissions = new PermissionStore({ repoRoot: f.repo, home: f.home, env: {} });
    const initial = permissions.snapshot();
    assert.equal(initial.effective_count, 19);
    assert.equal(initial.tools.some(tool => tool.name === "project.write_text_file"), false);
    const updated = permissions.setTool("readonly", "project.search_text", false);
    assert.equal(updated.tools.find(tool => tool.name === "project.search_text").effective, false);
    assert.equal(JSON.parse(fs.readFileSync(permissions.permissionsPath, "utf8")).profiles.readonly.tools["project.search_text"], false);
    assert.throws(() => permissions.setTool("readonly", "project.write_text_file", true), /未知 MCP 工具/);
    assert.equal(ALL_TOOL_NAMES.length, 19);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("project admission rejects broad roots and symlink roots", () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.home, "Desktop"), { recursive: true });
    assert.throws(() => validateProjectRoot(f.home, { home: f.home }), /不能开放/);
    assert.throws(() => validateProjectRoot(path.join(f.home, "Desktop"), { home: f.home }), /不能开放/);
    const credentials = path.join(f.home, ".ssh", "nested");
    fs.mkdirSync(credentials, { recursive: true });
    assert.throws(() => validateProjectRoot(credentials, { home: f.home }), /敏感目录/);
    assert.throws(() => validateProjectRoot(path.dirname(f.configDir), { home: f.home, env: {} }), /敏感目录/);
    const link = path.join(f.root, "linked-project");
    fs.symlinkSync(f.projectA, link);
    assert.throws(() => validateProjectRoot(link, { home: f.home }), /符号链接/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("coding configuration uses the selected product home and honors explicit overrides", () => {
  const f = fixture();
  try {
    assert.equal(discoverCodingConfig({ home: f.home, repoRoot: f.repo, env: {} }), path.join(f.configDir, "desktop-commander.json"));
    const alternate = path.join(f.root, "alternate-home");
    assert.equal(discoverCodingConfig({ home: f.home, env: { SANDBOX_MCP_HOME: alternate } }), path.join(alternate, "config", "desktop-commander.json"));
    const override = path.join(f.root, "custom-coding.json");
    assert.equal(discoverCodingConfig({ home: f.home, env: { SANDBOX_MCP_CODING_CONFIG: override } }), override);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("unregistered services are not probed, installed, started or given credentials", async () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.configDir, "services.json"));
    const calls = [];
    const manager = new LaunchAgentManager({ platform: "darwin", home: f.home, env: {}, execute: async (...args) => { calls.push(args); } });
    assert.equal((await manager.status("readonly")).installed, false);
    await assert.rejects(() => manager.start("readonly"), /尚未安装/);
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(path.join(f.configDir, "services.json")), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("service discovery keeps readonly and coding distinct and rejects mismatched registration", async () => {
  const f = fixture();
  try {
    const manager = new LaunchAgentManager({ platform: "darwin", home: f.home, env: {}, execute: async () => { throw new Error("not loaded"); } });
    assert.notEqual(manager.descriptor("readonly").domain, manager.descriptor("coding").domain);
    assert.equal((await manager.status("readonly")).installed, true);
    const registryPath = path.join(f.configDir, "services.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    registry.services.readonly = registry.services.coding;
    fs.writeFileSync(registryPath, JSON.stringify(registry));
    assert.throws(() => manager.descriptor("readonly"), /路径或标签不匹配/);
    assert.throws(() => manager.descriptor("unknown"), /未知/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("service management fails explicitly outside macOS without calling launchctl", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const manager = new LaunchAgentManager({ platform: "linux", home: f.home, env: {}, execute: async () => { calls++; } });
    assert.equal((await manager.status("readonly")).state, "unsupported");
    await assert.rejects(() => manager.start("coding"), /仅支持 macOS/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("starting an already running service is idempotent and never reads credentials", async () => {
  const f = fixture();
  try {
    const calls = [];
    const manager = new LaunchAgentManager({ platform: "darwin", home: f.home, env: {}, execute: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: "state = running\npid = 123\n" };
    } });
    assert.equal((await manager.start("readonly")).running, true);
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [["/bin/launchctl", "print"]]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("LaunchAgent manager uses scoped bootstrap, kickstart, and bootout commands", async () => {
  const f = fixture();
  try {
    const label = CODING_LABEL;
    const plist = path.join(f.home, "Library", "LaunchAgents", `${label}.plist`);
    fs.writeFileSync(plist, servicePlist(CODING_LABEL));
    let loaded = false;
    const calls = [];
    const execute = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "print") {
        if (!loaded) throw new Error("not loaded");
        return { stdout: "state = running\npid = 123\n", stderr: "" };
      }
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchAgentManager({ platform: "darwin", env: {}, repoRoot: f.repo, home: f.home, uid: 777, execute });
    const started = await manager.start("coding");
    assert.equal(started.running, true);
    assert.ok(calls.some(call => call.join(" ").includes(`bootstrap gui/777 ${plist}`)));
    assert.equal(calls.some(call => call[1] === "kickstart"), false, "RunAtLoad bootstrap must not race with kickstart");
    const stopped = await manager.stop("coding");
    assert.equal(stopped.loaded, false);
    assert.ok(calls.some(call => call.join(" ").includes(`bootout gui/777/${CODING_LABEL}`)));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("start waits for bootstrap registration and lets RunAtLoad start the service", async () => {
  const f = fixture();
  try {
    const label = CODING_LABEL;
    fs.writeFileSync(path.join(f.home, "Library", "LaunchAgents", `${label}.plist`), servicePlist(CODING_LABEL));
    let bootstrapPolls = 0;
    const execute = async (_command, args) => {
      if (args[0] === "bootstrap") { bootstrapPolls = 0; return { stdout: "", stderr: "" }; }
      if (args[0] === "print") {
        bootstrapPolls += 1;
        if (bootstrapPolls < 3) { const error = new Error("Could not find service"); error.stderr = "Could not find service"; throw error; }
        return { stdout: "state = running\npid = 321\n", stderr: "" };
      }
      if (args[0] === "kickstart") throw new Error("kickstart must not run after bootstrap");
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchAgentManager({ platform: "darwin", env: {}, repoRoot: f.repo, home: f.home, uid: 777, execute, wait: async () => {} });
    const started = await manager.start("coding");
    assert.equal(started.running, true);
    assert.ok(bootstrapPolls >= 3);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("start kickstarts an already-loaded service and tolerates launchctl transition code 37", async () => {
  const f = fixture();
  try {
    const plist = path.join(f.home, "Library", "LaunchAgents", `${CODING_LABEL}.plist`);
    fs.writeFileSync(plist, servicePlist(CODING_LABEL));
    let kickstarts = 0, statusCalls = 0;
    const execute = async (_command, args) => {
      if (args[0] === "print") {
        statusCalls += 1;
        return { stdout: `state = ${statusCalls > 2 ? "running" : "spawn scheduled"}\n${statusCalls > 2 ? "pid = 456\n" : ""}`, stderr: "" };
      }
      if (args[0] === "kickstart") { kickstarts += 1; const error = new Error("Operation already in progress"); error.code = 37; throw error; }
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchAgentManager({ platform: "darwin", env: {}, repoRoot: f.repo, home: f.home, execute, wait: async () => {} });
    const started = await manager.start("coding");
    assert.equal(started.running, true);
    assert.equal(kickstarts, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("start fails closed when a service never reaches running", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.home, "Library", "LaunchAgents", `${CODING_LABEL}.plist`), servicePlist(CODING_LABEL));
    const execute = async (_command, args) => {
      if (args[0] === "print") return { stdout: "state = spawn scheduled\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchAgentManager({ platform: "darwin", env: {}, repoRoot: f.repo, home: f.home, execute, wait: async () => {} });
    await assert.rejects(() => manager.start("coding"), /未在 10 秒内确认 running/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("stop waits until bootout is fully absent before returning", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.home, "Library", "LaunchAgents", `${CODING_LABEL}.plist`), servicePlist(CODING_LABEL));
    let bootout = false, pollsAfterBootout = 0;
    const execute = async (_command, args) => {
      if (args[0] === "bootout") { bootout = true; return { stdout: "", stderr: "" }; }
      if (args[0] === "print") {
        if (bootout) pollsAfterBootout += 1;
        if (bootout && pollsAfterBootout >= 3) { const error = new Error("Could not find service"); error.stderr = "Could not find service"; throw error; }
        return { stdout: `state = ${bootout ? "SIGTERMed" : "running"}\npid = 789\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const manager = new LaunchAgentManager({ platform: "darwin", env: {}, repoRoot: f.repo, home: f.home, execute, wait: async () => {} });
    const stopped = await manager.stop("coding");
    assert.equal(stopped.loaded, false);
    assert.ok(pollsAfterBootout >= 3);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("service control rejects replaced or symlinked LaunchAgents before execution", async () => {
  const f = fixture();
  try {
    const plist = path.join(f.home, "Library", "LaunchAgents", `${READONLY_LABEL}.plist`);
    let calls = 0;
    const manager = new LaunchAgentManager({ platform: "darwin", home: f.home, env: {}, execute: async () => { calls++; } });
    fs.writeFileSync(plist, servicePlist(CODING_LABEL));
    await assert.rejects(() => manager.start("readonly"), /标签.*不匹配/);
    const target = path.join(f.root, "outside.plist");
    fs.writeFileSync(target, servicePlist(READONLY_LABEL)); fs.unlinkSync(plist); fs.symlinkSync(target, plist);
    await assert.rejects(() => manager.start("readonly"), /符号链接/);
    assert.equal(calls, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("config updates reject symlinks and stale snapshots while recovering abandoned locks", () => {
  const f = fixture();
  try {
    const target = path.join(f.root, "readonly-target.json");
    fs.copyFileSync(path.join(f.configDir, "local-evidence-projects.json"), target);
    const linked = path.join(f.root, "readonly-link.json");
    fs.symlinkSync(target, linked);
    const linkedStore = new ConfigStore({ repoRoot: f.repo, home: f.home, env: { SANDBOX_MCP_READONLY_CONFIG: linked } });
    assert.throws(() => linkedStore.list("readonly"), /符号链接/);

    const configPath = path.join(f.configDir, "local-evidence-projects.json");
    const oldSource = fs.readFileSync(configPath, "utf8");
    const oldHash = crypto.createHash("sha256").update(oldSource).digest("hex");
    fs.writeFileSync(configPath, oldSource.replace("\"enabled\": true", "\"enabled\": false"));
    assert.throws(() => atomicWriteJson(configPath, JSON.parse(oldSource), { expectedHash: oldHash }), /其他进程修改/);

    const lockPath = `${configPath}.lock`;
    fs.mkdirSync(lockPath);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    atomicWriteJson(configPath, JSON.parse(fs.readFileSync(configPath, "utf8")));
    assert.equal(fs.existsSync(lockPath), false, "stale lock must be recovered and released");

    fs.mkdirSync(lockPath);
    assert.throws(() => atomicWriteJson(configPath, JSON.parse(fs.readFileSync(configPath, "utf8"))), /另一个控制台/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("LaunchAgent status propagates permission and malformed-output failures", async () => {
  const f = fixture();
  try {
    const permission = new LaunchAgentManager({ platform: "darwin", env: {}, repoRoot: f.repo, home: f.home, execute: async () => { const error = new Error("Operation not permitted"); error.code = "EPERM"; throw error; } });
    await assert.rejects(() => permission.stop("coding"), /无法确认 LaunchAgent 状态/);
    const malformed = new LaunchAgentManager({ platform: "darwin", env: {}, repoRoot: f.repo, home: f.home, execute: async () => ({ stdout: "unexpected output", stderr: "" }) });
    await assert.rejects(() => malformed.status("coding"), /无法确认 LaunchAgent 状态/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

function rawRequest({ port, host = `127.0.0.1:${port}`, path: requestPath = "/api/state", method = "GET", headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, method, path: requestPath, headers: { host, ...headers } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject); request.end();
  });
}

test("HTTP console requires a mutation token and returns both profiles", async (context) => {
  const f = fixture();
  const token = "test-token";
  const store = new ConfigStore({ repoRoot: f.repo, home: f.home, env: {} });
  let restarts = 0;
  const services = {
    status: async profile => ({ installed: true, loaded: true, running: true, state: "running", pid: profile === "coding" ? 42 : 43, label: profile }),
    start: async profile => services.status(profile), stop: async profile => services.status(profile), restart: async profile => { restarts++; return services.status(profile); }
  };
  const handoffTaskDir = path.join(f.home, ".sandbox-mcp", "state", "handoff", "tasks", "task-read");
  fs.mkdirSync(handoffTaskDir, { recursive: true });
  fs.writeFileSync(path.join(handoffTaskDir, "EXECUTION_RECEIPT.json"), `${JSON.stringify({ schema_version: "execution_receipt.v1", task_id: "task-read", status: "blocked" })}\n`);
  const server = createConsoleServer({ store, services, token, execute: async () => ({ stdout: `${f.projectB}\n` }) });
  const listening = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");
  try { await listening; }
  catch (error) {
    fs.rmSync(f.root, { recursive: true, force: true });
    if (error.code === "EPERM") return context.skip("执行沙箱禁止本机回环监听");
    throw error;
  }
  const address = `http://127.0.0.1:${server.address().port}`;
  const originHeaders = { "content-type": "application/json", "origin": address };
  try {
    const stateResponse = await fetch(`${address}/api/state`);
    const state = await stateResponse.json();
    assert.equal(state.ok, true);
    assert.equal(state.profiles.coding.service.pid, 42);
    assert.equal(state.permissions.available, true);
    assert.equal(state.permissions.effective_count, 19);
    assert.equal(state.handoff.available, true);
    assert.equal(state.handoff.tasks.find(task => task.task_id === "task-read").status, "blocked");

    const readReceipt = await fetch(`${address}/api/handoff/task-read/receipt`);
    assert.equal(readReceipt.status, 200);
    assert.equal((await readReceipt.json()).data.status, "blocked");
    const webExecute = await fetch(`${address}/api/handoff/task-read/execute`, { method: "POST", headers: { ...originHeaders, "x-console-token": token }, body: "{}" });
    assert.equal(webExecute.status, 404);

    assert.equal(await rawRequest({ port: server.address().port, host: "attacker.invalid" }), 421);
    assert.equal(await rawRequest({ port: server.address().port, path: "http://attacker.invalid/api/state" }), 400);

    const badOrigin = await fetch(`${address}/api/projects/add`, { method: "POST", headers: { ...originHeaders, origin: "http://attacker.invalid", "x-console-token": token }, body: JSON.stringify({ profile: "readonly", path: f.projectB }) });
    assert.equal(badOrigin.status, 403);

    const rejected = await fetch(`${address}/api/projects/add`, { method: "POST", headers: originHeaders, body: JSON.stringify({ profile: "readonly", path: f.projectB }) });
    assert.equal(rejected.status, 403);

    const accepted = await fetch(`${address}/api/projects/add`, { method: "POST", headers: { ...originHeaders, "x-console-token": token }, body: JSON.stringify({ profile: "readonly", path: f.projectB, restart: false }) });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).profiles.readonly.projects.length, 2);

    const paused = await fetch(`${address}/api/projects/set-enabled`, { method: "POST", headers: { ...originHeaders, "x-console-token": token }, body: JSON.stringify({ profile: "readonly", id: "a", enabled: false, restart: false }) });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).profiles.readonly.projects.find(project => project.id === "a").enabled, false);

    const permission = await fetch(`${address}/api/permissions/tool`, { method: "POST", headers: { ...originHeaders, "x-console-token": token }, body: JSON.stringify({ profile: "readonly", tool: "project.search_text", enabled: false, restart: false }) });
    assert.equal(permission.status, 200);
    assert.equal((await permission.json()).permissions.tools.find(tool => tool.name === "project.search_text").effective, false);

    const writePermission = await fetch(`${address}/api/permissions/tool`, { method: "POST", headers: { ...originHeaders, "x-console-token": token }, body: JSON.stringify({ profile: "readonly", tool: "project.write_text_file", enabled: true, restart: false }) });
    assert.equal(writePermission.status, 400);

    const savedOnly = await fetch(`${address}/api/permissions/tool`, { method: "POST", headers: { ...originHeaders, "x-console-token": token }, body: JSON.stringify({ profile: "readonly", tool: "project.search_text", enabled: true }) });
    assert.equal(savedOnly.status, 200);
    assert.equal(restarts, 0, "saving configuration must not implicitly restart a service");
    const explicitRestart = await fetch(`${address}/api/permissions/tool`, { method: "POST", headers: { ...originHeaders, "x-console-token": token }, body: JSON.stringify({ profile: "readonly", tool: "project.search_text", enabled: false, restart: true }) });
    assert.equal(explicitRestart.status, 200);
    assert.equal(restarts, 1);
  } finally {
    server.close(); await once(server, "close");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("HTTP console remains usable when the optional coding profile is not installed", async (context) => {
  const f = fixture();
  fs.unlinkSync(path.join(f.configDir, "desktop-commander.json"));
  const store = new ConfigStore({ repoRoot: f.repo, home: f.home, env: {} });
  const services = { status: async profile => ({ installed: false, loaded: false, running: false, state: "stopped", pid: null, label: profile }) };
  const server = createConsoleServer({ store, services, token: "test-token" });
  const listening = new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  server.listen(0, "127.0.0.1");
  try { await listening; }
  catch (error) {
    fs.rmSync(f.root, { recursive: true, force: true });
    if (error.code === "EPERM") return context.skip("执行沙箱禁止本机回环监听");
    throw error;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
    const state = await response.json();
    assert.equal(state.ok, true);
    assert.equal(state.profiles.readonly.available, true);
    assert.equal(state.profiles.coding.available, false);
    assert.deepEqual(state.profiles.coding.projects, []);
    assert.match(state.profiles.coding.configError, /desktop-commander\.json/);
  } finally {
    server.close(); await once(server, "close");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("host-user coding profile disables project scope editing and preserves readonly", () => {
  const f = fixture();
  try {
    const profile = path.join(f.configDir, "desktop-commander.json");
    fs.writeFileSync(profile, JSON.stringify({ schema_version: "sandbox_devspace_tool_modes.v1", tool_mode: "all", access_mode: "host_user" }));
    const store = new ConfigStore({repoRoot:f.repo, home:f.home, env:{}});
    assert.equal(store.codingPath, profile);
    assert.deepEqual(store.list("coding"), []);
    assert.throws(() => store.add("coding", f.projectB), /无需添加/);
    assert.throws(() => store.remove("coding", f.projectA), /没有项目/);
    assert.equal(store.list("readonly")[0].mode, "read_only");
  } finally { fs.rmSync(f.root, {recursive:true, force:true}); }
});

test("console template makes service application explicit and contains valid portable JavaScript", () => {
  const html = fs.readFileSync(new URL("../console/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new vm.Script(script);
  assert.doesNotMatch(html, /id="restart-[^"]*" checked/);
  assert.match(html, /保存配置默认不重启服务/);
});
