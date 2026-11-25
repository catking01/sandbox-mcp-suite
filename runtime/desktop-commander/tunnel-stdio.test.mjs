import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultShell } from './platform.mjs';

// Real tunnel binary, loopback control plane, no account or network credentials.
// TUNNEL_CLIENT_BINARY=/absolute/path/tunnel-client node --test tunnel-stdio.test.mjs
const binary = process.env.TUNNEL_CLIENT_BINARY;
const runtime = path.dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const enabled = { skip: !binary, timeout: 20000 };

async function harness(t, { realServer = false, sendInitialized = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-tunnel-regression-'));
  const replies = new Map(), responseCounts = new Map(), expectedIds = new Map(), queue = [], traffic = [], logs = [], ownedGroups = new Set();
  let child, stopping = false, sequence = 0, pendingPoll;
  const httpServer = http.createServer(async (req, res) => {
    if (/\/poll(?:\?|$)/.test(req.url)) {
      if (!queue.length && !stopping) await Promise.race([pause(50), new Promise(resolve => { pendingPoll = resolve; })]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ commands: queue.splice(0) }));
      return;
    }
    if (/\/response$/.test(req.url)) {
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      responseCounts.set(data.request_id, (responseCounts.get(data.request_id) ?? 0) + 1);
      replies.set(data.request_id, data);
      res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}');
      return;
    }
    traffic.push({ method: req.method, path: req.url });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'tunnel_00000000000000000000000000000000', name: 'local-fixture', description: 'loopback-only' }));
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const controlURL = `http://127.0.0.1:${httpServer.address().port}`;
  const fixture = path.join(root, 'fixture.mjs');
  fs.writeFileSync(fixture, `import readline from 'node:readline';
import fs from 'node:fs';
const log = e => fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({at:Date.now(),pid:process.pid,...e})+'\\n');
const send = (id,result) => {log({event:'reply',id});process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');};
log({event:'startup'});
process.stdin.on('end',()=>{log({event:'stdin_end'});process.exit(0);});
process.stdout.on('error',error=>{log({event:'stdout_error',code:error.code});process.exit(1);});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);log({event:'request',id:q.id,method:q.method,marker:q.params?.arguments?.marker,name:q.params?.name});
 if(!Object.hasOwn(q,'id'))return;
 if(q.method==='initialize')return send(q.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if(q.method==='tools/list')return send(q.id,{tools:[{name:'echo',description:'fixture',inputSchema:{type:'object'}}]});
 if(q.method==='ping')return send(q.id,{});
 if(q.params?.name==='crash')return process.exit(7);
 const a=q.params?.arguments??{};
 setTimeout(()=>send(q.id,{content:[{type:'text',text:String(a.marker)}],structuredContent:{marker:a.marker,pid:process.pid}}),a.delay??0);
});
`);
  const env = {
    HOME: root, PATH: process.env.PATH,
    CONTROL_PLANE_API_KEY: 'local-fixture-only-not-a-credential',
    MCP_STDIO_FAILURE_POLICY: 'exit',
    FIXTURE_EVENTS: path.join(root, 'fixture.jsonl'),
    SANDBOX_COMMANDER_STATE_DIR: path.join(root, 'state'),
    SANDBOX_WORKBENCH_SYNC_FILE: path.join(root, 'events.jsonl'),
    NO_PROXY: '127.0.0.1,localhost',
  };
  let launchCwd=root, command=`${quote(process.execPath)} ${quote(fixture)}`;
  if (realServer) {
    launchCwd=path.join(root,'runtime','installation');
    fs.mkdirSync(launchCwd,{recursive:true}); fs.mkdirSync(path.join(root,'control'));
    // Match the deployed relative wrapper layout and clean child environment.
    const clean={HOME:root,PATH:process.env.PATH,SANDBOX_COMMANDER_STATE_DIR:env.SANDBOX_COMMANDER_STATE_DIR,SANDBOX_WORKBENCH_SYNC_FILE:env.SANDBOX_WORKBENCH_SYNC_FILE};
    fs.writeFileSync(path.join(root,'control','run-mcp-sanitized.sh'), '#!'+defaultShell()+'\nset -eu\nexec /usr/bin/env -i '+Object.entries(clean).map(([k,v])=>k+'='+quote(v)).join(' ')+' '+quote(process.execPath)+' '+quote(path.join(runtime,'server.mjs'))+'\n', {mode:0o700});
    command='../../control/run-mcp-sanitized.sh';
  }
  child = spawn(binary, ['run', '--control-plane.base-url', controlURL,
    '--control-plane.tunnel-id', 'tunnel_00000000000000000000000000000000',
    '--control-plane.max-inflight', '20', '--mcp.max-concurrent-requests', '10',
    '--mcp.connection-max-ttl', '5m', '--control-plane.poll-timeout', '1s',
    '--health.listen-addr', '127.0.0.1:0', '--health.url-file', path.join(root, 'health.url'),
    ...(sendInitialized ? ['--mcp.stdio-send-initialized-notification=true'] : []),
    '--log.format', 'json', '--mcp.command',
    `command=${command},channel=main`,
  ], { env, cwd:launchCwd, detached:true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => { out += data; let i; while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { logs.push(JSON.parse(line)); } catch { logs.push({ msg: line }); } } });
  child.stderr.on('data', data => { err += data; });
  child.on('error', error => { err += error.message; });
  const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return; await pause(10); }
    throw Error('Timed out; tunnel=' + JSON.stringify({ exitCode: child.exitCode, signalCode: child.signalCode,
      logs: logs.filter(x => /error|warn/i.test(x.level ?? '')).slice(0,6).map(x => ({ msg:x.msg, error:x.error })), stderr:err.slice(-1800), traffic }));
  };
  t.after(async () => {
    stopping = true; pendingPoll?.();
    const signalGroup = (pid, signal) => { try { process.kill(-pid,signal); } catch (error) { if (error.code!=='ESRCH') throw error; } };
    // Both the tunnel group and terminals below are created by this fixture.
    // Cleanup must not depend on the transport under test behaving correctly.
    for (const pid of ownedGroups) signalGroup(pid,'SIGTERM');
    signalGroup(child.pid,'SIGTERM');
    if (child.exitCode === null && child.signalCode === null) {
      try { await until(() => child.exitCode !== null || child.signalCode !== null, 3000); }
      catch { signalGroup(child.pid,'SIGKILL'); await until(() => child.exitCode !== null || child.signalCode !== null, 2000); }
    }
    for (const pid of ownedGroups) signalGroup(pid,'SIGKILL');
    signalGroup(child.pid,'SIGKILL');
    httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve));
    fs.rmSync(root, { recursive:true, force:true });
  });
  const submit = (method, params, { id = ++sequence, responseTimeout } = {}) => {
    const request_id = 'command-' + (++sequence);
    expectedIds.set(request_id,id);
    queue.push({ request_id, shard_token:'local-shard', command_type:'jsonrpc', channel:'main',
      created_at:new Date().toISOString(), headers:{}, ...(responseTimeout ? { response_timeout:responseTimeout } : {}),
      jsonrpc:{ jsonrpc:'2.0', ...(id === null ? {} : { id }), method, params },
    }); pendingPoll?.(); pendingPoll = undefined; return request_id;
  };
  const response = async (key, ms) => {
    await until(() => replies.has(key), ms);
    const r = replies.get(key);
    if (expectedIds.get(key)!==null) assert.equal(r.resp_json?.id,expectedIds.get(key),'RPC response ID must belong to its original caller');
    assert.equal(responseCounts.get(key),1,'one terminal result per command');
    return r;
  };
  const call = async (name, args = {}, options) => {
    const r = await response(submit('tools/call', { name, arguments:args }, options));
    assert.equal(r.resp_code, 200, JSON.stringify(r));
    assert.ok(r.resp_json?.result && !r.resp_json.result.isError, JSON.stringify(r));
    if (name==='start_process' && r.resp_json.result.structuredContent?.pid) ownedGroups.add(r.resp_json.result.structuredContent.pid);
    return r.resp_json.result;
  };
  const initialized = await response(submit('initialize', { protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'local-audit',version:'1'} }, {id:0}));
  assert.equal(initialized.resp_code,200,JSON.stringify({response:initialized,stderr:err}));
  await response(submit('notifications/initialized', {}, {id:null}));
  return { root, child, replies, responseCounts, logs, until, submit, response, call,
    events: () => fs.existsSync(env.FIXTURE_EVENTS) ? fs.readFileSync(env.FIXTURE_EVENTS,'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('actual tunnel preserves response ownership across overlapping stdio requests and repeated IDs', enabled, async t => {
  const f = await harness(t);
  const first = f.submit('tools/call', { name:'echo', arguments:{marker:'slow',delay:250} }, {id:11});
  await f.until(() => f.events().some(e => e.event==='request' && e.marker==='slow'));
  const fast=f.submit('tools/call',{name:'echo',arguments:{marker:'fast',delay:0}},{id:12});
  for (const [key,marker] of [[first,'slow'],[fast,'fast']]) {
    const r=await f.response(key); assert.equal(r.resp_code,200,JSON.stringify(r));
    assert.equal(r.resp_json?.result?.structuredContent?.marker,marker,JSON.stringify(r));
  }
  const rest = Array.from({length:20}, (_,i) => f.submit('tools/call', {name:'echo',arguments:{marker:'request-'+i,delay:i%3}}, {id:i%3===0 ? 0 : i%3===1 ? 'openai-mcp-discover' : 100+i}));
  for (const [key, marker] of rest.map((key,i)=>[key,'request-'+i])) {
    const r = await f.response(key);
    assert.equal(r.resp_code,200,JSON.stringify(r));
    assert.equal(r.resp_json?.result?.structuredContent?.marker,marker,JSON.stringify(r));
  }
  const last = await f.call('echo',{marker:'after-overlap'});
  assert.equal(new Set(f.events().map(e=>e.pid)).size,1);
  assert.equal(last.structuredContent.marker,'after-overlap');
  assert.equal(f.events().some(e=>e.event==='stdin_end'),false);
  assert.equal(f.logs.some(e=>e.msg==='Received response without valid ID'),false);
});

test('response deadline retires only its request and safely reuses its JSON-RPC ID', enabled, async t => {
  const f = await harness(t);
  const key = f.submit('tools/call',{name:'echo',arguments:{marker:'late',delay:350}},{id:'reused',responseTimeout:'100ms'});
  await f.until(()=>f.events().some(e=>e.event==='request'&&e.marker==='late'));
  await pause(160);
  // response_timeout describes the control-plane caller's expired budget:
  // v0.0.21 deliberately retires the request without posting another response.
  const after = await f.call('echo',{marker:'new-result',delay:700},{id:'reused'});
  assert.equal(after.structuredContent.marker,'new-result');
  assert.equal(f.replies.has(key),false);
  assert.equal((await f.call('echo',{marker:'still-alive'})).structuredContent.pid,after.structuredContent.pid);
  assert.equal(f.events().some(e=>e.event==='stdin_end'),false);
});

test('native stdio failure policy exits failed tunnel instead of reporting a dead child ready', enabled, async t => {
  const f = await harness(t);
  f.submit('tools/call',{name:'crash',arguments:{}},{id:'crash'});
  await f.until(()=>f.child.exitCode!==null || f.child.signalCode!==null);
  assert.ok(f.events().some(e=>e.event==='request'&&e.name==='crash'));
  assert.equal(f.child.signalCode,null);
  assert.notEqual(f.child.exitCode,0);
});

test('real Commander terminal survives a tunneled read timeout and remains controllable', enabled, async t => {
  const f = await harness(t,{realServer:true});
  const code = "console.log('READY');require('readline').createInterface({input:process.stdin}).on('line',x=>{console.log(x);if(x==='EXIT')process.exit(0);});";
  const started = await f.call('start_process',{command:`exec ${quote(process.execPath)} -e ${quote(code)}`,timeout_ms:80});
  const pid = started.structuredContent.pid;
  await f.call('read_process_output',{pid,reader_id:'audit-reader',timeout_ms:0});
  const timed = f.submit('tools/call',{name:'read_process_output',arguments:{pid,reader_id:'audit-reader',timeout_ms:600}},{id:'read',responseTimeout:'100ms'});
  await pause(180);
  const sessions = await f.call('list_sessions');
  assert.match(sessions.content.map(x=>x.text??'').join('\n'),new RegExp(String(pid)));
  await f.call('interact_with_process',{pid,input:'SURVIVED',wait_for_prompt:false,timeout_ms:0});
  await pause(650);
  const output = await f.call('read_process_output',{pid,offset:-10,length:10,timeout_ms:0});
  assert.match(output.structuredContent.output,/SURVIVED/);
  await f.call('interact_with_process',{pid,input:'EXIT',wait_for_prompt:false,timeout_ms:0});
  let finished;
  for (let i=0;i<20;i++) {
    finished=await f.call('read_process_output',{pid,offset:-10,length:10,timeout_ms:0});
    if (!finished.structuredContent.running) break;
    await pause(25);
  }
  assert.equal(finished.structuredContent.exit_code,0);
  assert.equal(f.replies.has(timed),false);
  const journal=fs.readFileSync(path.join(f.root,'state/runtime-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.filter(e=>e.event==='startup').length,1);
  assert.equal(journal.find(e=>e.event==='startup').ppid,f.child.pid,'sanitized wrapper must exec Node directly under Tunnel');
  assert.equal(journal.some(e=>e.event==='shutdown_started'),false);
});

test('a second legacy initialize opens a bounded 409 window until its initialized notification', enabled, async t => {
  const f = await harness(t);
  const initial = await f.call('echo',{marker:'before-new-handshake'});
  const init = await f.response(f.submit('initialize', {
    protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'second-caller',version:'1'},
  }, {id:'second-initialize'}));
  assert.equal(init.resp_code,200,JSON.stringify(init));

  // A different caller can reach this interval between the two handshake
  // messages. The 409 is a local protocol guard, not a broken stdio pipe.
  const blocked = await f.response(f.submit('tools/call', {
    name:'echo',arguments:{marker:'must-not-reach-child'},
  }, {id:'other-caller'}));
  assert.equal(blocked.resp_code,409,JSON.stringify(blocked));
  assert.equal(blocked.resp_json?.error?.code,-32002);
  assert.equal(blocked.resp_json?.error?.data?.error_type,'mcp_initialization_required');
  assert.equal(f.events().some(e=>e.marker==='must-not-reach-child'),false);

  await f.response(f.submit('notifications/initialized',{}, {id:null}));
  const after = await f.call('echo',{marker:'after-new-handshake'});
  assert.equal(after.structuredContent.pid,initial.structuredContent.pid);
  assert.equal(after.structuredContent.marker,'after-new-handshake');
  assert.equal(f.events().filter(e=>e.event==='request'&&e.method==='notifications/initialized').length,2);
  assert.equal(f.events().some(e=>e.event==='stdin_end'),false);
});

test('official initialized-notification opt-in closes that window without duplicating child notifications', enabled, async t => {
  // CLI: --mcp.stdio-send-initialized-notification=true
  // Equivalent parent-Tunnel environment: MCP_STDIO_SEND_INITIALIZED_NOTIFICATION=true
  // This is an explicit compatibility option, never the local stdio default.
  const f = await harness(t,{sendInitialized:true});
  const initial = await f.call('echo',{marker:'before-compatible-handshake'});
  assert.equal(f.events().filter(e=>e.event==='request'&&e.method==='notifications/initialized').length,1);
  const init = await f.response(f.submit('initialize', {
    protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'second-caller',version:'1'},
  }, {id:'second-initialize'}));
  assert.equal(init.resp_code,200,JSON.stringify(init));

  // No caller notification has been submitted for this handshake yet. The
  // official option must make the same operational request succeed here.
  const during = await f.call('echo',{marker:'inside-compatible-handshake'},{id:'other-caller'});
  assert.equal(during.structuredContent.marker,'inside-compatible-handshake');
  assert.equal(during.structuredContent.pid,initial.structuredContent.pid);
  await f.response(f.submit('notifications/initialized',{}, {id:null}));
  await f.response(f.submit('notifications/initialized',{}, {id:null}));
  const after = await f.call('echo',{marker:'after-duplicate-notifications'});
  assert.equal(after.structuredContent.pid,initial.structuredContent.pid);
  assert.equal(f.events().filter(e=>e.event==='request'&&e.method==='initialize').length,2);
  assert.equal(f.events().filter(e=>e.event==='request'&&e.method==='notifications/initialized').length,2);
  assert.equal(f.events().filter(e=>e.event==='startup').length,1);
  assert.equal(f.events().some(e=>e.event==='stdin_end'),false);
});
