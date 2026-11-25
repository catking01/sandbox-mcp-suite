import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./workbench-ui.mjs', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function snapshot(pid) {
  return { structuredContent: {
    instance: 'test-instance', pid,
    sessions: [{ pid: 111, running: true }, { pid: 222, running: true }],
    output: `OUTPUT_FROM_${pid}`, running: true, observed_at: new Date().toISOString(),
  }, content: [] };
}
function fixture(t, handler) {
  const nodes = new Map(), calls = [], writes = [], timers = new Map();
  let timerId = 0;
  const makeElement = id => {
    const handlers = new Map();
    let text = '';
    return {
      value: '', dataset: {}, disabled: false, hidden: false, children: [],
      classList: { toggle() {} },
      get textContent() { return text; },
      set textContent(value) { text = String(value); writes.push({ id, text }); },
      addEventListener(type, callback) { handlers.set(type, callback); },
      emit(type, event = {}) { handlers.get(type)?.(event); },
      prepend(child) { this.children.unshift(child); },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
      setAttribute() {},
    };
  };
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, makeElement(id));
    return nodes.get(id);
  };
  const window = {
    addEventListener() {},
    openai: {
      callTool(name, args) {
        calls.push({ name, args: structuredClone(args) });
        return handler?.(name, args, calls) ?? Promise.resolve(snapshot(args.pid));
      },
      setWidgetState() {},
    },
  };
  window.parent = window;
  const document = {
    getElementById: element, querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, documentElement: { scrollHeight: 640, dataset: {} },
    body: {}, visibilityState: 'visible', createElement: () => makeElement(null),
  };
  const context = vm.createContext({
    window, document, Date, Map, Set, Math, JSON,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const run = code => vm.runInContext(code, context);
  run(source);
  run("cwd='/fixture';instance='test-instance';currentPid=111;sessions=[{pid:111,running:true},{pid:222,running:true}]");
  t.after(() => run('dispose()'));
  return {
    element, calls, writes, run,
    selectPid(pid) {
      element('session-list').value = String(pid ?? '');
      element('session-list').onchange();
    },
  };
}

test('late terminal snapshots never appear under another PID and refresh the latest selection', async t => {
  const waiting = deferred();
  const f = fixture(t, (name, args, calls) => calls.length === 1 ? waiting.promise : undefined);
  const pending = f.run('refreshTerminal()');
  assert.equal(f.calls[0].args.pid, 111);
  f.selectPid(222);
  waiting.resolve(snapshot(111));
  await pending;
  assert.deepEqual(f.calls.map(call => call.args.pid), [111, 222]);
  assert.equal(f.element('terminal-output').textContent, 'OUTPUT_FROM_222');
  assert.match(f.element('terminal-state').textContent, /^PID 222 /);
  assert.ok(!f.writes.some(write => write.id === 'terminal-output' && write.text === 'OUTPUT_FROM_111'));
});

test('stop keeps the clicked PID when selection changes during its preflight read', async t => {
  const waiting = deferred();
  const f = fixture(t, (name, args, calls) => calls.length === 1 ? waiting.promise : undefined);
  const pending = f.element('stop-process').onclick();
  f.selectPid(222);
  waiting.resolve(snapshot(111));
  await pending;
  const stopped = f.calls.filter(call => call.name === 'force_terminate');
  assert.deepEqual(stopped.map(call => call.args.pid), [111]);
});

test('stdin keeps the clicked PID and submitted text without clearing newer input', async t => {
  const waiting = deferred();
  const f = fixture(t, (name, args, calls) => calls.length === 1 ? waiting.promise : undefined);
  f.element('stdin').value = 'original input';
  f.element('stdin-form').onsubmit({ preventDefault() {} });
  f.selectPid(222);
  f.element('stdin').value = 'new input for selected process';
  waiting.resolve(snapshot(111));
  await tick();
  const sent = f.calls.filter(call => call.name === 'interact_with_process');
  assert.deepEqual(sent.map(call => call.args), [{ pid: 111, input: 'original input', timeout_ms: 300 }]);
  assert.equal(f.element('stdin').value, 'new input for selected process');
  assert.equal(f.element('terminal-output').textContent, 'OUTPUT_FROM_222');
});

test('a disposed workbench cannot dispatch a late stop or stdin write', async t => {
  for (const operation of ['stop', 'stdin']) {
    const waiting = deferred();
    const f = fixture(t, () => waiting.promise);
    const pending = operation === 'stop'
      ? f.element('stop-process').onclick()
      : f.element('stdin-form').onsubmit({ preventDefault() {} });
    f.run('dispose()');
    waiting.resolve(snapshot(111));
    await pending;
    await tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].name, 'workbench_terminal_snapshot');
  }
});

function openDocuments(f) {
  f.run("for(const path of ['/A','/B']) documents.set(path,{path,content:'original',draft:'original',version:'v1',dirty:false,newline:'LF',bytes:8});selectFile('/A')");
}
const readFileResult = path => ({ structuredContent: { path, content: 'from disk', version: 'v2', newline: 'LF', bytes: 9 }, content: [] });

test('reload preserves a draft edited while the file read was pending', async t => {
  const waiting = deferred();
  const f = fixture(t, name => name === 'workbench_read_file' ? waiting.promise : undefined);
  openDocuments(f);
  const pending = f.element('reload-file').onclick();
  f.element('editor').value = 'draft typed during read';
  f.element('editor').emit('input');
  waiting.resolve(readFileResult('/A'));
  await pending;
  assert.equal(f.run("documents.get('/A').draft"), 'draft typed during read');
  assert.equal(f.element('editor').value, 'draft typed during read');
  assert.equal(f.run("documents.get('/A').dirty"), true);
  assert.match(f.element('status').textContent, /读取期间草稿已变化/);
});

test('reload updates its original document without stealing another selected tab', async t => {
  const waiting = deferred();
  const f = fixture(t, name => name === 'workbench_read_file' ? waiting.promise : undefined);
  openDocuments(f);
  const pending = f.element('reload-file').onclick();
  f.run("selectFile('/B')");
  waiting.resolve(readFileResult('/A'));
  await pending;
  assert.equal(f.run('selected'), '/B');
  assert.equal(f.element('editor').value, 'original');
  assert.equal(f.run("documents.get('/A').content"), 'from disk');
});

test('late file-open responses preserve the current selected tab', async t => {
  const waiting = deferred();
  const f = fixture(t, name => name === 'workbench_read_file' ? waiting.promise : undefined);
  openDocuments(f);
  const pending = f.run("openFile('/C')");
  f.run("selectFile('/B')");
  waiting.resolve(readFileResult('/C'));
  await pending;
  assert.equal(f.run('selected'), '/B');
  assert.equal(f.run("documents.get('/C').content"), 'from disk');
});
