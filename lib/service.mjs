import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PACKAGE_ROOT, resolvePaths, configOverrides } from './paths.mjs';
import { LaunchAgentManager, READONLY_LABEL, CODING_LABEL, safeJsonParse, atomicWriteJson } from '../console/core.mjs';

const executeDefault = promisify(execFile);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const flagNames = new Set(['--tunnel-binary', '--tunnel-profile', '--api-key-keychain-service', '--tunnel-id-keychain-service']);

function regular(file, { allowMissing = false } = {}) {
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file, not a symlink: ${file}`);
  return info;
}

function directory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a directory, not a symlink: ${target}`);
}

function writeAtomic(file, body, mode) {
  if (fs.existsSync(file)) regular(file);
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, body, { flag: 'wx', mode });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export function createServicePlan({ profile, tunnelBinary, tunnelProfile, apiKeyService, tunnelIdService,
  paths = resolvePaths(), userHome = os.homedir(), nodePath = process.execPath,
  cliPath = path.join(PACKAGE_ROOT, 'bin', 'sandbox-mcp.mjs'), user = os.userInfo().username, env = process.env } = {}) {
  if (!['readonly', 'coding'].includes(profile)) throw new Error('Profile must be readonly or coding');
  if (!path.isAbsolute(tunnelBinary || '')) throw new Error('--tunnel-binary must be absolute');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(tunnelProfile || '')) throw new Error('--tunnel-profile must be a profile name');
  for (const value of [apiKeyService, tunnelIdService]) {
    if (value !== undefined && (!value || value.length > 200 || /[\r\n\0]/.test(value))) throw new Error('Invalid Keychain service name');
  }
  const label = profile === 'readonly' ? READONLY_LABEL : CODING_LABEL;
  const root = path.join(paths.stateDir, 'services', profile);
  const logs = path.join(paths.logsDir, profile);
  const runner = path.join(root, 'run-tunnel.sh');
  const child = path.join(root, 'mcp-child.sh');
  const plist = path.join(userHome, 'Library', 'LaunchAgents', label + '.plist');
  const safePath = [...new Set([path.dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  // The parent may resolve credentials; the child receives only this allowlist.
  // Do not inherit Tunnel's tokens, proxy headers, tracing or unrelated agent state.
  const cleanEnv = { HOME: userHome, USER: user, LOGNAME: user, PATH: safePath, LANG: 'en_US.UTF-8',
    SANDBOX_MCP_HOME: paths.home, ...configOverrides(profile, env) };
  const childBody = '#!/bin/sh\nset -eu\numask 077\nexec /usr/bin/env -i ' +
    Object.entries(cleanEnv).map(([key, value]) => key + '=' + quote(value)).join(' ') + ' ' +
    [nodePath, cliPath, 'serve', profile].map(quote).join(' ') + '\n';
  const args = ['run', '--profile', tunnelProfile, '--mcp.command', 'command=./mcp-child.sh,channel=main',
    '--mcp.stdio-failure-policy', 'exit', '--mcp.stdio-send-initialized-notification=true',
    '--health.listen-addr', '127.0.0.1:0', '--health.url-file', path.join(root, 'health.url'), '--log.format', 'json'];
  let runnerBody = '#!/bin/sh\nset -eu\numask 077\ncd ' + quote(root) + '\n';
  if (apiKeyService) {
    runnerBody += 'CONTROL_PLANE_API_KEY="$(/usr/bin/security find-generic-password -a "$USER" -s ' + quote(apiKeyService) + ' -w)"\nexport CONTROL_PLANE_API_KEY\n';
    args.push('--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY');
  }
  if (tunnelIdService) {
    runnerBody += 'CONTROL_PLANE_TUNNEL_ID="$(/usr/bin/security find-generic-password -a "$USER" -s ' + quote(tunnelIdService) + ' -w)"\nexport CONTROL_PLANE_TUNNEL_ID\n';
  }
  runnerBody += 'exec ' + [tunnelBinary, ...args].map(quote).join(' ') + '\n';
  const plistBody = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>\n' +
    '<key>Label</key><string>' + xml(label) + '</string>\n' +
    '<key>ProgramArguments</key><array><string>/bin/sh</string><string>' + xml(runner) + '</string></array>\n' +
    '<key>WorkingDirectory</key><string>' + xml(root) + '</string>\n' +
    '<key>EnvironmentVariables</key><dict>' + Object.entries(cleanEnv).map(([key, value]) => '<key>' + xml(key) + '</key><string>' + xml(value) + '</string>').join('') + '</dict>\n' +
    '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>Umask</key><integer>63</integer>\n' +
    '<key>StandardOutPath</key><string>' + xml(path.join(logs, 'tunnel.out.log')) + '</string>\n' +
    '<key>StandardErrorPath</key><string>' + xml(path.join(logs, 'tunnel.err.log')) + '</string>\n' +
    '</dict></plist>\n';
  return { profile, label, plist, runner, child, root, logs, files: [
    { path: child, body: childBody, mode: 0o700 },
    { path: runner, body: runnerBody, mode: 0o700 },
    { path: plist, body: plistBody, mode: 0o600 },
  ] };
}

export async function serviceCommand(argv, { paths = resolvePaths(), userHome = os.homedir(),
  platform = process.platform, execute = executeDefault, manager } = {}) {
  const [action, profile, ...rest] = argv;
  if (!['readonly', 'coding'].includes(profile)) throw new Error('service requires a readonly or coding profile');
  if (!['install', 'status', 'start', 'stop', 'restart', 'uninstall'].includes(action)) throw new Error('Unknown service action');
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--start' && action === 'install') { options.start = true; continue; }
    if (action !== 'install' || !flagNames.has(flag) || options[flag] !== undefined) throw new Error('Unexpected service option: ' + flag);
    const value = rest[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag);
    options[flag] = value;
  }
  const registryPath = path.join(paths.configDir, 'services.json');
  const services = manager ?? new LaunchAgentManager({ home: userHome, env: { SANDBOX_MCP_HOME: paths.home }, servicesPath: registryPath, platform, execute });
  if (action === 'status') return services.status(profile);
  if (platform !== 'darwin') throw new Error('LaunchAgent service management is macOS-only; use local stdio instead');
  if (['start', 'stop', 'restart'].includes(action)) return services[action](profile);
  if (action === 'install') {
    const plan = createServicePlan({ profile, paths, userHome, tunnelBinary: options['--tunnel-binary'],
      tunnelProfile: options['--tunnel-profile'], apiKeyService: options['--api-key-keychain-service'], tunnelIdService: options['--tunnel-id-keychain-service'] });
    fs.accessSync(options['--tunnel-binary'], fs.constants.X_OK);
    const { stdout = '', stderr = '' } = await execute(options['--tunnel-binary'], ['run', '--help'], { timeout: 5000, maxBuffer: 256 * 1024 });
    if (!(stdout + stderr).includes('--mcp.stdio-send-initialized-notification') || !(stdout + stderr).includes('--mcp.stdio-failure-policy')) {
      throw new Error('Tunnel lacks required stdio options; use the tested official 0.0.21 release');
    }
    for (const target of [paths.configDir, path.join(userHome, 'Library', 'LaunchAgents'), plan.root, plan.logs]) directory(target);
    if (!fs.existsSync(registryPath)) fs.writeFileSync(registryPath, '{"services":{}}\n', { flag: 'wx', mode: 0o600 });
    const originalRegistry = fs.readFileSync(registryPath);
    const registry = safeJsonParse(registryPath);
    const before = await services.status(profile);
    if (before.loaded) throw new Error('Stop this profile before reinstalling its service');
    const previous = registry.services?.[profile];
    if (!previous && plan.files.some(file => fs.existsSync(file.path))) throw new Error('Refusing to overwrite existing unregistered service files');
    const backups = plan.files.map(file => fs.existsSync(file.path) ? { data: fs.readFileSync(file.path), mode: regular(file.path).mode & 0o777 } : null);
    try {
      for (const file of plan.files) writeAtomic(file.path, file.body, file.mode);
      registry.services[profile] = { label: plan.label, plist: plan.plist };
      atomicWriteJson(registryPath, registry, { expectedHash: digest(originalRegistry) });
    } catch (error) {
      for (let index = 0; index < plan.files.length; index++) {
        const file = plan.files[index], backup = backups[index];
        if (backup) writeAtomic(file.path, backup.data, backup.mode);
        else { try { fs.unlinkSync(file.path); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; } }
      }
      throw error;
    }
    return { installed: true, started: Boolean(options.start), label: plan.label, plist: plan.plist,
      ...(options.start ? { service: await services.start(profile) } : {}),
      note: 'Use service start when your own Tunnel profile can resolve credentials without an interactive shell. Configuration and logs stay in your product home.' };
  }
  const descriptor = services.descriptor(profile);
  if (!descriptor.configured) return { removed: false, note: 'Profile is not installed; no files were removed' };
  services.validatePlist(descriptor, { allowMissing: true });
  await services.stop(profile);
  const source = fs.readFileSync(registryPath);
  const registry = safeJsonParse(registryPath);
  const root = path.join(paths.stateDir, 'services', profile);
  const targets = [descriptor.plist, path.join(root, 'run-tunnel.sh'), path.join(root, 'mcp-child.sh')];
  for (const target of targets) regular(target, { allowMissing: true });
  // Retain ownership until every installed file is gone. A partial deletion or
  // registry write failure can then be retried, including a missing plist.
  for (const target of targets) {
    try { fs.unlinkSync(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  delete registry.services[profile];
  atomicWriteJson(registryPath, registry, { expectedHash: digest(source) });
  return { removed: true, profile, preserved: ['project configuration', 'runtime state', 'logs', 'Tunnel profiles', 'Keychain entries'] };
}
