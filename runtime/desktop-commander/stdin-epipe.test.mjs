import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { processGroupExists } from './process-group.mjs';

const entry = fileURLToPath(new URL('./server.mjs', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-stdin-write-'));
  const client = new Client({ name: 'stdin-epipe-regression', version: '1' }, {});
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      HOME: root,
      PATH: process.env.PATH,
      SANDBOX_COMMANDER_STATE_DIR: path.join(root, 'state'),
      SANDBOX_WORKBENCH_SYNC_FILE: path.join(root, 'events.jsonl'),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });

  const processGroups = new Set();
  t.after(async () => {
    try {
      await client.close();
    } catch {
      // A failed regression can close the server before fixture cleanup runs.
    }

    const cleanupErrors = [];
    for (const pid of processGroups) {
      try {
        if (processGroupExists(pid)) process.kill(-pid, 'SIGTERM');
        for (let attempt = 0; attempt < 30 && processGroupExists(pid); attempt++) await pause(25);
        if (processGroupExists(pid)) process.kill(-pid, 'SIGKILL');
        for (let attempt = 0; attempt < 30 && processGroupExists(pid); attempt++) await pause(25);
        if (processGroupExists(pid)) cleanupErrors.push(`process group ${pid} is still running`);
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }

    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(cleanupErrors, []);
    assert.equal(fs.existsSync(root), false);
  });

  await client.connect(transport);

  return {
    root,
    client,
    stderr: () => stderr,
    trackProcessGroup: pid => processGroups.add(pid),
  };
}

test('writing to a child with closed stdin reports an error without crashing MCP stdio', { timeout: 15000 }, async t => {
  const { client, stderr, trackProcessGroup } = await fixture(t);

  const code = "require('node:fs').closeSync(0);console.log('STDIN_CLOSED_READY');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),8000);";
  const started = await client.callTool({
    name: 'start_process',
    arguments: { command: `exec ${quote(process.execPath)} -e ${quote(code)}`, timeout_ms: 100 },
  });
  assert.equal(started.isError, undefined, `${JSON.stringify(started)}\n${stderr()}`);
  const pid = started.structuredContent?.pid;
  assert.ok(Number.isSafeInteger(pid), JSON.stringify(started));
  trackProcessGroup(pid);

  let ready;
  for (let attempt = 0; attempt < 50; attempt++) {
    ready = await client.callTool({ name: 'read_process_output', arguments: { pid, offset: 0 } });
    if (ready.structuredContent?.output.includes('STDIN_CLOSED_READY')) break;
    await pause(10);
  }
  assert.match(ready.structuredContent?.output ?? '', /STDIN_CLOSED_READY/);
  assert.equal(ready.structuredContent?.running, true);

  const failedWrite = await client.callTool({
    name: 'interact_with_process',
    arguments: { pid, input: 'WRITE_TO_CLOSED_STDIN', wait_for_prompt: false, timeout_ms: 0 },
  });
  await pause(50);
  assert.equal(failedWrite.isError, true, `${JSON.stringify(failedWrite)}\n${stderr()}`);

  const sessions = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.equal(sessions.isError, undefined, `${JSON.stringify(sessions)}\n${stderr()}`);
  assert.match(JSON.stringify(sessions), new RegExp(String(pid)));
  assert.doesNotMatch(stderr(), /Unhandled 'error' event|Error: write EPIPE/);

  const stopped = await client.callTool({ name: 'force_terminate', arguments: { pid } });
  assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
  await waitForProcessGroupExit(pid);
});

test('a stalled stdin write has a bounded timeout and keeps MCP stdio responsive', { timeout: 15000 }, async t => {
  const { client, stderr, trackProcessGroup } = await fixture(t);
  const code = "console.log('STDIN_OPEN_READY');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),8000);";
  const started = await client.callTool({
    name: 'start_process',
    arguments: { command: `exec ${quote(process.execPath)} -e ${quote(code)}`, timeout_ms: 100 },
  });
  assert.equal(started.isError, undefined, `${JSON.stringify(started)}\n${stderr()}`);
  const pid = started.structuredContent?.pid;
  assert.ok(Number.isSafeInteger(pid), JSON.stringify(started));
  trackProcessGroup(pid);

  let ready;
  for (let attempt = 0; attempt < 50; attempt++) {
    ready = await client.callTool({ name: 'read_process_output', arguments: { pid, offset: 0 } });
    if (ready.structuredContent?.output.includes('STDIN_OPEN_READY')) break;
    await pause(10);
  }
  assert.match(ready.structuredContent?.output ?? '', /STDIN_OPEN_READY/);
  assert.equal(ready.structuredContent?.running, true);

  const input = 'x'.repeat(2 * 1024 * 1024);
  const startedAt = Date.now();
  const stalledWrite = await client.callTool({
    name: 'interact_with_process',
    arguments: { pid, input, wait_for_prompt: false, timeout_ms: 0 },
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(stalledWrite.isError, true, JSON.stringify(stalledWrite));
  assert.match(JSON.stringify(stalledWrite), /Input delivery is unknown/i);
  assert.ok(elapsedMs >= 800 && elapsedMs < 6000, `write timed out after ${elapsedMs} ms`);

  const secondWrite = await client.callTool({
    name: 'interact_with_process',
    arguments: { pid, input, wait_for_prompt: false, timeout_ms: 0 },
  });
  assert.equal(secondWrite.isError, true, JSON.stringify(secondWrite));
  assert.match(JSON.stringify(secondWrite), /Previous process stdin write is still pending/i);
  assert.match(JSON.stringify(secondWrite), /new input was not queued/i);

  const sessions = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.equal(sessions.isError, undefined, `${JSON.stringify(sessions)}\n${stderr()}`);
  assert.match(JSON.stringify(sessions), new RegExp(String(pid)));

  const stopped = await client.callTool({ name: 'force_terminate', arguments: { pid } });
  assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
  await waitForProcessGroupExit(pid);
});

test('a timed-out input blocks new writes until the original write drains', { timeout: 15000 }, async t => {
  const { root, client, stderr, trackProcessGroup } = await fixture(t);
  const resumeFile = path.join(root, 'consume-stdin');
  const code = `
    const fs = require('node:fs');
    let text = '';
    const waiting = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(resumeFile)})) return;
      clearInterval(waiting);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        text += chunk;
        for (let end; (end = text.indexOf('\\n')) >= 0;) {
          const line = text.slice(0, end);
          text = text.slice(end + 1);
          console.log('INPUT_LINE:' + (line.length > 100 ? line.length + ':' + /^x+$/.test(line) : line));
        }
      });
    }, 10);
    console.log('DEFERRED_STDIN_READY');
    setTimeout(() => process.exit(0), 12000);
  `;
  const started = await client.callTool({
    name: 'start_process',
    arguments: { command: `exec ${quote(process.execPath)} -e ${quote(code)}`, timeout_ms: 100 },
  });
  assert.equal(started.isError, undefined, `${JSON.stringify(started)}\n${stderr()}`);
  const pid = started.structuredContent?.pid;
  assert.ok(Number.isSafeInteger(pid), JSON.stringify(started));
  trackProcessGroup(pid);

  const waitForOutput = async expected => {
    let output = '';
    const deadline = Date.now() + 4000;
    do {
      const read = await client.callTool({ name: 'read_process_output', arguments: { pid, offset: -20, length: 20, timeout_ms: 0 } });
      assert.equal(read.isError, undefined, JSON.stringify(read));
      output = read.structuredContent?.output ?? '';
      if (output.includes(expected)) return output;
      await pause(20);
    } while (Date.now() < deadline);
    assert.fail(`Missing ${expected}: ${output}\n${stderr()}`);
  };
  await waitForOutput('DEFERRED_STDIN_READY');
  const inputSize = 2 * 1024 * 1024;
  const first = await client.callTool({
    name: 'interact_with_process',
    arguments: { pid, input: 'x'.repeat(inputSize), wait_for_prompt: false, timeout_ms: 0 },
  });
  assert.equal(first.isError, true, JSON.stringify(first));
  assert.match(JSON.stringify(first), /Input delivery is unknown/i);

  const second = await client.callTool({
    name: 'interact_with_process',
    arguments: { pid, input: 'MUST_NOT_BE_QUEUED', wait_for_prompt: false, timeout_ms: 0 },
  });
  assert.equal(second.isError, true, JSON.stringify(second));
  assert.match(JSON.stringify(second), /Previous process stdin write is still pending/i);
  fs.writeFileSync(resumeFile, 'consume');
  await waitForOutput(`INPUT_LINE:${inputSize}:true`);

  const afterDrain = await client.callTool({
    name: 'interact_with_process',
    arguments: { pid, input: 'AFTER_DRAIN', wait_for_prompt: false, timeout_ms: 0 },
  });
  assert.equal(afterDrain.isError, undefined, `${JSON.stringify(afterDrain)}\n${stderr()}`);
  const output = await waitForOutput('INPUT_LINE:AFTER_DRAIN');
  assert.doesNotMatch(output, /MUST_NOT_BE_QUEUED/);
  assert.equal(output.split(`INPUT_LINE:${inputSize}:true`).length - 1, 1);
  const stopped = await client.callTool({ name: 'force_terminate', arguments: { pid } });
  assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
  await waitForProcessGroupExit(pid);
});

async function waitForProcessGroupExit(pid) {
  for (let attempt = 0; attempt < 40 && processGroupExists(pid); attempt++) await pause(25);
  assert.equal(processGroupExists(pid), false, `process group ${pid} did not exit`);
}
