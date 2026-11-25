import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createLocalWorkbench, parseArgs } from './local-workbench-server.mjs';
import { appendSyncEvent, readSyncEvents } from './chat-sync.mjs';
import { resolvePaths } from '../../lib/paths.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-monitor-test-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  return dir;
}

test('monitor has minimal CLI options and does not open project directories', () => {
  assert.deepEqual(parseArgs(['--port','0']), { port:0, open:false });
  assert.equal(parseArgs(['--open']).open, true);
  assert.throws(() => parseArgs(['--cwd','/example/project']), /Unsupported monitor option/);
  assert.throws(() => parseArgs(['--port','99999']), /Invalid.*port/);
});

test('monitor and Commander activity defaults honor the product home and explicit file override', t => {
  const home = fixture(t);
  const moduleURL = new URL('./chat-sync.mjs', import.meta.url).href;
  const readDefault = env => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {CHAT_SYNC_FILE} from ${JSON.stringify(moduleURL)};process.stdout.write(CHAT_SYNC_FILE);`], { env, encoding:'utf8' });
  const env = { HOME:home, PATH:process.env.PATH, SANDBOX_MCP_HOME:path.join(home,'custom-product-home') };
  assert.equal(readDefault(env), path.join(resolvePaths({env,home}).stateDir,'chat-sync','events.jsonl'));
  const explicit = path.join(home,'explicit','events.jsonl');
  assert.equal(readDefault({...env,SANDBOX_WORKBENCH_SYNC_FILE:explicit}), explicit);
  assert.equal(fs.existsSync(path.join(home,'custom-product-home')),false,'importing monitor configuration does not create state');
});

test('local monitor GET is read-only, token-protected and has no editor, terminal or AI API', async t => {
  const dir = fixture(t);
  const file = path.join(dir,'events.jsonl');
  const app = createLocalWorkbench({ syncFile:file });
  t.after(async()=>app.close());
  const url = new URL(await app.listen());
  const base = url.origin;
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.match(token,/^[a-f0-9]{64}$/);
  assert.equal(url.hostname,'127.0.0.1');

  const page=await fetch(base+'/');
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Sandbox Monitor/);
  assert.match(html,/仅记录 Sandbox MCP for test/);
  assert.match(html,/实际 Token 用量/);
  assert.match(html,/不可获取/);
  assert.match(html,/公开思路概要/);
  assert.match(html,/MCP P50 耗时/);
  assert.doesNotMatch(html,/<textarea|<form|\/api\/tool|\/api\/ai\/|window\.openai|callTool/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  new vm.Script(script);

  assert.equal((await fetch(base+'/api/sync')).status,403);
  assert.equal((await fetch(base+'/api/sync',{headers:{'x-local-workbench-token':'invalid'}})).status,403);
  const forbiddenHost=await new Promise((resolve,reject) => {
    http.get(base+'/',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);
  });
  assert.equal(forbiddenHost,421);
  const pre = await (await fetch(base+'/api/sync',{headers:{'x-local-workbench-token':token}})).json();
  assert.deepEqual(pre.events,[]);

  const beforeExists = fs.existsSync(file);
  for (const route of ['/api/tool','/api/ai/turn','/api/ai/approve','/api/events','/api/sync']) {
    const response=await fetch(base+route,{
      method:'POST',
      headers:{origin:base,'x-local-workbench-token':token,'content-type':'application/json'},
      body:JSON.stringify({name:'write_file',content:'malicious'})
    });
    assert.equal(response.status,404,route);
  }
  assert.equal(fs.existsSync(file),beforeExists,'monitor did not create a journal');
  assert.equal((await fetch(base+'/api/sync?after='+ 'x'.repeat(129), {
    headers:{'x-local-workbench-token':token}
  })).status,400);
});

test('independent writer events become readable from monitor without any Chat/API credentials', async t => {
  const dir=fixture(t), journal=path.join(dir,'private','events.jsonl');
  const app=createLocalWorkbench({syncFile:journal});
  t.after(async()=>app.close());
  const url = new URL(await app.listen()), base=url.origin;
  const token=new URLSearchParams(url.hash.slice(1)).get('token');
  const get=async (after='')=>{
    const response=await fetch(base+'/api/sync?after='+encodeURIComponent(after),{
      headers:{'x-local-workbench-token':token}
    });
    assert.equal(response.status,200);
    return response.json();
  };
  // A separate local process stands in for an MCP server publishing an event.
  const moduleUrl=new URL('./chat-sync.mjs',import.meta.url).href;
  execFileSync(process.execPath,['--input-type=module','-e',
    "import {appendSyncEvent} from "+JSON.stringify(moduleUrl)+"; appendSyncEvent({source:'chat_mcp',kind:'tool',name:'read_file',status:'ok'},process.argv[1]);",
    journal
  ],{timeout:10000});
  const progress=appendSyncEvent({
    source:'chat_mcp',kind:'progress',text:'Chat 明确共享的阶段结论'
  },journal);
  const operation='11111111-2222-4333-8444-555555555555';
  const began=appendSyncEvent({source:'chat_mcp',kind:'tool',name:'start_process',status:'started',operation},journal);
  const failed=appendSyncEvent({source:'chat_mcp',kind:'tool',name:'start_process',status:'error',operation,duration_ms:245},journal);
  appendSyncEvent({source:'local_app',kind:'tool',name:'workbench_save_file',status:'ok'},journal);
  const first=await get();
  assert.equal(first.events.length,4);
  assert.ok(first.events.some(e=>e.kind==='tool' && e.name==='read_file' && e.status==='ok'));
  assert.ok(first.events.some(e=>e.id===progress.id && e.text==='Chat 明确共享的阶段结论'));
  assert.ok(first.events.some(e=>e.id===began.id && e.status==='started' && e.operation===operation));
  assert.ok(first.events.some(e=>e.id===failed.id && e.status==='error' && e.operation===operation && e.duration_ms===245));
  const next=await get(first.cursor);
  assert.deepEqual(next.events,[]);
  assert.equal(fs.statSync(journal).mode&0o777,0o600);
});

test('journal contains tool name and state only; shared text needs explicit publish', t=>{
  const root=fixture(t),journal=path.join(root,'events.jsonl');
  const tool=appendSyncEvent({source:'chat_mcp',kind:'tool',name:'read_file',status:'ok',session:'session-1'},journal);
  assert.equal(tool.text,undefined);
  assert.equal(tool.session.length,16);
  assert.equal(tool.path,undefined);
  const summary=appendSyncEvent({source:'chat_mcp',kind:'approach',text:'公开的判断思路：优先检查工具边界，不包含隐藏推理'},journal);
  const all=readSyncEvents({limit:10},journal);
  assert.deepEqual(all.events.map(e=>e.id),[tool.id,summary.id]);
  assert.deepEqual(readSyncEvents({after:summary.id,limit:10},journal).events,[]);
  assert.throws(()=>appendSyncEvent({source:'chat_mcp',kind:'final',text:'x'.repeat(8001)},journal),/8000/);
});
