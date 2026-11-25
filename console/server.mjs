#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConfigStore, LaunchAgentManager, PermissionStore } from "./core.mjs";
import { handoffStatus, readHandoffArtifact } from "../scripts/handoff-core.mjs";
import { resolvePaths } from "../lib/paths.mjs";

const execFileAsync = promisify(execFile);
const consoleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(consoleRoot);

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 64 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("请求 JSON 无效"); }
}

function assertProfile(profile) {
  if (!['readonly', 'coding'].includes(profile)) throw new Error("未知配置类型");
  return profile;
}

export function createConsoleServer({
  store = new ConfigStore({ repoRoot }),
  services,
  permissionStore,
  token = crypto.randomBytes(24).toString("hex"),
  htmlPath = path.join(consoleRoot, "index.html"),
  execute = execFileAsync
} = {}) {
  const htmlTemplate = fs.readFileSync(htmlPath, "utf8");
  const effectiveRepoRoot = store.repoRoot ?? repoRoot;
  const env = store.env ?? process.env;
  const home = store.home ?? os.homedir();
  const productPaths = resolvePaths({ home, env });
  const policyStore = permissionStore ?? new PermissionStore({ repoRoot: effectiveRepoRoot, home, env });
  const handoffStateRoot = env.SANDBOX_HANDOFF_STATE_ROOT
    ? path.resolve(env.SANDBOX_HANDOFF_STATE_ROOT)
    : path.join(productPaths.stateDir, "handoff");
  const serviceManager = services ?? new LaunchAgentManager({
    home, env
  });

  async function snapshot() {
    const serviceStatus = async profile => {
      try { return await serviceManager.status(profile); }
      catch (error) { return { installed: false, loaded: false, running: false, state: "unknown", pid: null, error: error.message }; }
    };
    const [readonlyStatus, codingStatus] = await Promise.all([serviceStatus("readonly"), serviceStatus("coding")]);
    const profile = (name, details) => {
      try { return { ...details, projects: store.list(name), accessMode: name === "coding" ? store.loadVersioned(name).config.access_mode || "project" : "read_only", available: true, configError: null }; }
      catch (error) { return { ...details, projects: [], available: false, configError: error.message }; }
    };
    let permissions;
    try {
      store.load("readonly");
      permissions = { available: true, ...policyStore.snapshot("readonly") };
    } catch (error) {
      permissions = { available: false, config_path: policyStore.permissionsPath, error: error.message, tools: [] };
    }
    let handoff;
    try { handoff = { available: true, ...handoffStatus({ state: handoffStateRoot }) }; }
    catch (error) { handoff = { available: false, error: error.message, tasks: [] }; }
    return {
      profiles: {
        readonly: profile("readonly", { title: "Sandbox MCP", kind: "只读查看器", configPath: store.readonlyPath, service: readonlyStatus }),
        coding: profile("coding", { title: "Sandbox MCP for test", kind: "编码工作台", configPath: store.codingPath, service: codingStatus })
      },
      permissions,
      handoff
    };
  }

  const server = http.createServer(async (request, response) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    const allowedHosts = new Set(port ? [`127.0.0.1:${port}`, `localhost:${port}`] : []);
    const requestHost = request.headers.host ?? "";
    if (!allowedHosts.has(requestHost)) {
      json(response, 421, { ok: false, error: "Host 不在本机控制台允许范围内" });
      return;
    }
    if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
      json(response, 400, { ok: false, error: "拒绝 absolute-form 请求目标" });
      return;
    }
    const url = new URL(request.url, `http://${requestHost}`);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        const html = htmlTemplate.replace("__SANDBOX_CONSOLE_TOKEN__", token);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
          "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer"
        });
        response.end(html);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, { ok: true, ...(await snapshot()) });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/handoff/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length < 3 || parts.length > 4) {
          json(response, 404, { ok: false, error: "Invalid handoff artifact path" });
          return;
        }
        const taskId = decodeURIComponent(parts[2]);
        const artifact = parts[3] ? decodeURIComponent(parts[3]) : "receipt";
        json(response, 200, { ok: true, ...readHandoffArtifact({ state: handoffStateRoot, taskId, artifact }) });
        return;
      }
      if (request.method !== "POST") {
        json(response, 404, { ok: false, error: "Not found" });
        return;
      }
      if (request.headers.origin !== `http://${requestHost}`) {
        json(response, 403, { ok: false, error: "Origin 不在本机控制台允许范围内" });
        return;
      }
      if (request.headers["x-console-token"] !== token) {
        json(response, 403, { ok: false, error: "控制台令牌无效" });
        return;
      }
      const body = await readJson(request);
      if (url.pathname === "/api/pick-folder") {
        if (process.platform !== "darwin") throw new Error("文件夹选择器仅支持 macOS；请直接填写绝对路径");
        const script = 'POSIX path of (choose folder with prompt "选择要开放给 Sandbox MCP 的项目目录")';
        const { stdout } = await execute("/usr/bin/osascript", ["-e", script]);
        json(response, 200, { ok: true, path: stdout.trim().replace(/\/$/, "") });
        return;
      }
      if (url.pathname === "/api/projects/add") {
        const profile = assertProfile(body.profile);
        const result = store.add(profile, body.path, body.id);
        let service = await serviceManager.status(profile);
        let restartWarning = null;
        if (body.restart === true && service.loaded) {
          try { service = await serviceManager.restart(profile); }
          catch (error) { restartWarning = `配置已保存，但重启失败: ${error.message}`; }
        }
        json(response, 200, { ok: true, result, service, restartWarning, ...(await snapshot()) });
        return;
      }
      if (url.pathname === "/api/projects/remove") {
        const profile = assertProfile(body.profile);
        const result = store.remove(profile, body.id);
        let service = await serviceManager.status(profile);
        let restartWarning = null;
        if (body.restart === true && service.loaded) {
          try { service = await serviceManager.restart(profile); }
          catch (error) { restartWarning = `配置已保存，但重启失败: ${error.message}`; }
        }
        json(response, 200, { ok: true, result, service, restartWarning, ...(await snapshot()) });
        return;
      }
      if (url.pathname === "/api/projects/set-enabled") {
        const profile = assertProfile(body.profile);
        if (typeof body.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
        const result = store.setEnabled(profile, body.id, body.enabled);
        let service = await serviceManager.status(profile);
        let restartWarning = null;
        if (body.restart === true && service.loaded) {
          try { service = await serviceManager.restart(profile); }
          catch (error) { restartWarning = `项目状态已保存，但重启失败: ${error.message}`; }
        }
        json(response, 200, { ok: true, result, service, restartWarning, ...(await snapshot()) });
        return;
      }
      if (url.pathname === "/api/permissions/tool") {
        const profile = assertProfile(body.profile);
        if (typeof body.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
        const permissions = policyStore.setTool(profile, body.tool, body.enabled);
        let service = await serviceManager.status(profile);
        let restartWarning = null;
        if (body.restart === true && service.loaded) {
          try { service = await serviceManager.restart(profile); }
          catch (error) { restartWarning = `权限已保存，但重启失败: ${error.message}`; }
        }
        json(response, 200, { ok: true, permissions, service, restartWarning, ...(await snapshot()) });
        return;
      }
      if (url.pathname === "/api/service") {
        const profile = assertProfile(body.profile);
        if (!["start", "stop", "restart"].includes(body.action)) throw new Error("未知服务操作");
        const service = await serviceManager[body.action](profile);
        json(response, 200, { ok: true, service, ...(await snapshot()) });
        return;
      }
      json(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      json(response, 400, { ok: false, error: error.message });
    }
  });
  return server;
}

function parseArgs(argv) {
  const result = { host: "127.0.0.1", port: 43127, open: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--open") result.open = true;
    else if (argv[index] === "--port") result.port = Number(argv[++index]);
    else if (argv[index] === "--host") result.host = argv[++index];
    else throw new Error(`未知参数: ${argv[index]}`);
  }
  if (result.host !== "127.0.0.1" && result.host !== "localhost") throw new Error("控制台只允许绑定本机回环地址");
  if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error("端口必须在 1024-65535 之间");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const server = createConsoleServer();
  server.listen(options.port, options.host, async () => {
    const address = `http://${options.host}:${options.port}/`;
    process.stdout.write(`Sandbox MCP 控制台已启动：${address}\n按 Ctrl+C 停止控制台；MCP 服务可继续独立运行。\n`);
    if (options.open) {
      try { await execFileAsync("/usr/bin/open", [address]); }
      catch (error) { process.stderr.write(`无法自动打开浏览器：${error.message}\n`); }
    }
  });
}
