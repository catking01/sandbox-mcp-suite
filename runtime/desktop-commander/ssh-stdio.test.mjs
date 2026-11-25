import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtime = process.env.SMCP_TEST_RUNTIME || path.dirname(fileURLToPath(import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('SSH command cannot corrupt MCP stdio or expose the command in server diagnostics', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-ssh-stdio-'));
  const shell = path.join(root, 'bash');
  // This executable ignores every argument; no real ssh or network is invoked.
  fs.writeFileSync(shell, "#!/bin/sh\nprintf 'STUB_SSH_EXECUTED\\n'\n", { mode: 0o700 });
  const env = { HOME: root, PATH: '/usr/bin:/bin', SANDBOX_COMMANDER_STATE_DIR: path.join(root, 'state'),
    SANDBOX_WORKBENCH_SYNC_FILE: path.join(root, 'events.jsonl') };
  const child = spawn(process.execPath, [path.join(runtime, 'server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(3000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
  const waitFor = async id => {
    for (let i = 0; i < 200; i++) {
      const records = stdout.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
      const response = records.find(item => item.id === id);
      if (response) return response;
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
      await wait(25);
    }
    throw new Error(`response ${id} timed out: ${stderr}`);
  };
  send({ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'ssh-stdio-regression',version:'1'} } });
  assert.ok((await waitFor(1)).result);
  send({ jsonrpc:'2.0', method:'notifications/initialized', params:{} });
  send({ jsonrpc:'2.0', id:2, method:'tools/call', params:{name:'start_process',arguments:{command:'ssh sandbox-stub.invalid',timeout_ms:1000,shell}} });
  const result = await waitFor(2);
  assert.ok(!result.error && !result.result?.isError);
  let processText = JSON.stringify(result.result);
  if (!processText.includes('STUB_SSH_EXECUTED')) {
    const pid = result.result?.structuredContent?.pid;
    assert.ok(Number.isInteger(pid));
    send({ jsonrpc:'2.0', id:4, method:'tools/call', params:{name:'read_process_output',arguments:{pid,timeout_ms:5000,offset:0}} });
    processText += JSON.stringify((await waitFor(4)).result);
  }
  assert.match(processText, /STUB_SSH_EXECUTED/);
  send({ jsonrpc:'2.0', id:3, method:'tools/call', params:{name:'workbench_sync_status',arguments:{limit:5}} });
  assert.match(JSON.stringify((await waitFor(3)).result), /Local sync events/);
  assert.doesNotMatch(stderr, /ssh sandbox-stub\.invalid|ssh -t sandbox-stub\.invalid/);
});
