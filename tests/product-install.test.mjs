import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { PACKAGE_ROOT, resolvePaths } from '../lib/paths.mjs';
import { initialize, clientConfig } from '../lib/cli.mjs';
import { createServicePlan, serviceCommand } from '../lib/service.mjs';
import { probeStdio } from '../lib/mcp-probe.mjs';

const cli = path.join(PACKAGE_ROOT, 'bin', 'sandbox-mcp.mjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-product-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userHome = path.join(root, 'new user'); fs.mkdirSync(userHome);
  const paths = resolvePaths({ env: { SANDBOX_MCP_HOME: path.join(userHome, "product's state") } });
  return { root, userHome, paths };
}
function command(args, paths, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SANDBOX_MCP_HOME: paths.home, ...env }, encoding: 'utf8', timeout: 20000 });
}

test('new-user init is private, empty and preserves edits on repeat', t => {
  const { paths } = fixture(t);
  const first = initialize(paths);
  assert.equal(first.created.length, 5);
  const file = path.join(paths.configDir, 'local-evidence-projects.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).projects, {});
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const changed = JSON.stringify({ schema_version: 'local_evidence_projects.v1', projects: {}, note: 'keep user edits' });
  fs.writeFileSync(file, changed);
  assert.equal(initialize(paths).created.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  assert.equal(fs.statSync(paths.home).mode & 0o777, 0o700);
});

test('init refuses a symlink config without changing its target', t => {
  const { root, paths } = fixture(t); initialize(paths);
  const target = path.join(root, 'untouched'); fs.writeFileSync(target, 'do not replace');
  const config = path.join(paths.configDir, 'local-evidence-projects.json');
  fs.unlinkSync(config); fs.symlinkSync(target, config);
  assert.throws(() => initialize(paths), /unsafe existing config/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not replace');
});

test('CLI adds a real project and doctor completes readonly stdio discovery', t => {
  const { root, paths } = fixture(t); initialize(paths);
  const project = path.join(root, 'sample project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), 'hello');
  const add = command(['add-project', 'sample', project], paths);
  assert.equal(add.status, 0, add.stderr);
  assert.equal(JSON.parse(add.stdout).id, 'sample');
  const doctor = command(['doctor', 'readonly'], paths);
  assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
  const info = JSON.parse(doctor.stdout);
  assert.equal(info.ok, true); assert.equal(info.profiles.readonly.tools.length, 19);
  assert.ok(info.profiles.readonly.tools.includes('project.list_projects'));
  assert.ok(!info.profiles.readonly.tools.some(name => /write_text_file|create_delegated/.test(name)));
  const remove = command(['remove-project', 'sample'], paths);
  assert.equal(remove.status, 0, remove.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.configDir, 'local-evidence-projects.json'))).projects, {});
});

test('generated client config has absolute independent entries and no ambient secrets', t => {
  const { paths } = fixture(t);
  const result = clientConfig('both', paths);
  assert.equal(Object.keys(result.mcpServers).length, 2);
  for (const [name, config] of Object.entries(result.mcpServers)) {
    assert.ok(path.isAbsolute(config.command)); assert.ok(path.isAbsolute(config.args[0]));
    assert.equal(config.args[2], name === 'sandbox-mcp' ? 'readonly' : 'coding');
    assert.deepEqual(config.env, { SANDBOX_MCP_HOME: paths.home });
  }
  assert.throws(() => resolvePaths({ env: { SANDBOX_MCP_HOME: './relative' } }), /absolute/);
});

test('serve fails before touching stdout when uninitialized', t => {
  const { paths } = fixture(t);
  const result = command(['serve', 'readonly'], paths);
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /init first/);
});

test('readonly CLI uses its own overridden config and service status needs no project configs', t => {
  const { root, paths } = fixture(t); initialize(paths);
  fs.unlinkSync(path.join(paths.configDir, 'desktop-commander.json'));
  const independent = command(['doctor', 'readonly'], paths);
  assert.equal(independent.status, 0, independent.stderr + independent.stdout);
  const customConfig = path.join(root, 'custom-readonly.json');
  fs.renameSync(path.join(paths.configDir, 'local-evidence-projects.json'), customConfig);
  const env = { SANDBOX_MCP_READONLY_CONFIG: customConfig };
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const add = command(['add-project', 'sample', project], paths, env);
  assert.equal(add.status, 0, add.stderr);
  const doctor = command(['doctor', 'readonly'], paths, env);
  assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
  assert.equal(JSON.parse(doctor.stdout).profiles.readonly.ok, true);
  const status = command(['service', 'status', 'readonly'], paths);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).loaded, false);
});

test('read-only monitor starts without initializing project configuration', async t => {
  const { paths } = fixture(t);
  const child = spawn(process.execPath, [cli, 'monitor'], {
    env: { ...process.env, SANDBOX_MCP_HOME: paths.home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await closed; });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Monitor did not start: ' + stderr)), 10000);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once('error', finish);
    child.once('close', code => finish(new Error(`Monitor exited before startup (${code}): ${stderr}`)));
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (/SANDBOX_WORKBENCH_URL http:\/\/127\.0\.0\.1:\d+\//.test(stdout)) finish();
    });
  });
  assert.equal(fs.existsSync(paths.home), false);
  child.kill('SIGTERM');
  assert.equal(await closed, 0);
});

test('stdio probe rejects malformed responses without escaping its promise', async t => {
  const initialized = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
    protocolVersion: '2025-03-26', serverInfo: { name: 'fixture', version: '1' },
  } }) + '\n';
  const cases = [
    ['null message', 'null\n', /Invalid JSON-RPC/],
    ['response before initialize', JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) + '\n', /response order/],
    ['null tool item', initialized + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [null] } }) + '\n', /Invalid MCP tools/],
    ['non-string tool name', initialized + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 3 }] } }) + '\n', /Invalid MCP tools/],
  ];
  for (const [name, output, error] of cases) {
    await t.test(name, async () => {
      await assert.rejects(probeStdio({ command: process.execPath,
        args: ['-e', `process.stdout.write(${JSON.stringify(output)});process.stdin.resume();`],
        timeoutMs: 2000,
      }), error);
    });
  }
});

test('service child handles quoted paths and removes inherited Tunnel credentials', t => {
  const { root, userHome, paths } = fixture(t);
  const fakeCLI = path.join(root, "inspect's env.mjs");
  fs.writeFileSync(fakeCLI, "process.stdout.write(JSON.stringify({args:process.argv.slice(2),home:process.env.SANDBOX_MCP_HOME,secret:process.env.CONTROL_PLANE_API_KEY,proxy:process.env.HTTPS_PROXY}))");
  const plan = createServicePlan({ profile: 'readonly', paths, userHome, tunnelBinary: '/tmp/tunnel-client', tunnelProfile: 'own-profile', cliPath: fakeCLI });
  fs.mkdirSync(plan.root, { recursive: true });
  const child = plan.files.find(file => file.path === plan.child); fs.writeFileSync(child.path, child.body, { mode: child.mode });
  const result = spawnSync('/bin/sh', [plan.child], { env: { ...process.env, CONTROL_PLANE_API_KEY: 'synthetic-test-value', HTTPS_PROXY: 'http://unused.test' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['serve', 'readonly'], home: paths.home });
  const runner = plan.files.find(file => file.path === plan.runner).body;
  assert.match(runner, /stdio-send-initialized-notification=true/);
  assert.match(runner, /stdio-failure-policy.*exit/);
});

test('client entries and service child preserve explicit config paths without copying credentials', t => {
  const { root, userHome, paths } = fixture(t);
  const readonly = path.join(root, "reader's config.json");
  const permissions = path.join(root, 'permissions.json');
  const coding = path.join(root, 'coding.json');
  const env = {
    SANDBOX_MCP_READONLY_CONFIG: path.relative(process.cwd(), readonly),
    LOCAL_EVIDENCE_PERMISSIONS_CONFIG: permissions,
    SANDBOX_MCP_CODING_CONFIG: coding,
    CONTROL_PLANE_API_KEY: 'synthetic-test-value', HTTPS_PROXY: 'http://unused.test',
  };
  const readonlyEnv = { SANDBOX_MCP_HOME: paths.home, SANDBOX_MCP_READONLY_CONFIG: readonly, SANDBOX_MCP_PERMISSIONS_CONFIG: permissions };
  const clients = clientConfig('both', paths, { env }).mcpServers;
  assert.deepEqual(clients['sandbox-mcp'].env, readonlyEnv);
  assert.deepEqual(clients['sandbox-mcp-for-test'].env, { SANDBOX_MCP_HOME: paths.home, SANDBOX_MCP_CODING_CONFIG: coding });
  const fakeCLI = path.join(root, 'inspect-config.mjs');
  fs.writeFileSync(fakeCLI, "process.stdout.write(JSON.stringify(Object.fromEntries(['SANDBOX_MCP_HOME','SANDBOX_MCP_READONLY_CONFIG','SANDBOX_MCP_PERMISSIONS_CONFIG','SANDBOX_MCP_CODING_CONFIG','CONTROL_PLANE_API_KEY','HTTPS_PROXY'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))))");
  const plan = createServicePlan({ profile: 'readonly', paths, userHome, tunnelBinary: '/tmp/tunnel-client', tunnelProfile: 'own-profile', cliPath: fakeCLI, env });
  fs.mkdirSync(plan.root, { recursive: true });
  const child = plan.files.find(file => file.path === plan.child);
  fs.writeFileSync(child.path, child.body, { mode: child.mode });
  const result = spawnSync('/bin/sh', [plan.child], { cwd: os.tmpdir(), env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), readonlyEnv);
});

test('service install is explicit, refuses foreign files and uninstall preserves user data', async t => {
  const { root, userHome, paths } = fixture(t); initialize(paths);
  const binary = path.join(root, 'tunnel-client'); fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const calls = [];
  const execute = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === binary) return { stdout: '--mcp.stdio-failure-policy --mcp.stdio-send-initialized-notification' };
    const error = new Error('Could not find service'); error.stderr = 'Could not find service'; throw error;
  };
  const options = { paths, userHome, platform: 'darwin', execute };
  const install = ['install', 'readonly', '--tunnel-binary', binary, '--tunnel-profile', 'sample'];
  const result = await serviceCommand(install, options);
  assert.equal(result.installed, true); assert.equal(result.started, false);
  assert.ok(!calls.some(call => call.args.includes('bootstrap') || call.cmd.includes('security')));
  const stateFile = path.join(paths.stateDir, 'keep.txt'); fs.writeFileSync(stateFile, 'user state');
  const removed = await serviceCommand(['uninstall', 'readonly'], options);
  assert.equal(removed.removed, true); assert.equal(fs.existsSync(result.plist), false);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'user state');
  assert.ok(fs.existsSync(path.join(paths.configDir, 'local-evidence-projects.json')));
  fs.writeFileSync(result.plist, 'foreign LaunchAgent', { mode: 0o600 });
  await assert.rejects(serviceCommand(install, options), /unregistered/);
  assert.equal(fs.readFileSync(result.plist, 'utf8'), 'foreign LaunchAgent');
});

test('Keychain runner contains references only and tunnel ID uses its native environment field', t => {
  const { userHome, paths } = fixture(t);
  const plan = createServicePlan({ profile: 'coding', paths, userHome, tunnelBinary: '/tmp/tunnel-client', tunnelProfile: 'mine', apiKeyService: "api's-reference", tunnelIdService: 'tunnel-id-reference' });
  const runner = plan.files.find(file => file.path === plan.runner).body;
  assert.match(runner, /CONTROL_PLANE_API_KEY="\$\(/);
  assert.match(runner, /\nexport CONTROL_PLANE_API_KEY\n/);
  assert.match(runner, /\nexport CONTROL_PLANE_TUNNEL_ID\n/);
  assert.ok(!runner.includes('env:CONTROL_PLANE_TUNNEL_ID'));
  const syntax = spawnSync('/bin/sh', ['-n'], { input: runner, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('partial uninstall keeps registration and can be retried after a file deletion failure', async t => {
  const { root, userHome, paths } = fixture(t); initialize(paths);
  const binary = path.join(root, 'tunnel-client'); fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const execute = async cmd => {
    if (cmd === binary) return { stdout: '--mcp.stdio-failure-policy --mcp.stdio-send-initialized-notification' };
    const error = new Error('Could not find service'); error.stderr = error.message; throw error;
  };
  const options = { paths, userHome, platform: 'darwin', execute };
  const args = ['install', 'readonly', '--tunnel-binary', binary, '--tunnel-profile', 'sample'];
  const installed = await serviceCommand(args, options);
  const registryPath = path.join(paths.configDir, 'services.json');
  const runner = path.join(paths.stateDir, 'services', 'readonly', 'run-tunnel.sh');
  const unlink = fs.unlinkSync;
  const failing = t.mock.method(fs, 'unlinkSync', target => {
    if (target === runner) throw Object.assign(new Error('injected deletion failure'), { code: 'EACCES' });
    return unlink(target);
  });
  try { await assert.rejects(serviceCommand(['uninstall', 'readonly'], options), /injected deletion failure/); }
  finally { failing.mock.restore(); }
  assert.equal(fs.existsSync(installed.plist), false);
  assert.equal(fs.existsSync(runner), true);
  assert.equal(JSON.parse(fs.readFileSync(registryPath)).services.readonly.label, installed.label);
  const retry = await serviceCommand(['uninstall', 'readonly'], options);
  assert.equal(retry.removed, true);
  assert.equal(fs.existsSync(runner), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath)), { services: {} });
  assert.equal((await serviceCommand(args, options)).installed, true);
});

test('uninstall stops a registered loaded domain when its plist is missing', async t => {
  const { root, userHome, paths } = fixture(t); initialize(paths);
  const binary = path.join(root, 'tunnel-client'); fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  let loaded = false;
  const calls = [];
  const execute = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === binary) return { stdout: '--mcp.stdio-failure-policy --mcp.stdio-send-initialized-notification' };
    if (args[0] === 'bootout') { loaded = false; return { stdout: '' }; }
    if (loaded) return { stdout: 'state = running\npid = 123\n' };
    const error = new Error('Could not find service'); error.stderr = error.message; throw error;
  };
  const options = { paths, userHome, platform: 'darwin', execute };
  const installed = await serviceCommand(['install', 'coding', '--tunnel-binary', binary, '--tunnel-profile', 'sample'], options);
  fs.unlinkSync(installed.plist); loaded = true;
  const status = await serviceCommand(['status', 'coding'], options);
  assert.equal(status.installed, false); assert.equal(status.loaded, true);
  const removed = await serviceCommand(['uninstall', 'coding'], options);
  assert.equal(removed.removed, true); assert.equal(loaded, false);
  assert.deepEqual(calls.filter(call => call.args[0] === 'bootout').map(call => call.args), [
    ['bootout', `gui/${process.getuid?.() ?? 501}/${installed.label}`],
  ]);
});

test('uninstall can retry a registry-write failure after deleting its files', async t => {
  const { root, userHome, paths } = fixture(t); initialize(paths);
  const binary = path.join(root, 'tunnel-client'); fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const execute = async cmd => {
    if (cmd === binary) return { stdout: '--mcp.stdio-failure-policy --mcp.stdio-send-initialized-notification' };
    const error = new Error('Could not find service'); error.stderr = error.message; throw error;
  };
  const options = { paths, userHome, platform: 'darwin', execute };
  const installed = await serviceCommand(['install', 'readonly', '--tunnel-binary', binary, '--tunnel-profile', 'sample'], options);
  const registryPath = path.join(paths.configDir, 'services.json');
  const rename = fs.renameSync;
  const failing = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === registryPath) throw Object.assign(new Error('injected registry failure'), { code: 'ENOSPC' });
    return rename(source, destination);
  });
  try { await assert.rejects(serviceCommand(['uninstall', 'readonly'], options), /injected registry failure/); }
  finally { failing.mock.restore(); }
  assert.equal(fs.existsSync(installed.plist), false);
  assert.ok(JSON.parse(fs.readFileSync(registryPath)).services.readonly);
  assert.equal((await serviceCommand(['uninstall', 'readonly'], options)).removed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath)), { services: {} });
});
