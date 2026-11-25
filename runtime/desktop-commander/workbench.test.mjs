import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WORKBENCH_URI, SERVER_INSTANCE, MAX_TEXT_BYTES, listDirectory, readText, saveText, gitChanges, terminalSnapshot, workbenchResource } from './workbench.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const text = result => result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-workbench-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('directory pagination is bounded, hidden files opt in, names remain data', t => {
  const root = fixture(t); fs.mkdirSync(path.join(root,'folder'));
  for (const name of ['a.txt', 'b.txt', '.secret', '<img onerror=alert(1)>.txt']) fs.writeFileSync(path.join(root,name),'hello');
  const first = listDirectory({ path:root, limit:2 }); assert.equal(first.entries.length,2); assert.equal(first.entries[0].type,'directory'); assert.equal(first.total,4); assert.equal(first.next_offset,2);
  const second = listDirectory({ path:root, offset:2, limit:2 }); assert.equal(second.next_offset,null); assert.ok(!second.entries.some(e=>e.name.startsWith('.')));
  assert.equal(listDirectory({path:root,show_hidden:true}).total,5);
  assert.throws(()=>listDirectory({path:'relative'}),/绝对/); assert.throws(()=>listDirectory({path:root,limit:999999}),/整数/);
});
test('exact UTF-8 BOM/CRLF, empty-file creation, permission preservation and save conflicts', t => {
  const root = fixture(t), file = path.join(root,'source.txt');
  const source = '\uFEFFfirst\r\nsecond\r\n'; fs.writeFileSync(file,source,{mode:0o640}); fs.chmodSync(file,0o640); // umask may mask requested fixture mode
  const read = readText({path:file}); assert.equal(read.content,source); assert.equal(read.newline,'CRLF');
  const saved = saveText({path:file,content:source+'third\r\n',expected_version:read.version}); assert.equal(saved.saved,true); assert.equal(fs.statSync(file).mode & 0o777,0o640); assert.equal(fs.readFileSync(file,'utf8'),source+'third\r\n');
  fs.writeFileSync(file,'external editor');
  assert.throws(()=>saveText({path:file,content:'lost update',expected_version:saved.version}),/其他编辑器/); assert.equal(fs.readFileSync(file,'utf8'),'external editor');
  const created = path.join(root,'empty.txt'); assert.equal(saveText({path:created,content:'',expected_version:null}).bytes,0);
  assert.throws(()=>saveText({path:created,content:'overwrite',expected_version:null}),/已存在/); assert.equal(fs.readFileSync(created,'utf8'),'');
  assert.throws(()=>saveText({path:file,content:'x',expected_version:'invalid'}),/版本/);
  assert.deepEqual(fs.readdirSync(root).sort(),['empty.txt','source.txt']);
});
test('binary/oversize/special files and linked-file writes fail without mutation', t => {
  const root = fixture(t), file = path.join(root,'plain.txt'); fs.writeFileSync(file,'initial');
  fs.writeFileSync(path.join(root,'binary'),Buffer.from([0,1,2])); fs.writeFileSync(path.join(root,'invalid'),Buffer.from([0xff])); fs.writeFileSync(path.join(root,'big'),Buffer.alloc(MAX_TEXT_BYTES+1,97));
  for (const name of ['binary','invalid','big']) assert.throws(()=>readText({path:path.join(root,name)}));
  assert.throws(()=>readText({path:root}),/普通文件/);
  const version = readText({path:file}).version; fs.symlinkSync(file,path.join(root,'symbolic')); fs.linkSync(file,path.join(root,'hard'));
  assert.throws(()=>saveText({path:path.join(root,'symbolic'),content:'changed',expected_version:version}),/普通文件/);
  assert.throws(()=>saveText({path:file,content:'changed',expected_version:version}),/普通文件/);
  assert.throws(()=>saveText({path:path.join(root,'new'),content:'\ud800',expected_version:null}),/UTF-8/);
  assert.equal(fs.readFileSync(file,'utf8'),'initial'); assert.equal(fs.existsSync(path.join(root,'new')),false);
});
test('Git staged/unstaged and null-separated unusual paths are accurate, no repository is explicit', t => {
  const root = fixture(t); assert.equal(gitChanges({cwd:root}).is_repository,false);
  execFileSync('git',['init','--quiet','--template=','--initial-branch=main',root]);
  const name = 'space and\nnewline.txt'; fs.writeFileSync(path.join(root,name),'staged\n');
  execFileSync('git',['-C',root,'add','--',name]); fs.writeFileSync(path.join(root,name),'unstaged\n');
  const changes = gitChanges({cwd:root}); assert.equal(changes.entries[0].name,name); assert.equal(changes.entries[0].status,'AM'); assert.match(changes.staged,/\+staged/); assert.match(changes.unstaged,/\+unstaged/);
});
test('terminal snapshots use tail reads and preserve all active sessions; restart mismatch fails closed', () => {
  let offset;
  const manager = { listActiveSessions:()=>[{pid:23,runtime:10}], listCompletedSessions:()=>Array.from({length:100},(_,i)=>({pid:i+100,exitCode:0,startTime:0,endTime:100})), readOutputPaginated:(pid,o)=>{offset=o;return{lines:['hello'],totalLines:700,isComplete:false,readFrom:200,evictedLines:0};} };
  const snapshot = terminalSnapshot({pid:23,tail_lines:500,instance:SERVER_INSTANCE},manager); assert.equal(offset,-500); assert.equal(snapshot.running,true); assert.equal(snapshot.output,'hello'); assert.equal(snapshot.truncated,true); assert.ok(snapshot.sessions.some(s=>s.pid===23)); assert.equal(snapshot.sessions.length,100);
  assert.throws(()=>terminalSnapshot({instance:'old'},manager),/重启/);
});
test('terminal snapshots bound giant lines and preserve the exact Unicode-safe suffix', () => {
  const limit = 128 * 1024;
  for (const lines of [
    ['x'.repeat(1024 * 1024) + 'END'],
    ['😀' + 'x'.repeat(limit - 1)],
    ['x'.repeat(limit), 'middle', '😀END'],
    ['short', '😀END'],
  ]) {
    const manager = {
      listActiveSessions: () => [{ pid: 23, runtime: 10 }], listCompletedSessions: () => [],
      readOutputPaginated: () => ({ lines, totalLines: lines.length, isComplete: false, readFrom: 0, evictedLines: 0 }),
    };
    const whole = lines.join('\n');
    let start = Math.max(0, whole.length - limit);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(whole[start]) && /[\uD800-\uDBFF]/.test(whole[start - 1])) start++;
    const result = terminalSnapshot({ pid: 23, tail_lines: 500 }, manager);
    assert.equal(result.output, whole.slice(start));
    assert.ok(result.output.length <= limit);
    assert.ok(result.output.isWellFormed());
    assert.equal(result.omitted_prefix_chars, start);
    assert.equal(result.truncated, start > 0);
  }
});
test('UI resource is self-contained, valid script, escaped, and uses standard bridge metadata', () => {
  const resource = workbenchResource().contents[0]; assert.equal(resource.uri,WORKBENCH_URI); assert.equal(resource.mimeType,'text/html;profile=mcp-app'); assert.deepEqual(resource._meta.ui.csp.connectDomains,[]);
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|\bfetch\(/i.test(resource.text));
  const script = resource.text.match(/<script>([\s\S]*)<\/script>/)?.[1]; assert.ok(script); new vm.Script(script);
  assert.match(script,/ui\/initialize/); assert.match(script,/ui\/message/); assert.match(script,/event\.source !== window\.parent/);
});
async function mcpFixture(t) {
  const root = fixture(t), client = new Client({name:'workbench-test',version:'1'},{});
  const transport = new StdioClientTransport({ command:process.execPath, args:[fileURLToPath(new URL('./server.mjs',import.meta.url))], env:{ HOME:process.env.HOME, PATH:process.env.PATH, SANDBOX_COMMANDER_STATE_DIR:path.join(root,'state'), SANDBOX_WORKBENCH_SYNC_FILE:path.join(root,'sync','events.jsonl') }, stderr:'pipe' });
  let stderr = ''; transport.stderr?.on('data',d=>{stderr+=d;});
  await client.connect(transport); t.after(()=>client.close());
  const call = async (name,args={}) => {const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,`${name}: ${text(result)}\n${stderr}`);return result;};
  return {root,client,call};
}
test('actual stdio resource discovery, read/create/edit/version conflict and old tools coexist', {timeout:20000}, async t => {
  const {root,client,call}=await mcpFixture(t);
  const tools=(await client.listTools()).tools; assert.equal(tools.length,27); const open=tools.find(t=>t.name==='open_workbench'); assert.equal(open._meta.ui.resourceUri,WORKBENCH_URI); assert.equal(open._meta['openai/outputTemplate'],WORKBENCH_URI); assert.equal(open.annotations.readOnlyHint,true);
  for (const tool of tools) assert.equal(tool._meta['openai/widgetAccessible'],true);
  assert.equal((await client.listResources()).resources[0].uri,WORKBENCH_URI); assert.match((await client.readResource({uri:WORKBENCH_URI})).contents[0].text,/Sandbox 本机工作台/);
  await assert.rejects(()=>client.readResource({uri:'ui://other'}));
  const state=(await call('open_workbench',{cwd:root})).structuredContent; assert.equal(state.cwd,fs.realpathSync(root));
  const file=path.join(root,'hello.txt'); const created=(await call('workbench_save_file',{path:file,content:'hello\n',expected_version:null})).structuredContent; assert.ok(created.saved);
  const read=(await call('workbench_read_file',{path:file})).structuredContent; assert.equal(read.content,'hello\n');
  await call('workbench_save_file',{path:file,content:'changed\n',expected_version:read.version});
  const conflict=await client.callTool({name:'workbench_save_file',arguments:{path:file,content:'lost',expected_version:read.version}}); assert.equal(conflict.isError,true); assert.equal(fs.readFileSync(file,'utf8'),'changed\n');
  const invalid=await client.callTool({name:'open_workbench',arguments:{cwd:root,unexpected:true}}); assert.equal(invalid.isError,true);
  assert.match(text(await call('read_file',{path:file})),/changed/);
});
test('actual command snapshots show incremental output, nonzero exit and managed cancellation', {timeout:20000}, async t => {
  const {root,call}=await mcpFixture(t); const open=(await call('open_workbench',{cwd:root})).structuredContent;
  const start=await call('start_process',{command:`${quote(process.execPath)} -e ${quote("console.log('BEGIN');setTimeout(()=>{console.log('END');process.exit(7)},500)")}`,timeout_ms:20});
  const pid=start.structuredContent?.pid; assert.ok(pid,text(start));
  let snapshot;
  for(let i=0;i<30;i++){snapshot=(await call('workbench_terminal_snapshot',{pid,instance:open.instance})).structuredContent;if(!snapshot.running)break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(snapshot.exit_code,7); assert.match(snapshot.output,/BEGIN/); assert.match(snapshot.output,/END/);
  const active=await call('start_process',{command:'sleep 90 & wait',timeout_ms:20}); const livePid=active.structuredContent.pid;
  assert.equal((await call('workbench_terminal_snapshot',{pid:livePid,instance:open.instance})).structuredContent.running,true);
  await call('force_terminate',{pid:livePid});
  assert.equal((await call('workbench_terminal_snapshot',{pid:livePid,instance:open.instance})).structuredContent.running,false);
  const stale=await call('workbench_terminal_snapshot',{instance:open.instance}); assert.equal(stale.structuredContent.instance,open.instance);
});

test('standard MCP Apps bridge sends a valid ui/message content-block array', async () => {
  // Exercise the actual embedded script, not merely a regex on the source.
  const outbound = [], handlers = new Map(), nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', textContent: '', dataset: {}, disabled: false, children: [],
      addEventListener() {}, prepend() {}, append() {}, replaceChildren() {},
    });
    return nodes.get(id);
  };
  const parent = { postMessage(message) {
    outbound.push(message);
    if (message.method === 'ui/initialize' || message.method === 'ui/message') {
      queueMicrotask(() => handlers.get('message')({
        source: parent, origin: 'https://chatgpt.com',
        data: { jsonrpc: '2.0', id: message.id,
          result: message.method === 'ui/initialize'
            ? { protocolVersion: '2026-01-26', hostContext: {}, hostCapabilities: {}, hostInfo: { name: 'fixture', version: '1' } }
            : {} },
      }));
    }
  } };
  const window = { parent, addEventListener(type, cb) { handlers.set(type, cb); } };
  const document = {
    getElementById: element, querySelectorAll: () => [], addEventListener() {},
    documentElement: { scrollHeight: 640 }, body: {},
    createElement: () => ({ textContent: '', className: '', append() {} }),
  };
  vm.runInNewContext(fs.readFileSync(new URL('./workbench-ui.mjs', import.meta.url), 'utf8'), {
    window, document, setTimeout, clearTimeout, queueMicrotask, Date, Map, Set, Math, JSON,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(outbound.some(m => m.method === 'ui/notifications/initialized'), 'standard handshake completed');
  element('chat-prompt').value = '检查当前项目';
  element('chat-form').onsubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const sent = outbound.find(m => m.method === 'ui/message');
  assert.ok(sent, 'workbench emitted ui/message');
  assert.equal(sent.params.role, 'user');
  assert.equal(Array.isArray(sent.params.content), true, 'MCP Apps ui/message requires ContentBlock[]');
  assert.equal(sent.params.content.length, 1);
  assert.equal(sent.params.content[0].type, 'text');
  assert.match(sent.params.content[0].text, /检查当前项目/);
  assert.equal(element('chat-prompt').value, '');
});

test('stdio MCP publishes explicit Chat progress and mirrors tool status to local journal', {timeout:45000}, async t => {
  const {root,client,call} = await mcpFixture(t);
  const syncPath=path.join(root,'sync','events.jsonl');
  const published=(await call('workbench_sync_publish',{
    kind:'progress',text:'来自普通 Chat 的共享进度'
  })).structuredContent;
  assert.equal(published.published,true);
  assert.ok(fs.existsSync(syncPath));
  const listed=await call('workbench_list_directory',{path:root,limit:1});
  assert.ok(listed.structuredContent.entries.length>=1);
  const publicApproach=(await call('workbench_sync_publish',{
    kind:'approach',text:'公开思路概要：先检查最小失败边界，不包含内部思考过程'
  })).structuredContent;
  const all=(await call('workbench_sync_status',{limit:20})).structuredContent.events;
  assert.ok(all.some(event=>event.id===published.id && event.text==='来自普通 Chat 的共享进度'));
  assert.ok(all.some(event=>event.id===publicApproach.id && event.kind==='approach'));
  const lifecycle=all.filter(event=>event.kind==='tool' && event.name==='workbench_list_directory');
  assert.equal(lifecycle.length,2,'one logical tool call has start and completion');
  assert.equal(lifecycle[0].status,'started');
  assert.equal(lifecycle[1].status,'ok');
  assert.equal(lifecycle[0].operation,lifecycle[1].operation);
  assert.match(lifecycle[0].operation,/^[0-9a-f-]{36}$/);
  assert.equal(lifecycle[0].duration_ms,undefined);
  assert.ok(Number.isSafeInteger(lifecycle[1].duration_ms) && lifecycle[1].duration_ms>=0);
  assert.equal(fs.statSync(syncPath).mode & 0o777,0o600);
  const invalid=await client.callTool({name:'workbench_sync_publish',arguments:{kind:'not-supported',text:'should not appear'}});
  assert.equal(invalid.isError,true);
});
