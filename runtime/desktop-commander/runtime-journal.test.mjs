import os from 'node:os';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {createRuntimeJournal} from './runtime-journal.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-runtime-journal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('runtime diagnostics whitelist fields and remain bounded',t=>{
  const root=fixture(t),file=path.join(root,'events.jsonl'),log=createRuntimeJournal({filePath:file,instance:'test',version:'test',maxBytes:2048});
  for(let i=0;i<40;i++)assert.equal(log('shutdown_started',{reason:'stdin_end',pending_calls:i,command:'PRIVATE',output:'PRIVATE',requestId:'PRIVATE',message:'PRIVATE',code:'EPIPE'}),true);
  const data=fs.readFileSync(file,'utf8'),lines=data.trim().split('\n').map(JSON.parse);assert.ok(fs.statSync(file).size<=2048);assert.ok(!data.includes('PRIVATE'));assert.equal(lines.at(-1).pending_calls,39);assert.equal(lines.at(-1).reason,'stdin_end');assert.equal(lines.at(-1).code,'EPIPE');assert.equal(fs.statSync(file).mode&0o077,0);
});
test('diagnostic failure is nonfatal and symlinks are not followed',t=>{
  const root=fixture(t),target=path.join(root,'target'),link=path.join(root,'link');fs.writeFileSync(target,'unchanged');fs.symlinkSync(target,link);
  const log=createRuntimeJournal({filePath:link,instance:'test',version:'test'});assert.equal(log('startup'),false);assert.equal(fs.readFileSync(target,'utf8'),'unchanged');assert.equal(log('unknown'),false);
});
