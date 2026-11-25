import os from 'node:os';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath}from'node:url';
const runtime=path.dirname(fileURLToPath(import.meta.url)),pause=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-cancel-'));const child=spawn(process.execPath,[path.join(runtime,'server.mjs')],{env:{HOME:root,PATH:process.env.PATH,SANDBOX_COMMANDER_STATE_DIR:root+'/state',SANDBOX_WORKBENCH_SYNC_FILE:root+'/events.jsonl'},stdio:['pipe','pipe','pipe']});
  let tail='',next=100,parseError;const replies=new Map();child.stderr.on('data',()=>{});child.stdout.on('data',d=>{tail+=d;for(let i;(i=tail.indexOf('\n'))>=0;){const line=tail.slice(0,i);tail=tail.slice(i+1);try{const response=JSON.parse(line);replies.set(response.id,response);}catch(e){parseError=e;}}});
  const stopped=()=>child.exitCode!==null||child.signalCode!==null;
  const until=async(fn,ms=4000)=>{const end=Date.now()+ms;while(Date.now()<end){if(parseError)throw parseError;if(fn())return;await pause(5);}throw Error('Timed out waiting for isolated fixture');};
  t.after(async()=>{if(!stopped()){child.stdin.end();try{await until(stopped);}catch{child.kill('SIGKILL');await until(stopped);}}fs.rmSync(root,{recursive:true,force:true});});
  const send=(method,params,id=next++)=>{child.stdin.write(JSON.stringify({jsonrpc:'2.0',...(id===null?{}:{id}),method,params})+'\n');return id;};
  const wait=async id=>{await until(()=>replies.has(id));return replies.get(id);};
  const request=(name,args,id)=>send('tools/call',{name,arguments:args,_meta:{'openai/session':'cancel-test'}},id);
  const call=async(name,args)=>{const r=await wait(request(name,args));assert.ok(r.result&&!r.result.isError,JSON.stringify(r));return r.result;};
  await wait(send('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'cancel-test',version:'1'}}));send('notifications/initialized',{},null);
  const journal=()=>{try{return fs.readFileSync(root+'/state/runtime-events.jsonl','utf8').trim().split('\n').map(JSON.parse);}catch{return[];}};
  return{root,child,replies,send,wait,request,call,until,stopped,journal};
}
test('real cancellation releases the reader and preserves output for normal, zero and empty IDs',{timeout:20000},async t=>{
  const f=await fixture(t);const code="console.log('READY');require('readline').createInterface({input:process.stdin}).on('line',x=>{if(x==='EXIT')process.exit(0);else console.log(x)});";
  const pid=(await f.call('start_process',{command:`exec ${quote(process.execPath)} -e ${quote(code)}`,timeout_ms:100})).structuredContent.pid;
  let n=0;
  for(const id of ['cancel-string',0,'']){
    const reader_id='reader-'+n;await f.call('read_process_output',{pid,reader_id,timeout_ms:0});
    f.request('read_process_output',{pid,reader_id,timeout_ms:5000},id);await pause(30);f.send('notifications/cancelled',{requestId:id,reason:'test'},null);
    await f.until(()=>f.journal().filter(x=>x.event==='read_cancelled').length===n+1);
    const retry=await f.call('read_process_output',{pid,reader_id,timeout_ms:0});assert.equal(retry.structuredContent.output,'');
    const marker='AFTER_CANCEL_'+n;await f.call('interact_with_process',{pid,input:marker,wait_for_prompt:false,timeout_ms:0});
    assert.equal((await f.call('read_process_output',{pid,reader_id,timeout_ms:500})).structuredContent.output,marker+'\n');assert.equal(f.replies.has(id),false);n++;
  }
  const reader_id='unknown-cancel';await f.call('read_process_output',{pid,reader_id,timeout_ms:0});const pending=f.request('read_process_output',{pid,reader_id,timeout_ms:1000});
  f.send('notifications/cancelled',{requestId:'not-pending'},null);await f.call('interact_with_process',{pid,input:'UNRELATED',wait_for_prompt:false,timeout_ms:0});assert.equal((await f.wait(pending)).result.structuredContent.output,'UNRELATED\n');
  await f.call('interact_with_process',{pid,input:'EXIT',wait_for_prompt:false,timeout_ms:0});
});
test('discovery IDs 0 and openai-mcp-discover do not block an in-flight read',{timeout:12000},async t=>{
  const f=await fixture(t);const code="require('readline').createInterface({input:process.stdin}).on('line',x=>console.log(x));";
  const pid=(await f.call('start_process',{command:`exec ${quote(process.execPath)} -e ${quote(code)}`,timeout_ms:50})).structuredContent.pid;
  const read=f.request('read_process_output',{pid,reader_id:'waiting',timeout_ms:1500});
  await f.wait(f.send('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rediscovery',version:'1'}},0));
  const tools=await f.wait(f.send('tools/list',{},'openai-mcp-discover'));assert.ok(tools.result.tools.some(x=>x.name==='read_process_output'));
  await f.call('interact_with_process',{pid,input:'STILL_LIVE',wait_for_prompt:false,timeout_ms:0});assert.equal((await f.wait(read)).result.structuredContent.output,'STILL_LIVE\n');assert.equal(f.journal().some(x=>x.event==='shutdown_started'),false);
});
for(const reason of ['stdin_end','sigterm','stdout_error'])test('lifecycle records '+reason+' without affecting other processes',{timeout:10000},async t=>{
  const f=await fixture(t);
  if(reason==='stdin_end')f.child.stdin.end();else if(reason==='sigterm')f.child.kill('SIGTERM');else{f.child.stdout.destroy();f.send('ping',{});}
  await f.until(f.stopped);const journal=f.journal();assert.equal(journal.find(x=>x.event==='shutdown_started')?.reason,reason);assert.equal(journal.at(-1).event,'shutdown_finished');assert.equal(journal.some(x=>x.event==='parent_restart_requested'),false);
});
