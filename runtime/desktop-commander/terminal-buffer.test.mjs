import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = path.dirname(fileURLToPath(import.meta.url));
const upstream = path.join(root,'node_modules/@wonderwhy-er/desktop-commander');
const source = fs.readFileSync(path.join(upstream,'dist/terminal-manager.js'),'utf8');
const body = source.split('    appendToLineBuffer(session, text) {')[1].split('\n    /**')[0];
const MAX = 1024*1024;
const append = new Function('session','text',`const MAX_LINE_CHARS=${MAX};const MAX_BUFFERED_OUTPUT_CHARS=50*1024*1024;${body.slice(0,body.lastIndexOf('}'))}`);
const buffer = () => ({outputLines:[],bufferedChars:0,evictedChars:0,evictedLines:0,lastReadIndex:0});
test('forced long-line boundaries preserve surrogate pairs and exact character accounting',()=>{
  for(const prefix of [MAX-2,MAX-1,MAX]) {
    const whole='x'.repeat(prefix)+'😀'+'y'.repeat(20),s=buffer();append(s,whole);
    assert.equal(s.outputLines.join(''),whole);assert.ok(s.outputLines.every(x=>x.isWellFormed()&&x.length<=MAX));
    assert.equal(s.bufferedChars,s.outputLines.join('\n').length);assert.equal(s.evictedChars,0);
  }
});
test('a surrogate pair arriving in separate text fragments is not split by forced wrapping',()=>{
  const s=buffer();append(s,'x'.repeat(MAX-1)+'\uD83D');append(s,'\uDE00tail');
  assert.equal(s.outputLines.join(''),'x'.repeat(MAX-1)+'😀tail');assert.ok(s.outputLines.every(x=>x.isWellFormed()));
  assert.equal(s.bufferedChars,s.outputLines.join('\n').length);
});
test('preparation migrates old Unicode snippets and is idempotent in an isolated dependency fixture',t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-unicode-prepare-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const dep=path.join(tmp,'node_modules/@wonderwhy-er/desktop-commander');fs.mkdirSync(path.join(dep,'dist'),{recursive:true});
  fs.copyFileSync(path.join(root,'prepare.mjs'),path.join(tmp,'prepare.mjs'));fs.copyFileSync(path.join(upstream,'package.json'),path.join(dep,'package.json'));fs.copyFileSync(path.join(upstream,'dist/config.js'),path.join(dep,'dist/config.js'));
  fs.copyFileSync(path.join(root,'platform.mjs'),path.join(tmp,'platform.mjs'));
  const processToolsPath=path.join('dist','tools','improved-process-tools.js');
  const processToolsSource=fs.readFileSync(path.join(upstream,processToolsPath),'utf8');
  fs.mkdirSync(path.join(dep,'dist','tools'));
  fs.writeFileSync(path.join(dep,processToolsPath),processToolsSource.replace('await terminalManager.sendInputToProcess(pid, input, timeout_ms)','terminalManager.sendInputToProcess(pid, input)'));
  const sdk=path.join(tmp,'node_modules/@modelcontextprotocol/sdk');fs.mkdirSync(path.join(sdk,'dist/esm/shared'),{recursive:true});
  fs.copyFileSync(path.join(root,'node_modules/@modelcontextprotocol/sdk/package.json'),path.join(sdk,'package.json'));
  const sdkOriginal=fs.readFileSync(path.join(root,'node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js'),'utf8');
  const sdkLegacy=sdkOriginal.replace('        // sandboxCommanderCancelId: preserve valid falsy JSON-RPC IDs.\n        if (notification.params.requestId === undefined || notification.params.requestId === null) {','        if (!notification.params.requestId) {');
  fs.writeFileSync(path.join(sdk,'dist/esm/shared/protocol.js'),sdkLegacy);
  const target=path.join(dep,'dist/terminal-manager.js');
  const legacy=source.replace(/            \/\/ sandboxCommanderUtf8Streams:[^\n]*\n            childProcess.stdout.setEncoding\('utf8'\);\n            childProcess.stderr.setEncoding\('utf8'\);\n/,'')
    .replace(/            \/\/ sandboxCommanderUnicodeBoundary:[^\n]*\n            let splitAt = MAX_LINE_CHARS;\n            const before = [^\n]*\n            if \(before [^\n]*\n            session.outputLines\[lastIndex\] = overlong.slice\(0, splitAt\);\n            session.outputLines.push\(overlong.slice\(splitAt\)\);/,
      '            session.outputLines[lastIndex] = overlong.slice(0, MAX_LINE_CHARS);\n            session.outputLines.push(overlong.slice(MAX_LINE_CHARS));');
  assert.doesNotMatch(legacy,/sandboxCommanderUtf8Streams|sandboxCommanderUnicodeBoundary/);fs.writeFileSync(target,legacy);
  execFileSync(process.execPath,[path.join(tmp,'prepare.mjs')]);const once=fs.readFileSync(target,'utf8');execFileSync(process.execPath,[path.join(tmp,'prepare.mjs')]);
  assert.equal(once,source);assert.equal(fs.readFileSync(target,'utf8'),once);assert.match(once,/sandboxCommanderUnicodeBoundary/);assert.match(once,/sandboxCommanderUtf8Streams/);
  assert.equal(fs.readFileSync(path.join(dep,processToolsPath),'utf8'),processToolsSource);
  assert.equal(fs.readFileSync(path.join(sdk,'dist/esm/shared/protocol.js'),'utf8'),sdkOriginal);
});
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('real stdio preserves a long-line emoji and UTF-8 split across stdout/stderr pipe chunks',{timeout:30000},async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-unicode-stdio-'));const client=new Client({name:'unicode-boundary-test',version:'1'},{});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server.mjs')],env:{HOME:process.env.HOME,PATH:process.env.PATH,SANDBOX_COMMANDER_STATE_DIR:tmp+'/state',SANDBOX_WORKBENCH_SYNC_FILE:tmp+'/events.jsonl'},stderr:'pipe'});
  await client.connect(transport);t.after(async()=>{await client.close();fs.rmSync(tmp,{recursive:true,force:true});});
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args,_meta:{'openai/session':'unicode-acceptance'}});assert.ok(!r.isError,JSON.stringify(r));return r;};
  const code="const rl=require('readline').createInterface({input:process.stdin});console.log('READY');rl.on('line',x=>{if(x==='exit')return process.exit(0);if(x==='large'){process.stdout.write('x'.repeat(1048575));process.stdout.write('😀');}if(x==='bytes'){process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>{process.stdout.write(Buffer.from([0x98,0x80,0x0a]));process.stderr.write(Buffer.from([0xe7]));setTimeout(()=>process.stderr.write(Buffer.from([0x94,0xb2,0x0a])),20);},20);}});";
  const started=await call('start_process',{command:`exec ${quote(process.execPath)} -e ${quote(code)}`,timeout_ms:100});const pid=started.structuredContent.pid;
  const collect=async until=>{let result='';for(let i=0;i<60;i++){result+=(await call('read_process_output',{pid,timeout_ms:20})).structuredContent.output;if(until(result))return result;await pause(10);}assert.fail('output not complete');};
  assert.equal(await collect(s=>s.endsWith('READY\n')),'READY\n');
  await call('interact_with_process',{pid,input:'large',wait_for_prompt:false,timeout_ms:100});
  const large=await collect(s=>s.endsWith('😀'));assert.equal(large.length,MAX+2);assert.equal(large.slice(-3),'\n😀');assert.ok(/^x+$/.test(large.slice(0,-3)));assert.ok(large.isWellFormed());
  await call('interact_with_process',{pid,input:'bytes',wait_for_prompt:false,timeout_ms:100});assert.equal(await collect(s=>s.endsWith('甲\n')),'😀\n甲\n');
  await call('interact_with_process',{pid,input:'exit',wait_for_prompt:false,timeout_ms:100});
});
