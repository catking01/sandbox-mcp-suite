// Self-contained MCP Apps client. No network fetches or model API calls.
const $ = id => document.getElementById(id);
const pending = new Map();
const requestPrefix = Math.random().toString(36).slice(2);
let nextRequest = 0, bridge = null, disposed = false, stale = false, hostOrigin = null;
let cwd = '', browsing = '', instance = '', nextOffset = null, browseGeneration = 0, fileGeneration = 0;
let selected = null, currentPid = null, sessions = [], searchId = null, searchOffset = 0, searchHasMore = true, gitData = null;
let polling = null, refreshingTerminal = false, terminalRefreshPending = false, draftView = false, displayMode = 'inline';
const documents = new Map(), busy = new Set();
const textOf = result => result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const normalize = value => value.replaceAll('\r\n', '\n');

function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
function activity(message, failed = false) {
  const row = document.createElement('div'); row.className = `activity${failed ? ' failed' : ''}`;
  const time = document.createElement('time'); time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const body = document.createElement('span'); body.textContent = message; row.append(time, body); $('activity-list').prepend(row);
  while ($('activity-list').children.length > 100) $('activity-list').lastChild.remove();
}
function notify(method, params) { if (!disposed) window.parent.postMessage({ jsonrpc: '2.0', method, params }, hostOrigin ?? '*'); }
function rpc(method, params, timeout = 30000) {
  if (disposed) return Promise.reject(new Error('工作台已关闭'));
  const id = `${requestPrefix}-${++nextRequest}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('请求超时，结果尚未确认；请刷新状态后再决定是否重试')); }, timeout);
    pending.set(id, { resolve, reject, timer, method });
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, hostOrigin ?? '*');
  });
}
async function call(name, args = {}) {
  if (!bridge) throw new Error('当前页面没有 Chat 的 MCP 连接，请在 Chat 中调用 open_workbench');
  const result = bridge === 'standard' ? await rpc('tools/call', { name, arguments: args }) : await window.openai.callTool(name, args);
  if (result?.isError) {
    const message = textOf(result) || '工具执行失败';
    if (message.includes('MCP 已重启')) { stale = true; clearTimeout(polling); updateControls(); }
    throw new Error(message);
  }
  return result;
}
async function data(name, args) {
  const result = await call(name, args);
  if (!result?.structuredContent) throw new Error('工具结构尚未刷新，请刷新 for-test 连接器并重新打开工作台');
  return result.structuredContent;
}
async function action(key, label, fn) {
  if (busy.has(key)) return;
  busy.add(key); updateControls(); status(`${label}…`);
  try { await fn(); activity(label); status(`${label}完成`); }
  catch (error) { activity(`${label}：${error.message}`, true); status(error.message, true); }
  finally { busy.delete(key); updateControls(); }
}
function updateControls() {
  const connected = Boolean(bridge && cwd && !disposed && !stale), doc = documents.get(selected), running = connected && sessions.some(s => s.pid === currentPid && s.running);
  for (const id of ['open-cwd', 'parent-directory', 'refresh-files', 'new-file', 'new-folder', 'run-command', 'refresh-terminal', 'start-search', 'refresh-git']) $(id).disabled = !connected;
  $('open-cwd').disabled = !bridge || stale || busy.has('cwd');
  $('save-file').disabled = !connected || !doc?.dirty || busy.has('save');
  $('reload-file').disabled = stale || !doc || doc.version === null || busy.has('reload');
  $('preview-diff').disabled = !doc;
  $('editor').disabled = !doc || busy.has('save');
  $('run-command').disabled = !connected || busy.has('start');
  $('stop-process').disabled = !running || busy.has('stop');
  $('send-stdin').disabled = !running || busy.has('stdin');
  $('stop-search').disabled = !connected || !searchId || busy.has('stop-search');
  $('more-search').disabled = !connected || !searchId || !searchHasMore || busy.has('more-search');
  $('start-search').disabled = !connected || busy.has('search');
  $('send-chat').disabled = !connected || busy.has('chat');
  $('fullscreen').disabled = !bridge;
}
function applyHost(context = {}) {
  if (context.theme === 'dark' || context.theme === 'light') document.documentElement.dataset.theme = context.theme;
  if (context.displayMode) { displayMode = context.displayMode; $('fullscreen').textContent = displayMode === 'fullscreen' ? '退出全屏' : '全屏'; }
  // Fonts/CSS supplied by a host are not injected; no remote assets are needed.
}
function dispose() {
  disposed = true; clearTimeout(polling);
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('工作台已关闭')); } pending.clear(); updateControls();
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || (hostOrigin && event.origin !== hostOrigin)) return;
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  const p = pending.get(message.id);
  if (p) {
    if (p.method === 'ui/initialize' && event.origin !== 'null') hostOrigin = event.origin;
    clearTimeout(p.timer); pending.delete(message.id);
    if (message.error) { const error = new Error(message.error.message || 'Chat 拒绝了请求'); error.code = message.error.code; p.reject(error); }
    else p.resolve(message.result);
    return;
  }
  if (message.method === 'ui/notifications/tool-result') {
    const result = message.params;
    if (result?.isError) { status(textOf(result) || '工具执行失败', true); return; }
    if (result?.structuredContent?.cwd && result.structuredContent.instance) applyOpen(result.structuredContent);
  }
  if (message.method === 'ui/notifications/host-context-changed') applyHost(message.params);
  if (message.method === 'ui/notifications/tool-cancelled') status('调用已取消；有草稿时请先保留草稿', true);
  if (message.method === 'ping' || message.method === 'ui/resource-teardown') {
    if (message.id !== undefined) window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, event.origin === 'null' ? '*' : event.origin);
    if (message.method === 'ui/resource-teardown') dispose();
  }
});
window.addEventListener('pagehide', dispose);

async function applyOpen(open) {
  if (typeof open.cwd !== 'string' || !open.cwd.startsWith('/') || typeof open.instance !== 'string') return;
  if (instance && instance !== open.instance) { stale = true; updateControls(); status('MCP 已重启，请重新打开工作台；当前草稿仍保留在此界面', true); return; }
  const changed = cwd !== open.cwd;
  cwd = open.cwd; instance = open.instance; $('cwd').value = cwd; updateControls();
  if (changed) await action('browse', '读取工作目录', () => browse(cwd));
  await refreshTerminal().catch(error => status(error.message, true));
}
async function browse(target, append = false) {
  const generation = ++browseGeneration;
  const listing = await data('workbench_list_directory', { path: target, show_hidden: $('show-hidden').checked, offset: append ? nextOffset ?? 0 : 0, limit: 200 });
  if (generation !== browseGeneration) return;
  browsing = listing.path; nextOffset = listing.next_offset; $('directory-path').textContent = browsing;
  $('parent-directory').dataset.parent = listing.parent;
  if (!append) $('file-list').replaceChildren();
  for (const entry of listing.entries) {
    const row = document.createElement('button'); row.className = `file-row${selected === entry.path ? ' selected' : ''}`; row.title = entry.path; row.dataset.path = entry.path;
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = entry.type === 'directory' ? '▸' : entry.type === 'symlink' ? '↗' : '·';
    const name = document.createElement('span'); name.textContent = entry.name; row.append(icon, name);
    row.onclick = () => action('file-open', entry.type === 'directory' ? '浏览目录' : '打开文件', () => entry.type === 'directory' ? browse(entry.path) : openFile(entry.path));
    $('file-list').append(row);
  }
  if (!listing.entries.length && !append) { const empty = document.createElement('p'); empty.className = 'muted small'; empty.textContent = '这个目录没有可见文件。'; $('file-list').append(empty); }
  $('more-files').hidden = nextOffset === null;
}
function renderTabs() {
  $('file-tabs').replaceChildren();
  for (const [key, doc] of documents) {
    const tab = document.createElement('div'); tab.className = `file-tab${key === selected ? ' active' : ''}`;
    const label = document.createElement('button'); label.textContent = `${doc.path.split('/').at(-1)}${doc.dirty ? ' •' : ''}`; label.title = doc.path; label.setAttribute('role', 'tab'); label.setAttribute('aria-selected', String(key === selected)); label.onclick = () => selectFile(key);
    const close = document.createElement('button'); close.className = 'close-tab'; close.textContent = '×'; close.setAttribute('aria-label', `关闭 ${doc.path.split('/').at(-1)}`); close.onclick = () => closeFile(key);
    tab.append(label, close); $('file-tabs').append(tab);
  }
}
function modelContext() {
  return { cwd, selected_file: selected, unsaved_files: [...documents.values()].filter(d => d.dirty).map(d => d.path), selected_terminal_pid: currentPid };
}
function shareContext() {
  if (!bridge) return;
  if (bridge === 'standard') rpc('ui/update-model-context', { structuredContent: modelContext() }).catch(() => {});
  else window.openai.setWidgetState?.({ modelContent: JSON.stringify(modelContext()), privateContent: { pane: document.querySelector('[data-pane][aria-selected="true"]')?.dataset.pane } });
}
function selectFile(key) {
  fileGeneration++;
  selected = key; draftView = false;
  for (const row of document.querySelectorAll('.file-row')) row.classList.toggle('selected', row.dataset.path === key);
  const doc = documents.get(key); $('editor').value = doc?.draft ?? ''; $('file-path').textContent = doc?.path ?? '选择文件以打开';
  $('file-info').textContent = doc ? `${doc.newline} · ${doc.version === null ? '新文件' : `${doc.bytes} 字节`}${doc.dirty ? ' · 未保存' : ''}` : '';
  $('editor-empty').hidden = Boolean(doc); $('editor-wrap').hidden = false; $('draft-diff').hidden = true;
  renderTabs(); lineNumbers(); updateControls(); shareContext();
}
async function openFile(target) {
  if (documents.has(target)) { selectFile(target); return; }
  const generation = ++fileGeneration;
  const file = await data('workbench_read_file', { path: target });
  const doc = documents.get(file.path) ?? { ...file, draft: normalize(file.content), dirty: false };
  documents.set(file.path, doc);
  if (generation === fileGeneration) selectFile(file.path); else renderTabs();
}
function lineNumbers() {
  const count = Math.min(10000, $('editor').value.split('\n').length);
  $('line-numbers').textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  $('line-numbers').scrollTop = $('editor').scrollTop;
}
$('editor').addEventListener('input', () => {
  const doc = documents.get(selected); if (!doc) return;
  doc.draft = $('editor').value; doc.dirty = doc.version === null || doc.draft !== normalize(doc.content);
  renderTabs(); lineNumbers(); updateControls(); $('file-info').textContent = `${doc.newline} · ${doc.dirty ? '未保存' : '已保存'}`;
});
$('editor').addEventListener('scroll', () => { $('line-numbers').scrollTop = $('editor').scrollTop; });
$('editor').addEventListener('keydown', event => {
  if (event.key === 'Tab') { event.preventDefault(); const edit = $('editor'); edit.setRangeText('  ', edit.selectionStart, edit.selectionEnd, 'end'); edit.dispatchEvent(new Event('input')); }
  if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); $('save-file').click(); }
});
function dialog(title, description, input = false) {
  if ($('input-dialog').open) return Promise.resolve(null);
  $('dialog-title').textContent = title; $('dialog-description').textContent = description; $('dialog-input').hidden = !input; $('dialog-input').value = '';
  $('dialog-confirm').textContent = input ? '创建' : '继续'; $('input-dialog').returnValue = '';
  return new Promise(resolve => { $('input-dialog').addEventListener('close', () => resolve($('input-dialog').returnValue === 'ok' ? input ? $('dialog-input').value.trim() : true : null), { once: true }); $('input-dialog').showModal(); });
}
$('dialog-cancel').onclick = () => $('input-dialog').close('cancel');
$('dialog-confirm').onclick = () => $('input-dialog').close('ok');
$('dialog-form').onsubmit = event => { event.preventDefault(); $('input-dialog').close('ok'); };
async function closeFile(key) {
  const doc = documents.get(key); if (doc?.dirty && !await dialog('关闭未保存文件？', '这会丢弃此文件在当前界面中的草稿。')) return;
  documents.delete(key); selectFile(selected === key ? [...documents.keys()].at(-1) ?? null : selected);
}
$('save-file').onclick = () => action('save', '保存文件', async () => {
  const doc = documents.get(selected); if (!doc?.dirty) return;
  const content = doc.newline === 'CRLF' ? doc.draft.replaceAll('\n', '\r\n') : doc.draft;
  const saved = await data('workbench_save_file', { path: doc.path, content, expected_version: doc.version });
  Object.assign(doc, saved, { content, dirty: false }); selectFile(selected); await browse(browsing);
});
$('reload-file').onclick = () => action('reload', '重新读取文件', async () => {
  const doc = documents.get(selected);
  if (!doc) return;
  if (doc?.dirty && !await dialog('丢弃草稿并重新读取？', '文件中的内容将替换当前草稿；可以取消并先复制草稿。')) return;
  const draft = doc.draft, version = doc.version, generation = fileGeneration;
  const file = await data('workbench_read_file', { path: doc.path });
  if (documents.get(doc.path) !== doc) return;
  if (doc.draft !== draft || doc.version !== version) throw new Error('读取期间草稿已变化，已保留当前草稿；请确认后重新读取');
  documents.set(file.path, { ...file, draft: normalize(file.content), dirty: false });
  if (selected === doc.path && generation === fileGeneration) selectFile(file.path);
  else { renderTabs(); updateControls(); }
});
$('preview-diff').onclick = () => {
  const doc = documents.get(selected); if (!doc) return;
  draftView = !draftView; $('editor-wrap').hidden = draftView; $('draft-diff').hidden = !draftView; $('draft-diff').replaceChildren();
  if (!draftView) return;
  const before = normalize(doc.content).split('\n'), after = doc.draft.split('\n');
  let start = 0, end = 0; while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  if (!doc.dirty) { $('draft-diff').textContent = '没有尚未保存的改动。'; return; }
  const heading = document.createElement('span'); heading.textContent = `@@ 第 ${start + 1} 行附近的草稿改动 @@\n`; $('draft-diff').append(heading);
  for (const [rows, prefix, klass] of [[before.slice(start, before.length - end), '-', 'diff-remove'], [after.slice(start, after.length - end), '+', 'diff-add']]) {
    const span = document.createElement('span'); span.className = klass; span.textContent = rows.map(line => `${prefix} ${line}`).join('\n') + '\n'; $('draft-diff').append(span);
  }
};
async function createEntry(folder) {
  const name = await dialog(folder ? '新建文件夹' : '新建文件', `在 ${browsing} 中创建；输入相对名称。`, true);
  if (!name) return;
  if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\0')) throw new Error('请输入目录内的相对名称，不含 ..');
  const target = `${browsing.replace(/\/$/, '')}/${name}`;
  if (folder) { await call('create_directory', { path: target }); await browse(browsing); }
  else { if (documents.has(target)) { selectFile(target); return; } documents.set(target, { path: target, content: '', draft: '', dirty: true, version: null, bytes: 0, newline: 'LF' }); selectFile(target); }
}
$('new-file').onclick = () => action('new-file', '新建文件草稿', () => createEntry(false));
$('new-folder').onclick = () => action('new-folder', '新建目录', () => createEntry(true));
$('cwd-form').onsubmit = event => { event.preventDefault(); action('cwd', '切换工作目录', async () => {
  // A directory switch is a data call: do not invoke the render tool/remount UI.
  const listing = await data('workbench_list_directory', { path: $('cwd').value.trim(), limit: 1 });
  await applyOpen({ cwd: listing.path, instance }); gitData = null; shareContext();
}); };
$('parent-directory').onclick = () => action('browse', '浏览上一级', () => browse($('parent-directory').dataset.parent));
$('refresh-files').onclick = () => action('browse', '刷新文件列表', () => browse(browsing || cwd));
$('show-hidden').onchange = () => action('browse', '刷新文件列表', () => browse(browsing || cwd));
$('more-files').onclick = () => action('browse', '加载更多文件', () => browse(browsing, true));

function renderSessions() {
  $('session-list').replaceChildren();
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = '选择会话'; $('session-list').append(empty);
  for (const session of sessions) { const option = document.createElement('option'); option.value = session.pid; option.textContent = `${session.pid} · ${session.running ? '运行中' : `退出 ${session.exit_code ?? '信号'}`}`; $('session-list').append(option); }
  $('session-list').value = String(currentPid ?? '');
}
function schedulePoll() {
  clearTimeout(polling);
  if (!disposed && !stale && currentPid && sessions.some(s => s.pid === currentPid && s.running) && document.visibilityState !== 'hidden') {
    polling = setTimeout(() => refreshTerminal().catch(error => { status(error.message, true); activity(`终端刷新：${error.message}`, true); }), 2000);
  }
}
async function refreshTerminal() {
  if (!instance || disposed || stale) return;
  if (refreshingTerminal) { terminalRefreshPending = true; return; }
  refreshingTerminal = true;
  try {
    do {
      terminalRefreshPending = false;
      const pid = currentPid, requestedInstance = instance;
      const snapshot = await data('workbench_terminal_snapshot', { instance: requestedInstance, ...(pid ? { pid } : {}), tail_lines: 500 });
      if (disposed || stale) return;
      // Selection can change while the MCP call is pending. Never label the old
      // response with the new PID, and do not drop the newly requested refresh.
      if (pid !== currentPid || requestedInstance !== instance) { terminalRefreshPending = true; continue; }
      sessions = snapshot.sessions; renderSessions();
      if (pid) {
        $('terminal-output').textContent = snapshot.output || '(尚无输出)';
        $('terminal-state').textContent = snapshot.running ? `PID ${pid} · 运行中 · ${new Date(snapshot.observed_at).toLocaleTimeString()}` : `PID ${pid} · 退出 ${snapshot.exit_code ?? '信号终止'}`;
        if (snapshot.omitted_prefix_chars) $('terminal-state').textContent += ' · 输出过长，仅显示末尾片段';
        else if (snapshot.truncated) $('terminal-state').textContent += ' · 显示末尾 500 行';
      } else {
        $('terminal-output').textContent = '';
        $('terminal-state').textContent = '请选择终端会话';
      }
      updateControls();
    } while (terminalRefreshPending);
  } finally { refreshingTerminal = false; schedulePoll(); }
}
$('command-form').onsubmit = event => { event.preventDefault(); action('start', '启动命令', async () => {
  const command = $('command').value.trim(); if (!command) throw new Error('请输入命令');
  const result = await call('start_process', { command: `cd -- ${quote(cwd)} && ${command}`, timeout_ms: 800, origin: 'ui' });
  $('terminal-output').textContent = textOf(result);
  const pid = result.structuredContent?.pid ?? Number(textOf(result).match(/^Process started with PID (\d+)/)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('命令已返回，但未取得可管理的终端 PID；请查看输出和会话列表确认结果');
  currentPid = pid; await refreshTerminal(); shareContext();
}); };
$('session-list').onchange = () => { currentPid = Number($('session-list').value) || null; action('terminal', '切换终端会话', refreshTerminal); };
$('refresh-terminal').onclick = () => action('terminal', '刷新终端', refreshTerminal);
$('stop-process').onclick = () => action('stop', '停止选中进程', async () => {
  const pid = currentPid, requestedInstance = instance;
  if (!pid) throw new Error('请先选择运行中的进程');
  await data('workbench_terminal_snapshot', { instance: requestedInstance, pid });
  if (disposed || stale || instance !== requestedInstance) throw new Error('工作台会话已变化，停止请求未发送');
  await call('force_terminate', { pid });
  await refreshTerminal();
});
$('stdin-form').onsubmit = event => { event.preventDefault(); action('stdin', '发送进程输入', async () => {
  const pid = currentPid, requestedInstance = instance, input = $('stdin').value;
  if (!pid) throw new Error('请先选择运行中的进程');
  await data('workbench_terminal_snapshot', { instance: requestedInstance, pid });
  if (disposed || stale || instance !== requestedInstance) throw new Error('工作台会话已变化，输入未发送');
  const result = await call('interact_with_process', { pid, input, timeout_ms: 300 });
  if (currentPid === pid) {
    $('terminal-output').textContent = textOf(result);
    if ($('stdin').value === input) $('stdin').value = '';
  }
  await refreshTerminal();
}); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') clearTimeout(polling); else schedulePoll(); });

$('search-form').onsubmit = event => { event.preventDefault(); action('search', '搜索工作目录', async () => {
  const query = $('search-query').value; if (!query.trim()) throw new Error('请输入搜索文字');
  if (searchId) { await call('stop_search', { sessionId: searchId }); searchId = null; }
  const result = await call('start_search', { path: cwd, pattern: query, searchType: 'content', literalSearch: true, timeout_ms: 800, maxResults: 200 });
  const output = textOf(result); $('search-output').textContent = output; searchId = output.match(/(?:Search )?session:\s*(\S+)/i)?.[1] ?? null; searchOffset = 0; searchHasMore = true;
  if (!searchId) throw new Error('搜索未返回会话标识；请查看输出');
  await moreSearch();
}); };
async function moreSearch() {
  const result = await call('get_more_search_results', { sessionId: searchId, offset: searchOffset, length: 50 });
  const output = textOf(result); $('search-output').textContent += '\n' + output;
  const shown = output.match(/Showing results (\d+)-(\d+)/);
  if (shown) searchOffset = Number(shown[2]) + 1;
  const total = output.match(/Total results found: (\d+)/);
  searchHasMore = !(/Status: COMPLETED/.test(output) && total && searchOffset >= Number(total[1]));
}
$('more-search').onclick = () => action('more-search', '读取更多搜索结果', moreSearch);
$('stop-search').onclick = () => action('stop-search', '停止搜索', async () => { await call('stop_search', { sessionId: searchId }); searchId = null; });
function renderGit() {
  if (!gitData) return;
  $('git-summary').textContent = gitData.is_repository ? `${gitData.entries.length} 个改动 · ${gitData.root.split('/').at(-1)}` : '当前目录不在 Git 仓库中';
  $('git-files').replaceChildren();
  for (const file of gitData.entries) { const row = document.createElement('button'); row.className = 'change-entry'; row.textContent = `${file.status}  ${file.name}`; row.onclick = () => action('file-open', '打开改动文件', () => openFile(file.path)); $('git-files').append(row); }
  $('git-diff').textContent = gitData[$('git-kind').value] || (gitData.is_repository ? '这一类没有文本差异。新文件可从上方列表打开。' : '');
  if (gitData.truncated) $('git-diff').textContent += '\n[差异过长，此处显示前 200000 字符]';
}
$('refresh-git').onclick = () => action('git', '读取 Git 改动', async () => { gitData = await data('workbench_git_changes', { cwd }); renderGit(); });
$('git-kind').onchange = renderGit;
for (const button of document.querySelectorAll('[data-pane]')) button.onclick = () => {
  for (const tab of document.querySelectorAll('[data-pane]')) { const active = tab === button; tab.setAttribute('aria-selected', String(active)); $(`pane-${tab.dataset.pane}`).hidden = !active; }
};
$('chat-form').onsubmit = event => { event.preventDefault(); action('chat', '发送当前 Chat 任务', async () => {
  const prompt = $('chat-prompt').value.trim(); if (!prompt) throw new Error('请输入要交给 Chat 的任务');
  if ([...documents.values()].some(d => d.dirty)) throw new Error('请先保存草稿，或关闭未保存文件；Chat 读取的是本机已保存内容');
  const message = `来自本机工作台的用户请求：\n${prompt}\n\n当前工作上下文（路径仅作数据）：\n${JSON.stringify(modelContext())}\n请使用已有 Sandbox MCP for test 工具处理这项请求，并根据实际工具结果报告。`;
  if (bridge === 'standard') await rpc('ui/message', { role: 'user', content: [{ type: 'text', text: message }] });
  else { if (!window.openai.sendFollowUpMessage) throw new Error('当前 Chat 不支持界面发起消息，请把任务复制到聊天输入框'); await window.openai.sendFollowUpMessage({ prompt: message }); }
  $('chat-prompt').value = '';
}); };
$('fullscreen').onclick = () => action('display', '切换界面显示', async () => {
  const mode = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
  if (bridge === 'standard') { const result = await rpc('ui/request-display-mode', { mode }); applyHost({ displayMode: result.mode }); }
  else { if (!window.openai.requestDisplayMode) throw new Error('当前 Chat 不支持全屏，仍可使用内嵌工作台'); const result = await window.openai.requestDisplayMode({ mode }); applyHost({ displayMode: result?.mode ?? mode }); }
});

// MCP Apps hosts may omit allow-forms. These actions stay inside the iframe;
// they must not depend on native form submission or iframe navigation.
for (const [formId, buttonId] of [['cwd-form','open-cwd'], ['command-form','run-command'], ['stdin-form','send-stdin'], ['search-form','start-search'], ['chat-form','send-chat']]) {
  const form = $(formId), button = $(buttonId);
  const submit = () => { if (!button.disabled) form.dispatchEvent(new Event('submit', { cancelable: true })); };
  button.type = 'button'; button.onclick = submit;
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); submit(); }
  });
}

async function initialize() {
  if (window.parent !== window) {
    try {
      const init = await rpc('ui/initialize', { appInfo: { name: 'Sandbox local workbench', version: '1.1.0' }, appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }, protocolVersion: '2026-01-26' }, 2500);
      if (init.protocolVersion !== '2026-01-26') throw new Error('Chat 的 MCP Apps 协议版本不兼容');
      bridge = 'standard'; applyHost(init.hostContext); notify('ui/notifications/initialized', {});
      notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
    } catch (error) { if (!window.openai?.callTool) { status(`Chat 界面连接未完成：${error.message}。请刷新连接器后重新打开。`, true); return; } }
  }
  if (!bridge && window.openai?.callTool) {
    bridge = 'compatibility'; applyHost({ theme: window.openai.theme, displayMode: window.openai.displayMode });
    window.addEventListener('openai:set_globals', () => { if (window.openai.toolOutput?.cwd) applyOpen(window.openai.toolOutput); });
    if (window.openai.toolOutput?.cwd) await applyOpen(window.openai.toolOutput);
  }
  if (!bridge) { status('此界面需要当前 Chat 的 MCP 连接。在普通 Chat 中调用 for-test 的 open_workbench。', true); return; }
  status('已连接当前 Chat，正在等待工作目录'); updateControls();
  if (window.ResizeObserver) new ResizeObserver(() => { if (bridge === 'standard') notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight }); }).observe(document.body);
}
initialize().catch(error => status(error.message, true));
