import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runManagedStdio } from './managed-stdio.mjs';

function parentProcess(env = { SANDBOX_MANAGED_TUNNEL: '1' }) {
  const parent = new EventEmitter();
  parent.ppid = 1234;
  parent.execPath = process.execPath;
  parent.env = { ...env };
  parent.cwd = () => process.cwd();
  parent.exitCode = undefined;
  return parent;
}

function childScript(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-managed-stdio-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'server-fixture.mjs');
  fs.writeFileSync(file, source);
  return file;
}

function trackParentSignals(parent, managed = true) {
  const signals = [];
  const options = {
    processObject: parent,
    spawnChild: spawn,
    isManagedParent: pid => {
      assert.equal(pid, 1234);
      return managed;
    },
    signalParent: (pid, signal) => signals.push({ pid, signal }),
    startupGraceMs: 25,
  };
  return { options, signals };
}

test('unexpected clean exit after startup grace requests the tunnel parent to restart', async t => {
  const outputFile = path.join(os.tmpdir(), `sandbox-managed-env-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(outputFile, { force: true }));
  const script = childScript(t, `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify({
      managed: process.env.SANDBOX_MANAGED_TUNNEL,
      tunnelPid: process.env.SANDBOX_COMMANDER_TUNNEL_PID,
      preserved: process.env.KEEP_THIS,
    }));
    process.exit(0);
  `);
  const parent = parentProcess({ SANDBOX_MANAGED_TUNNEL: '1', KEEP_THIS: 'yes' });
  const { options, signals } = trackParentSignals(parent);
  const runtime = runManagedStdio({ ...options, childServerPath: script });
  assert.ok(runtime.child);
  await once(runtime.child, 'exit');
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(parent.exitCode, 0);
  assert.deepEqual(signals, [{ pid: 1234, signal: 'SIGTERM' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf8')), {
    tunnelPid: '1234',
    preserved: 'yes',
  });
});

test('explicit supervisor shutdown is forwarded to the child without restarting the tunnel', async t => {
  const script = childScript(t, `
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  const parent = parentProcess();
  const { options, signals } = trackParentSignals(parent);
  const runtime = runManagedStdio({ ...options, childServerPath: script });
  assert.ok(runtime.child);
  runtime.stop('SIGTERM');
  await once(runtime.child, 'exit');
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(parent.exitCode, 0);
  assert.deepEqual(signals, []);
});

test('an unexpected signal exit requests one parent restart only for tunnel parents', async t => {
  const script = childScript(t, `setInterval(() => {}, 1000);`);
  const parent = parentProcess();
  const { options, signals } = trackParentSignals(parent);
  const runtime = runManagedStdio({ ...options, childServerPath: script });
  assert.ok(runtime.child);
  runtime.child.kill('SIGKILL');
  await once(runtime.child, 'exit');
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(parent.exitCode, 1);
  assert.deepEqual(signals, [{ pid: 1234, signal: 'SIGTERM' }]);

  const otherParent = parentProcess();
  const other = trackParentSignals(otherParent, false);
  const otherRuntime = runManagedStdio({ ...other.options, childServerPath: childScript(t, 'process.exit(7);') });
  assert.ok(otherRuntime.child);
  await once(otherRuntime.child, 'exit');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(otherParent.exitCode, 7);
  assert.deepEqual(other.signals, []);
});

test('spawn errors also request one restart from the verified tunnel parent', async () => {
  const parent = parentProcess();
  const { options, signals } = trackParentSignals(parent);
  const runtime = runManagedStdio({
    ...options,
    spawnChild: () => {
      const child = new EventEmitter();
      child.killed = false;
      queueMicrotask(() => child.emit('error', new Error('synthetic spawn failure')));
      return child;
    },
    childServerPath: '/unused/server.mjs',
  });

  assert.ok(runtime.child);
  await once(runtime.child, 'error');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(parent.exitCode, 1);
  assert.deepEqual(signals, [{ pid: 1234, signal: 'SIGTERM' }]);
});
