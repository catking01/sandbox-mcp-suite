import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import properLockfile from "proper-lockfile";
import { ALL_TOOL_NAMES, permissionSnapshot, toolInfo, validatePermissionsConfig } from "./permissions.mjs";
import { resolvePaths } from "../lib/paths.mjs";

const execFileAsync = promisify(execFile);

export const READONLY_LABEL = "io.github.catking01.sandbox-mcp-suite.readonly";
export const CODING_LABEL = "io.github.catking01.sandbox-mcp-suite.coding";

export const DEFAULT_DENIED_GLOBS = Object.freeze([
  ".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key",
  "**/*.p12", "**/id_rsa", "**/id_ed25519", "**/.ssh/**", "**/.aws/**",
  "**/.gcp/**", "**/.azure/**", "**/.git/**", "**/node_modules/**",
  "**/.claude/**", "**/.pytest_cache/**", "**/__pycache__/**", "**/.venv/**",
  "**/venv/**", "**/.mypy_cache/**", "**/.ruff_cache/**",
  "**/local_evidence_archives/**"
]);

function decodeXml(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'");
}

export function safeJsonParse(filePath, filesystem = fs) {
  const stat = filesystem.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`配置必须是普通文件且不能是符号链接: ${filePath}`);
  let parsed;
  try {
    parsed = JSON.parse(filesystem.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取配置 ${filePath}: ${error.message}`);
  }
  return parsed;
}

export function validateProjectRoot(input, { home = os.homedir(), env = process.env, filesystem = fs } = {}) {
  if (typeof input !== "string" || input.trim() === "") throw new Error("项目路径不能为空");
  const lexical = path.resolve(input.trim().replace(/^~(?=$|\/)/, home));
  let stat;
  try {
    stat = filesystem.lstatSync(lexical);
  } catch {
    throw new Error(`项目目录不存在: ${lexical}`);
  }
  if (stat.isSymbolicLink()) throw new Error("项目根目录不能是符号链接");
  if (!stat.isDirectory()) throw new Error("项目路径必须是目录");
  const canonical = filesystem.realpathSync(lexical);
  const forbidden = new Set(["/", home, path.join(home, "Desktop"), path.join(home, "Downloads")].map((entry) => {
    const resolved = path.resolve(entry);
    try { return filesystem.realpathSync(resolved); } catch { return resolved; }
  }));
  if (forbidden.has(canonical)) throw new Error("不能开放根目录、整个 Home、Desktop 或 Downloads");
  const sensitiveRoots = [
    path.join(home, ".codex"), path.join(home, ".ssh"), path.join(home, ".aws"),
    path.join(home, ".config"), path.join(home, ".gnupg"), path.join(home, "Library"),
    resolvePaths({ home, env }).home
  ].map((entry) => {
    try { return filesystem.realpathSync(entry); } catch { return path.resolve(entry); }
  });
  if (sensitiveRoots.some((entry) => canonical === entry || canonical.startsWith(`${entry}${path.sep}`))) {
    throw new Error("不能开放 Codex、SSH、云凭据、配置或 Library 等敏感目录");
  }
  return canonical;
}

export function makeProjectId(root, existingIds = []) {
  const base = path.basename(root).normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "project";
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    if (!taken.has(`${base}_${index}`)) return `${base}_${index}`;
  }
  throw new Error("无法生成唯一项目 ID");
}

export function validateReadonlyConfig(config) {
  if (config?.schema_version !== "local_evidence_projects.v1" || !config.projects || typeof config.projects !== "object" || Array.isArray(config.projects)) {
    throw new Error("只读配置结构无效");
  }
  for (const [id, project] of Object.entries(config.projects)) {
    if (!id || project?.mode !== "read_only" || typeof project.root !== "string") throw new Error(`只读项目 ${id} 配置无效`);
    if (!Array.isArray(project.allowed_globs) || project.allowed_globs.length === 0) throw new Error(`只读项目 ${id} 缺少 allowed_globs`);
    if (!Array.isArray(project.denied_globs) || !project.denied_globs.includes(".env")) throw new Error(`只读项目 ${id} 缺少安全 denylist`);
  }
  return config;
}

export function validateCodingConfig(config) {
  if (config?.schema_version !== "sandbox_devspace_tool_modes.v1" || config.tool_mode !== "all") throw new Error("编码工作台必须保持 tool_mode=all");
  if (config.access_mode === "host_user") return config;
  if (!Array.isArray(config.allowed_roots) || config.allowed_roots.length === 0) throw new Error("编码工作台必须至少保留一个项目根目录");
  return config;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function atomicWriteJson(filePath, value, { filesystem = fs, expectedHash } = {}) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  let release;
  try {
    release = properLockfile.lockSync(filePath, { fs: filesystem, realpath: false, stale: 15_000, update: 5_000, retries: 0 });
  } catch (error) {
    if (error.code === "ELOCKED") throw new Error(`配置正在被另一个控制台修改，请稍后刷新: ${filePath}`);
    throw error;
  }
  try {
    const stat = filesystem.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`配置必须是普通文件且不能是符号链接: ${filePath}`);
    const current = filesystem.readFileSync(filePath, "utf8");
    if (expectedHash && sha256(current) !== expectedHash) throw new Error(`配置已被其他进程修改，请刷新后重试: ${filePath}`);
    filesystem.writeFileSync(temporary, body, { mode: stat.mode & 0o777, flag: "wx" });
    filesystem.renameSync(temporary, filePath);
  } catch (error) {
    try { filesystem.unlinkSync(temporary); } catch {}
    throw error;
  } finally {
    if (release) release();
  }
}

export function discoverCodingConfig({ home = os.homedir(), env = process.env } = {}) {
  if (env.SANDBOX_MCP_CODING_CONFIG) return path.resolve(env.SANDBOX_MCP_CODING_CONFIG);
  return path.join(resolvePaths({ home, env }).configDir, "desktop-commander.json");
}

export class ConfigStore {
  constructor({ repoRoot, home = os.homedir(), env = process.env, filesystem = fs } = {}) {
    this.repoRoot = repoRoot;
    this.home = home;
    this.env = env;
    this.paths = resolvePaths({ home, env });
    this.filesystem = filesystem;
    this.readonlyPath = env.SANDBOX_MCP_READONLY_CONFIG ? path.resolve(env.SANDBOX_MCP_READONLY_CONFIG) : path.join(this.paths.configDir, "local-evidence-projects.json");
    this.codingPath = discoverCodingConfig({ home, repoRoot, env, filesystem });
  }

  load(profile) {
    return this.loadVersioned(profile).config;
  }

  loadVersioned(profile) {
    const filePath = profile === "readonly" ? this.readonlyPath : profile === "coding" ? this.codingPath : null;
    if (!filePath) throw new Error("未知配置类型");
    const stat = this.filesystem.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`配置必须是普通文件且不能是符号链接: ${filePath}`);
    const source = this.filesystem.readFileSync(filePath, "utf8");
    let config;
    try { config = JSON.parse(source); } catch (error) { throw new Error(`无法读取配置 ${filePath}: ${error.message}`); }
    if (profile === "readonly") validateReadonlyConfig(config);
    else validateCodingConfig(config);
    return { config, hash: sha256(source), filePath };
  }

  list(profile) {
    const versioned = this.loadVersioned(profile);
    const config = versioned.config;
    if (profile === "readonly") {
      return Object.entries(config.projects).map(([id, project]) => ({ id, root: project.root, mode: project.mode, enabled: project.enabled === true }));
    }
    if (config.access_mode === "host_user") return [];
    return config.allowed_roots.map((root) => ({ id: root, root, enabled: true }));
  }

  add(profile, requestedPath, requestedId) {
    const root = validateProjectRoot(requestedPath, { home: this.home, env: this.env, filesystem: this.filesystem });
    const versioned = this.loadVersioned(profile);
    const config = versioned.config;
    if (profile === "readonly") {
      if (Object.values(config.projects).some((project) => path.resolve(project.root) === root)) throw new Error("该项目已经在只读列表中");
      const id = requestedId?.trim() || makeProjectId(root, Object.keys(config.projects));
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error("项目 ID 只能包含字母、数字、下划线和连字符");
      if (config.projects[id]) throw new Error(`项目 ID 已存在: ${id}`);
      config.projects[id] = { root, mode: "read_only", enabled: true, allowed_globs: ["**"], denied_globs: [...DEFAULT_DENIED_GLOBS], validation: { symlink_escape_fixture_writes: false } };
      validateReadonlyConfig(config);
      atomicWriteJson(this.readonlyPath, config, { filesystem: this.filesystem, expectedHash: versioned.hash });
      return { id, root };
    }
    if (config.access_mode === "host_user") throw new Error("本机用户模式无需添加项目范围");
    if (config.allowed_roots.some((entry) => path.resolve(entry) === root)) throw new Error("该项目已经在编码工作台列表中");
    config.allowed_roots.push(root);
    validateCodingConfig(config);
    atomicWriteJson(this.codingPath, config, { filesystem: this.filesystem, expectedHash: versioned.hash });
    return { id: root, root };
  }

  remove(profile, id) {
    const versioned = this.loadVersioned(profile);
    const config = versioned.config;
    if (profile === "readonly") {
      if (!config.projects[id]) throw new Error(`找不到只读项目: ${id}`);
      const removed = config.projects[id];
      delete config.projects[id];
      validateReadonlyConfig(config);
      atomicWriteJson(this.readonlyPath, config, { filesystem: this.filesystem, expectedHash: versioned.hash });
      return { id, root: removed.root };
    }
    if (config.access_mode === "host_user") throw new Error("本机用户模式没有项目范围可移除");
    const index = config.allowed_roots.findIndex((root) => root === id);
    if (index < 0) throw new Error("找不到编码项目");
    if (config.allowed_roots.length === 1) throw new Error("不能移除最后一个编码项目根目录");
    const [root] = config.allowed_roots.splice(index, 1);
    validateCodingConfig(config);
    atomicWriteJson(this.codingPath, config, { filesystem: this.filesystem, expectedHash: versioned.hash });
    return { id, root };
  }

  setEnabled(profile, id, enabled) {
    const versioned = this.loadVersioned(profile);
    const config = versioned.config;
    if (profile !== "readonly") throw new Error("编码工作台的项目启用状态由其部署配置管理");
    if (!config.projects[id]) throw new Error(`找不到只读项目: ${id}`);
    config.projects[id].enabled = enabled === true;
    validateReadonlyConfig(config);
    atomicWriteJson(this.readonlyPath, config, { filesystem: this.filesystem, expectedHash: versioned.hash });
    return { id, root: config.projects[id].root, enabled: config.projects[id].enabled };
  }
}

export class PermissionStore {
  constructor({ repoRoot, home = os.homedir(), env = process.env, filesystem = fs } = {}) {
    this.repoRoot = repoRoot;
    this.filesystem = filesystem;
    const override = env.SANDBOX_MCP_PERMISSIONS_CONFIG || env.LOCAL_EVIDENCE_PERMISSIONS_CONFIG;
    this.permissionsPath = override ? path.resolve(override)
      : path.join(resolvePaths({ home, env }).configDir, "local-evidence-permissions.json");
  }

  loadVersioned() {
    const stat = this.filesystem.lstatSync(this.permissionsPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`权限配置必须是普通文件且不能是符号链接: ${this.permissionsPath}`);
    const source = this.filesystem.readFileSync(this.permissionsPath, "utf8");
    let config;
    try { config = JSON.parse(source); } catch (error) { throw new Error(`无法读取权限配置 ${this.permissionsPath}: ${error.message}`); }
    validatePermissionsConfig(config);
    return { config, hash: sha256(source), filePath: this.permissionsPath };
  }

  load() {
    return this.loadVersioned().config;
  }

  snapshot(profile = "readonly", options = {}) {
    const versioned = this.loadVersioned();
    return {
      ...permissionSnapshot(versioned.config, profile, options),
      config_path: versioned.filePath,
      config_hash: versioned.hash
    };
  }

  setTool(profile, toolName, enabled) {
    if (profile !== "readonly") throw new Error("只读权限控制器不能修改编码工作台工具策略");
    if (!ALL_TOOL_NAMES.includes(toolName)) throw new Error(`未知 MCP 工具权限: ${toolName}`);
    const info = toolInfo(toolName);
    if (info.group !== "read") throw new Error("只读服务不允许启用写入工具");
    const versioned = this.loadVersioned();
    versioned.config.profiles[profile].tools[toolName] = enabled === true;
    validatePermissionsConfig(versioned.config);
    atomicWriteJson(this.permissionsPath, versioned.config, { filesystem: this.filesystem, expectedHash: versioned.hash });
    return this.snapshot(profile);
  }
}

// The CLI installs services explicitly. The console only reads this registry and
// controls those exact installed LaunchAgents; it never provisions a tunnel or credentials.
export class LaunchAgentManager {
  constructor({ home = os.homedir(), env = process.env, uid = process.getuid?.() ?? 501,
    platform = process.platform, filesystem = fs, execute = execFileAsync,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), servicesPath } = {}) {
    this.home = home;
    this.uid = uid;
    this.platform = platform;
    this.filesystem = filesystem;
    this.execute = execute;
    this.wait = wait;
    this.servicesPath = servicesPath ?? path.join(resolvePaths({ home, env }).configDir, "services.json");
  }

  descriptor(profile) {
    if (!["readonly", "coding"].includes(profile)) throw new Error("未知服务类型");
    const label = profile === "readonly" ? READONLY_LABEL : CODING_LABEL;
    const plist = path.join(this.home, "Library", "LaunchAgents", `${label}.plist`);
    const base = { label, plist, domain: `gui/${this.uid}/${label}`, configured: false };
    if (!this.filesystem.existsSync(this.servicesPath)) return base;
    const registry = safeJsonParse(this.servicesPath, this.filesystem);
    if (!registry.services || typeof registry.services !== "object" || Array.isArray(registry.services)) throw new Error("服务注册配置无效");
    const entry = registry.services[profile];
    if (entry === undefined) return base;
    if (!entry || entry.label !== label || entry.plist !== plist) throw new Error(`服务注册路径或标签不匹配: ${profile}`);
    return { ...base, configured: true };
  }

  validatePlist(descriptor, { allowMissing = false } = {}) {
    if (!descriptor.configured) throw new Error("服务尚未安装；请先使用 sandbox-mcp service install");
    let stat;
    try { stat = this.filesystem.lstatSync(descriptor.plist); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (allowMissing) return;
      throw new Error(`LaunchAgent 尚未安装: ${descriptor.plist}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`LaunchAgent 必须是普通文件且不能是符号链接: ${descriptor.plist}`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`LaunchAgent 不能由其他用户写入: ${descriptor.plist}`);
    const xml = this.filesystem.readFileSync(descriptor.plist, "utf8");
    const labels = [...xml.matchAll(/<key>\s*Label\s*<\/key>\s*<string>([\s\S]*?)<\/string>/g)];
    if (labels.length !== 1 || decodeXml(labels[0][1]) !== descriptor.label) throw new Error(`LaunchAgent 标签与服务注册不匹配: ${descriptor.plist}`);
  }

  requirePlatform() {
    if (this.platform !== "darwin") throw new Error("LaunchAgent 服务管理仅支持 macOS；可使用本地 stdio 入口");
  }

  async status(profile) {
    const descriptor = this.descriptor(profile);
    const base = { installed: descriptor.configured && this.filesystem.existsSync(descriptor.plist), loaded: false,
      running: false, state: "not_installed", pid: null, label: descriptor.label, supported: this.platform === "darwin" };
    if (this.platform !== "darwin") return { ...base, state: "unsupported" };
    if (!descriptor.configured) return base;
    // A registered job may still be loaded after its plist has been removed.
    // Status and stop use only the fixed, registry-validated launchd domain.
    this.validatePlist(descriptor, { allowMissing: true });
    try {
      const { stdout } = await this.execute("/bin/launchctl", ["print", descriptor.domain], { maxBuffer: 1024 * 1024 });
      const state = stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim();
      if (!state) throw new Error(`launchctl 返回无法识别的状态: ${descriptor.label}`);
      const pid = Number(stdout.match(/\bpid = (\d+)/)?.[1] ?? 0) || null;
      return { ...base, loaded: true, running: state === "running", state, pid };
    } catch (error) {
      const detail = `${error.stderr ?? ""}\n${error.message ?? ""}`;
      if (/could not find service|service not found|no such process|not found in domain|not loaded/i.test(detail)) return { ...base, state: "stopped" };
      throw new Error(`无法确认 LaunchAgent 状态 ${descriptor.label}: ${error.message}`);
    }
  }

  async start(profile) {
    this.requirePlatform();
    const descriptor = this.descriptor(profile);
    this.validatePlist(descriptor);
    const before = await this.status(profile);
    if (before.running) return before;
    let bootstrapped = false;
    if (!before.loaded) {
      await this.execute("/bin/launchctl", ["bootstrap", `gui/${this.uid}`, descriptor.plist]);
      bootstrapped = true;
      let registered = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const current = await this.status(profile);
        if (current.loaded) { registered = true; break; }
        await this.wait(100);
      }
      if (!registered) throw new Error(`LaunchAgent bootstrap 后未在 GUI domain 注册: ${descriptor.label}`);
    }
    if (!bootstrapped) {
      try { await this.execute("/bin/launchctl", ["kickstart", descriptor.domain]); }
      catch (error) { if (Number(error.code) !== 37) throw error; }
    }
    let latest = await this.status(profile);
    for (let attempt = 0; attempt < 100 && !latest.running; attempt++) {
      await this.wait(100);
      latest = await this.status(profile);
    }
    if (!latest.running) throw new Error(`LaunchAgent 未在 10 秒内确认 running: ${descriptor.label} (state=${latest.state})`);
    return latest;
  }

  async stop(profile) {
    this.requirePlatform();
    const descriptor = this.descriptor(profile);
    this.validatePlist(descriptor, { allowMissing: true });
    const before = await this.status(profile);
    if (before.loaded) await this.execute("/bin/launchctl", ["bootout", descriptor.domain]);
    let latest = await this.status(profile);
    for (let attempt = 0; attempt < 50 && latest.loaded; attempt++) {
      await this.wait(100);
      latest = await this.status(profile);
    }
    if (latest.loaded) throw new Error(`LaunchAgent bootout 未在截止时间内完成: ${descriptor.label}`);
    return latest;
  }

  async restart(profile) {
    await this.stop(profile);
    return this.start(profile);
  }
}
