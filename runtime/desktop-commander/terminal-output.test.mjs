import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTerminalOutputReader } from './terminal-output.mjs';
const text = r => r.content?.map(c => c.text ?? '').join('\n') ?? '';
const pause = ms => new Promise(r => setTimeout(r, ms));
function fake(options = {}) {
  const active = new Map(), completed = new Map();
  const manager = { getSession: pid => active.get(pid), listActiveSessions: () => [...active.values()], listCompletedSessions: () => [...completed.values()] };
  const make = (pid = 42, start = 1000) => { const s = { pid, startTime: new Date(start), outputLines: [], evictedChars: 0 }; active.set(pid, s); completed.delete(pid); return s; };
  const append = (s, value) => { s.outputLines = (s.outputLines.join('\n') + value).split('\n'); };
  const finish = (s, code = 0) => { active.delete(s.pid); completed.set(s.pid, { ...s, outputLines: [...s.outputLines], endTime: new Date(), exitCode: code }); };
  const read = createTerminalOutputReader(manager, { instance: 'test-instance', ...options });
  const call = (args = {}, session = 'chat-A') => read({ pid: 42, timeout_ms: 0, ...args }, session);
  return { active, completed, manager, make, append, finish, read, call };
}
test('separate Chat identities and same-chat readers each receive the full stream', async () => {
  const f = fake(), s = f.make(); f.append(s, 'one\ntwo\n');
  for (const [session, reader_id] of [['A','same'], ['B','same'], ['A','other']]) assert.equal((await f.call({reader_id}, session)).structuredContent.output, 'one\ntwo\n');
  assert.equal((await f.call({reader_id:'same'}, 'A')).structuredContent.output, '');
});
test('empty, partial, newline, then appended lines are delivered without loss or duplicates', async () => {
  const f = fake(), s = f.make(); assert.equal((await f.call()).structuredContent.output, '');
  for (const fragment of ['par', 'tial', '\n', 'next\n', 'last']) {
    f.append(s, fragment); assert.equal((await f.call()).structuredContent.output, fragment);
    assert.equal((await f.call()).structuredContent.output, '');
  }
});
test('line budget, Unicode and completion keep exact character continuation', async () => {
  const f = fake(), s = f.make(); f.append(s, '甲😀\nβ\nlast');
  assert.equal((await f.call({length:1})).structuredContent.output, '甲😀\n');
  assert.equal((await f.call({length:1})).structuredContent.output, 'β\n');
  f.finish(s, 7);
  assert.equal((await f.call({length:1})).structuredContent.output, 'last');
  const end = (await f.call()).structuredContent; assert.equal(end.output, ''); assert.equal(end.exit_code,7); assert.equal(end.running,false);
});
test('stateless cursor replays and continues; wrong process/instance cursors are rejected', async () => {
  const f = fake(), s = f.make(); f.append(s, 'one\ntwo\n');
  const first = (await f.call({cursor:'start',length:1})).structuredContent;
  assert.equal(first.output,'one\n');
  assert.equal((await f.call({cursor:'start',length:1})).structuredContent.output,'one\n');
  assert.equal((await f.call({cursor:first.next_cursor})).structuredContent.output,'two\n');
  const bad = JSON.parse(Buffer.from(first.next_cursor,'base64url').toString()); bad.instance='other';
  await assert.rejects(f.call({cursor:Buffer.from(JSON.stringify(bad)).toString('base64url')}),/another process or server/);
  f.make(42, 2000); await assert.rejects(f.call({cursor:first.next_cursor}),/another process or server/);
});
test('no identity tail and explicit line offsets never consume incremental positions', async () => {
  const f=fake(), s=f.make(); f.append(s,'one\ntwo\n');
  const a=await f.read({pid:42},undefined), b=await f.read({pid:42},undefined);
  assert.equal(a.structuredContent.mode,'stateless_tail'); assert.equal(a.structuredContent.output,b.structuredContent.output);
  await f.call({offset:-3},'fresh'); await f.call({offset:1,length:1},'fresh');
  assert.equal((await f.call({},'fresh')).structuredContent.output,'one\ntwo\n');
});
test('same-reader overlapping reads fail clearly; different readers do not block each other', async () => {
  const f=fake(), s=f.make(); const waiting=f.call({timeout_ms:200});
  await assert.rejects(f.call({timeout_ms:200}),/outstanding read/);
  const other=f.call({timeout_ms:200},'B'); setTimeout(()=>f.append(s,'wake\n'),20);
  assert.equal((await waiting).structuredContent.output,'wake\n'); assert.equal((await other).structuredContent.output,'wake\n');
});
test('completion ends pending wait early, and PID reuse starts a new reader stream', async () => {
  const f=fake(), s=f.make(); const started=Date.now(), pending=f.call({timeout_ms:1000});
  setTimeout(()=>f.finish(s,0),20); assert.equal((await pending).structuredContent.running,false); assert.ok(Date.now()-started<500);
  const next=f.make(42,2000); f.append(next,'new\n'); assert.equal((await f.call()).structuredContent.output,'new\n');
});
test('eviction reports the exact unread gap and bounded reader state never silently resets', async () => {
  const f=fake({maxReaders:2}), s=f.make(); f.append(s,'old\nnew\n');
  s.outputLines.shift(); s.evictedChars=4;
  const r=(await f.call({},'A')).structuredContent; assert.equal(r.dropped_chars,4); assert.equal(r.output,'new\n');
  await f.call({},'B'); await assert.rejects(f.call({},'C'),/capacity/);
  assert.equal((await f.call({cursor:'start'},'C')).structuredContent.output,'new\n');
});
test('large partial lines are bounded and cursor continuation does not split emoji', async () => {
  const f=fake(), s=f.make(); const whole='x'.repeat(128*1024-1)+'😀tail';f.append(s,whole);
  const a=(await f.call()).structuredContent,b=(await f.call()).structuredContent;
  assert.ok(a.truncated);assert.equal(a.output+b.output,whole);assert.ok(!/[\uD800-\uDBFF]$/.test(a.output));
});
test('invalid parameters are rejected before changing a cursor', async () => {
  const f=fake();f.make();
  for(const args of [{length:0},{timeout_ms:-1},{pid:0},{reader_id:''},{cursor:'start',reader_id:'a'},{cursor:'start',offset:-1},{unknown:true}]) await assert.rejects(f.call(args));
});

test('cancelled output waits release the reader without consuming or resetting its position', async()=>{
  const f=fake(),s=f.make();f.append(s,'before\n');assert.equal((await f.call()).structuredContent.output,'before\n');
  const controller=new AbortController();const pending=f.read({pid:42,timeout_ms:5000},'chat-A',{signal:controller.signal});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});
  f.append(s,'after\n');assert.equal((await f.call()).structuredContent.output,'after\n');
  await assert.rejects(f.read({pid:42,timeout_ms:5000},'chat-A',{signal:controller.signal}),{name:'AbortError'});
  assert.equal((await f.call()).structuredContent.output,'');
});

test('oversized anonymous tails report omitted prefixes, not a nonexistent continuation', async () => {
  for (const whole of ['x'.repeat(128*1024+1), '😀'+'x'.repeat(128*1024-1)]) {
    const f=fake(), s=f.make(); f.append(s,whole);
    const first=await f.read({pid:42,timeout_ms:0}); const d=first.structuredContent;
    assert.equal(d.mode,'stateless_tail'); assert.equal(d.truncated,true); assert.equal(d.has_more,false);
    assert.equal(d.omitted_prefix_chars,whole.length-d.output.length); assert.ok(d.omitted_prefix_chars>0);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(d.output)); assert.match(text(first),/omitted.*earlier/); assert.doesNotMatch(text(first),/read the remain/);
    assert.equal((await f.call({cursor:d.next_cursor})).structuredContent.output,'');
    const replay=(await f.call({cursor:'start'})).structuredContent; assert.equal(replay.omitted_prefix_chars,0); assert.equal(replay.has_more,true);
    assert.equal(replay.output+(await f.call({cursor:replay.next_cursor})).structuredContent.output,whole);
  }
});

const quote = s => "'"+s.replaceAll("'","'\\''")+"'";
test('real isolated stdio dispatch scopes Chat metadata, supports explicit readers/cursors, and does not lose appended output', {timeout:30000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-reader-acceptance-'));
  const client=new Client({name:'reader-upgrade-test',version:'1'},{});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],env:{HOME:process.env.HOME,PATH:process.env.PATH,SANDBOX_COMMANDER_STATE_DIR:path.join(root,'state'),SANDBOX_WORKBENCH_SYNC_FILE:path.join(root,'events.jsonl')},stderr:'pipe'});
  let errors='';transport.stderr?.on('data',d=>{errors+=d;});
  await client.connect(transport);
  t.after(async()=>{await client.close();fs.rmSync(root,{recursive:true,force:true});});
  const call=async(name,args={},session)=>{const r=await client.callTool({name,arguments:args,...(session?{_meta:{'openai/session':session}}:{})});assert.ok(!r.isError,`${name}: ${text(r)} ${errors}`);return r;};
  const schema=(await client.listTools()).tools.find(t=>t.name==='read_process_output').inputSchema;
  assert.ok(schema.properties.reader_id);assert.ok(schema.properties.cursor);
  const code="const rl=require('readline').createInterface({input:process.stdin});console.log('READY');rl.on('line',x=>{if(x==='exit'){process.exit(0);}process.stdout.write(x==='partial'?'par':x==='suffix'?'tial\\n':x+'\\n');});";
  const start=await call('start_process',{command:`exec ${quote(process.execPath)} -e ${quote(code)}`,timeout_ms:100},'A');const pid=start.structuredContent.pid;
  const read=async(session,args={})=>(await call('read_process_output',{pid,timeout_ms:0,...args},session)).structuredContent;
  assert.equal((await read('A')).output,'READY\n');assert.equal((await read('B')).output,'READY\n');
  async function emit(input,suffix){await call('interact_with_process',{pid,input,wait_for_prompt:false,timeout_ms:100},'A');for(let i=0;i<40;i++){const s=(await call('workbench_terminal_snapshot',{pid,tail_lines:20},'A')).structuredContent;if(s.output.endsWith(suffix))return;await pause(10);}assert.fail('output not received');}
  for(const [input,output] of [['ONE','ONE\n'],['partial','par'],['suffix','tial\n'],['TWO','TWO\n']]){await emit(input,output);assert.equal((await read('A')).output,output);assert.equal((await read('B')).output,output);}
  assert.equal((await read('A',{reader_id:'second'})).output,'READY\nONE\npartial\nTWO\n');
  const first=await read('A',{cursor:'start',length:1});assert.equal(first.output,'READY\n');assert.equal((await read('B',{cursor:first.next_cursor})).output,'ONE\npartial\nTWO\n');
  await emit('exit','TWO\n');let final;for(let i=0;i<30;i++){final=await read('A');if(!final.running)break;await pause(20);}assert.equal(final.running,false);assert.equal(final.exit_code,0);assert.equal(final.output,'');
});
