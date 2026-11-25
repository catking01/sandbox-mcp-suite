import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { PACKAGE_ROOT, resolvePaths, configOverrides } from './paths.mjs';
import { probeStdio } from './mcp-probe.mjs';

const require = createRequire(import.meta.url);
const runtime = path.join(PACKAGE_ROOT, 'runtime', 'desktop-commander');
const bin = path.join(PACKAGE_ROOT, 'bin', 'sandbox-mcp.mjs');
const profiles = new Set(['readonly', 'coding']);
const templates = ['local-evidence-projects.json', 'local-evidence-permissions.json', 'local-evidence-denylist.json', 'local-evidence-file-policy.json', 'desktop-commander.json'];
const usage = `Sandbox MCP Suite — two independent local MCP profiles

  sandbox-mcp init [--home ABS]
  sandbox-mcp add-project ID ABSOLUTE_DIRECTORY [--home ABS]
  sandbox-mcp remove-project ID [--home ABS]
  sandbox-mcp setup coding [--home ABS]
  sandbox-mcp serve readonly|coding [--home ABS]
  sandbox-mcp config readonly|coding|both [--home ABS]
  sandbox-mcp doctor [readonly|coding] [--home ABS]
  sandbox-mcp console [--open] [--port N] [--home ABS]
  sandbox-mcp monitor [--open] [--port N] [--home ABS]
  sandbox-mcp service install PROFILE --tunnel-binary ABS --tunnel-profile NAME
      [--api-key-keychain-service NAME] [--tunnel-id-keychain-service NAME] [--start]
  sandbox-mcp service status|start|stop|restart|uninstall PROFILE [--home ABS]

readonly exposes only admitted projects. coding can edit files and run commands
as your OS user; it is not an OS sandbox. No service starts during installation.
Default state: ~/.sandbox-mcp; override with an absolute SANDBOX_MCP_HOME.
`;

function selectProfile(value) {
  if (!profiles.has(value)) throw new Error('Profile must be readonly or coding');
  return value;
}

export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a directory, not a symlink: ${directory}`);
}

export function initialize(paths = resolvePaths()) {
  for (const directory of [paths.home, paths.configDir, paths.stateDir, paths.logsDir, paths.tunnelDir]) ensurePrivateDirectory(directory);
  const created = [], kept = [];
  for (const name of templates) {
    const destination = path.join(paths.configDir, name);
    if (fs.existsSync(destination)) {
      const info = fs.lstatSync(destination);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing unsafe existing config: ${destination}`);
      kept.push(name); continue;
    }
    fs.writeFileSync(destination, fs.readFileSync(path.join(PACKAGE_ROOT, 'config', name)), { mode: 0o600, flag: 'wx' });
    created.push(name);
  }
  return { home: paths.home, created, kept };
}

function initialized(paths, profile) {
  const overrides = configOverrides(profile);
  const target = profile === 'readonly'
    ? overrides.SANDBOX_MCP_READONLY_CONFIG || path.join(paths.configDir, 'local-evidence-projects.json')
    : overrides.SANDBOX_MCP_CODING_CONFIG || path.join(paths.configDir, 'desktop-commander.json');
  if (!fs.existsSync(target)) throw new Error(`Run sandbox-mcp init first; missing ${profile} config: ${target}`);
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe config file: ${target}`);
}

function nodeSupported() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major >= 22 && major < 27 && (major !== 22 || minor >= 19);
}

function codingReady() {
  const dependency = path.join(runtime, 'node_modules', '@wonderwhy-er', 'desktop-commander');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dependency, 'package.json')));
    const patched = fs.readFileSync(path.join(dependency, 'dist', 'terminal-manager.js'), 'utf8');
    if (pkg.version !== '0.2.48' || !patched.includes('sandboxCommanderPendingInput')) throw new Error('Missing prepared stdin patch');
    require.resolve('proper-lockfile');
  } catch {
    throw new Error('Coding runtime is not prepared; run sandbox-mcp setup coding');
  }
}

export function clientConfig(profile, paths = resolvePaths(), { env = process.env } = {}) {
  if (profile !== 'both') selectProfile(profile);
  const selected = profile === 'both' ? ['readonly', 'coding'] : [profile];
  return { mcpServers: Object.fromEntries(selected.map(name => [name === 'readonly' ? 'sandbox-mcp' : 'sandbox-mcp-for-test', {
    command: process.execPath,
    args: [bin, 'serve', name],
    env: { SANDBOX_MCP_HOME: paths.home, ...configOverrides(name, env) },
  }])) };
}

function subprocess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    const forward = signal => { if (child.exitCode === null) child.kill(signal); };
    const sigint = () => forward('SIGINT'), sigterm = () => forward('SIGTERM');
    process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
      if (code !== 0) reject(new Error(`${path.basename(command)} failed (${code ?? signal})`)); else resolve();
    });
  });
}

export async function main(input = process.argv.slice(2)) {
  const argv = [...input];
  const homeAt = argv.indexOf('--home');
  if (homeAt !== -1) {
    const selected = argv[homeAt + 1];
    if (!selected || !path.isAbsolute(selected)) throw new Error('--home requires an absolute path');
    process.env.SANDBOX_MCP_HOME = path.resolve(selected);
    argv.splice(homeAt, 2);
    if (argv.includes('--home')) throw new Error('--home may be supplied only once');
  }
  const paths = resolvePaths();
  const action = argv.shift();
  if (!action || action === '--help' || action === 'help') { process.stdout.write(usage); return; }
  if (action === '--version') { process.stdout.write(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'))).version + '\n'); return; }
  if (!nodeSupported()) throw new Error('Node.js >=22.19 and <27 is required');
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('This release supports macOS, with limited Linux stdio support; Windows is not supported');
  const output = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (action === 'init') {
    if (argv.length) throw new Error('init takes no positional arguments');
    output(initialize(paths)); return;
  }
  if (action === 'config') {
    if (argv.length !== 1) throw new Error('config requires readonly, coding or both');
    output(clientConfig(argv[0], paths)); return;
  }
  if (action === 'setup') {
    if (argv.length !== 1 || argv[0] !== 'coding') throw new Error('Use setup coding; readonly needs only the root npm dependencies');
    initialize(paths);
    fs.accessSync(runtime, fs.constants.W_OK);
    process.stderr.write('Installing pinned coding dependencies without lifecycle scripts, then applying reviewed local patches.\n');
    await subprocess('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime });
    await subprocess(process.execPath, [path.join(runtime, 'prepare.mjs')]);
    codingReady();
    output({ prepared: 'coding', home: paths.home }); return;
  }
  if (action === 'add-project' || action === 'remove-project') {
    initialized(paths, 'readonly');
    const { ConfigStore } = await import('../console/core.mjs');
    const store = new ConfigStore({ repoRoot: PACKAGE_ROOT });
    if (action === 'add-project') {
      if (argv.length !== 2 || !path.isAbsolute(argv[1])) throw new Error('add-project requires ID and an absolute directory');
      output(store.add('readonly', argv[1], argv[0]));
    } else {
      if (argv.length !== 1) throw new Error('remove-project requires ID');
      output(store.remove('readonly', argv[0]));
    }
    return;
  }
  if (action === 'serve') {
    if (argv.length !== 1) throw new Error('serve requires readonly or coding');
    const profile = selectProfile(argv[0]);
    initialized(paths, profile);
    if (profile === 'coding') codingReady();
    const script = profile === 'readonly' ? path.join(PACKAGE_ROOT, 'scripts', 'local-evidence-mcp.mjs') : path.join(runtime, 'server.mjs');
    process.argv = [process.execPath, script];
    await import(pathToFileURL(script).href);
    return;
  }
  if (action === 'doctor') {
    if (argv.length > 1) throw new Error('doctor accepts at most one profile');
    const selected = argv.length ? [selectProfile(argv[0])] : ['readonly', 'coding'];
    const result = { node: process.versions.node, platform: process.platform, home: paths.home, profiles: {}, ok: true };
    for (const profile of selected) {
      try {
        initialized(paths, profile);
        if (profile === 'coding') codingReady();
        const probe = await probeStdio({ command: process.execPath, args: [bin, 'serve', profile], env: { ...process.env, SANDBOX_MCP_HOME: paths.home } });
        if (profile === 'readonly' && probe.tools.some(name => /write_text_file|create_delegated_execution_request/.test(name))) throw new Error('Readonly profile unexpectedly exposed a mutation tool');
        result.profiles[profile] = { ok: true, ...probe };
      } catch (error) { result.ok = false; result.profiles[profile] = { ok: false, error: error.message }; }
    }
    output(result); if (!result.ok) process.exitCode = 1; return;
  }
  if (action === 'console' || action === 'monitor') {
    if (action === 'console') initialized(paths, 'readonly');
    const script = action === 'console' ? path.join(PACKAGE_ROOT, 'console', 'server.mjs') : path.join(runtime, 'local-workbench-server.mjs');
    process.argv = [process.execPath, script, ...argv];
    await import(pathToFileURL(script).href); return;
  }
  if (action === 'service') {
    if (argv[0] === 'install') initialized(paths, selectProfile(argv[1]));
    const { serviceCommand } = await import('./service.mjs');
    output(await serviceCommand(argv, { paths })); return;
  }
  throw new Error(`Unknown command: ${action}; use --help`);
}
