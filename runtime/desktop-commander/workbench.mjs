import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import properLockfile from 'proper-lockfile';

export const WORKBENCH_URI = 'ui://sandbox-mcp-for-test/workbench-v1.html';
export const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TERMINAL_SNAPSHOT_CHARS = 128 * 1024;
export const SERVER_INSTANCE = crypto.randomUUID();
const defaultDirectory = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const absolute = { type: 'string', minLength: 1, description: 'Absolute path on this host.' };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const uiAccess = { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true };

export const workbenchTools = [
  {
    name: 'open_workbench', title: '打开本机工作台',
    description: 'Open the interactive local file/editor/terminal/search/Git workbench inside this chat. Set cwd to the user-selected absolute working directory. No model API is called; the host decides Chat/Work availability and usage. Other tools remain usable without the UI.',
    inputSchema: object({ cwd: absolute }), annotations: readOnly,
    _meta: { ...uiAccess, ui: { ...uiAccess.ui, resourceUri: WORKBENCH_URI }, 'openai/outputTemplate': WORKBENCH_URI },
  },
  {
    name: 'workbench_list_directory', title: '浏览工作目录', description: 'List one local directory with bounded pagination and structured file entries. Does not recurse.',
    inputSchema: { ...object({ path: absolute, offset: integer(0, 1000000), limit: integer(1, 500), show_hidden: { type: 'boolean' } }), required: ['path'] },
    annotations: readOnly, _meta: uiAccess,
  },
  {
    name: 'workbench_read_file', title: '打开文本文件', description: 'Read exact UTF-8 text and its SHA-256 version for editing. Reject binary, non-UTF-8 and files larger than 1 MiB; use read_file for bounded viewing of other formats.',
    inputSchema: { ...object({ path: absolute }), required: ['path'] }, annotations: readOnly, _meta: uiAccess,
  },
  {
    name: 'workbench_save_file', title: '保存文本文件', description: 'Save exact UTF-8 text after checking expected_version from workbench_read_file. null means create a new file exclusively. A changed file is rejected, never silently overwritten. Preserves POSIX permissions; symbolic-link and hard-link writes are rejected.',
    inputSchema: { ...object({ path: absolute, content: { type: 'string', maxLength: MAX_TEXT_BYTES }, expected_version: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' } }), required: ['path', 'content', 'expected_version'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, _meta: uiAccess,
  },
  {
    name: 'workbench_git_changes', title: '查看 Git 改动', description: 'Read local Git status and staged/unstaged diffs. Does not stage, commit, invoke external diff/textconv drivers, push, or contact a remote.',
    inputSchema: { ...object({ cwd: absolute }), required: ['cwd'] }, annotations: readOnly, _meta: uiAccess,
  },
  {
    name: 'workbench_terminal_snapshot', title: '查看终端会话', description: 'Read active/completed managed processes and a bounded output tail without consuming the shared output cursor. The preview is capped at 128 Ki UTF-16 code units; use read_process_output with a cursor for longer output. instance from open_workbench detects an MCP restart. Sessions are in memory only.',
    inputSchema: object({ pid: integer(2, Number.MAX_SAFE_INTEGER), tail_lines: integer(1, 1000), instance: { type: 'string' } }), annotations: readOnly, _meta: uiAccess,
  },
];

function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('需要本机绝对路径');
  return path.resolve(value);
}
export function directory(value) {
  const resolved = fs.realpathSync(absolutePath(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error('所选路径不是目录');
  return resolved;
}
function boundedInteger(value, fallback, min, max) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`参数必须是 ${min}–${max} 内的整数`);
  return number;
}
export function listDirectory(args) {
  const root = directory(args.path);
  const offset = boundedInteger(args.offset, 0, 0, 1000000);
  const limit = boundedInteger(args.limit, 200, 1, 500);
  if (args.show_hidden !== undefined && typeof args.show_hidden !== 'boolean') throw new Error('show_hidden 必须是布尔值');
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => args.show_hidden || !e.name.startsWith('.'));
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'en'));
  return { path: root, parent: path.dirname(root), total: entries.length, offset, next_offset: offset + limit < entries.length ? offset + limit : null,
    entries: entries.slice(offset, offset + limit).map(e => ({ name: e.name, path: path.join(root, e.name), type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : e.isFile() ? 'file' : 'other' })) };
}
function readBytes(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('只能在编辑器中打开普通文件');
    if (stat.size > MAX_TEXT_BYTES) throw new Error('文件超过 1 MiB，请在 Chat 中使用 read_file 分块查看');
    // A fixed buffer bounds reads even when another writer grows the file.
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    if (length > MAX_TEXT_BYTES) throw new Error('文件超过 1 MiB，请分块查看');
    const bytes = buffer.subarray(0, length);
    if (!isUtf8(bytes) || bytes.includes(0)) throw new Error('编辑器仅支持 UTF-8 文本；二进制或其他编码请在 Chat 中使用 read_file 查看');
    return { bytes, stat };
  } finally { fs.closeSync(fd); }
}
export function readText(args) {
  const target = fs.realpathSync(absolutePath(args.path));
  const { bytes } = readBytes(target);
  const content = bytes.toString('utf8');
  return { path: target, content, version: hash(bytes), bytes: bytes.length, newline: content.includes('\r\n') ? 'CRLF' : 'LF' };
}
export function saveText(args) {
  const input = absolutePath(args.path);
  const parent = directory(path.dirname(input));
  const target = path.join(parent, path.basename(input));
  if (typeof args.content !== 'string' || args.content.includes('\0')) throw new Error('保存内容必须是 UTF-8 文本');
  const bytes = Buffer.from(args.content, 'utf8');
  if (bytes.length > MAX_TEXT_BYTES || bytes.toString('utf8') !== args.content) throw new Error('内容不是有效 UTF-8 文本或超过 1 MiB');
  if (args.expected_version !== null && !/^[a-f0-9]{64}$/.test(args.expected_version ?? '')) throw new Error('保存需要打开文件时取得的内容版本');
  const temp = path.join(parent, `.sandbox-workbench-${crypto.randomUUID()}.tmp`);
  const release = properLockfile.lockSync(target, { realpath: false, stale: 15000, update: 5000, retries: 0 });
  try {
    let stat;
    if (args.expected_version === null) {
      try { fs.lstatSync(target); throw new Error('文件已存在；请先打开后编辑'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('保存仅支持非符号链接、非硬链接的普通文件');
      if (hash(readBytes(target).bytes) !== args.expected_version) throw new Error('文件已被其他编辑器修改。草稿已保留，请重新打开并合并后保存。');
    }
    fs.writeFileSync(temp, bytes, { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o600 });
    // create(2) applies umask; preserve the original file mode before atomic rename.
    if (stat) fs.chmodSync(temp, stat.mode & 0o777);
    if (directory(path.dirname(input)) !== parent) throw new Error('目录路径已变化，请重新打开');
    if (stat) {
      const current = fs.lstatSync(target);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1 || current.mode !== stat.mode || hash(readBytes(target).bytes) !== args.expected_version) throw new Error('文件已变化，保存取消；草稿已保留');
      fs.renameSync(temp, target);
    } else {
      fs.linkSync(temp, target); // Exclusive publication: never replace an existing file.
      fs.unlinkSync(temp);
    }
    return { path: target, version: hash(bytes), bytes: bytes.length, saved: true };
  } finally {
    try { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    finally { release(); }
  }
}
function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '--no-pager', '-C', cwd, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 2 * MAX_TEXT_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function gitChanges(args) {
  const cwd = directory(args.cwd);
  let root;
  try { root = git(cwd, ['rev-parse', '--show-toplevel']).trim(); } catch (error) {
    if (/not a git repository/i.test(error.stderr ?? '')) return { cwd, is_repository: false, entries: [], staged: '', unstaged: '' };
    throw new Error(`Git 读取失败: ${String(error.stderr || error.message).slice(0,500)}`);
  }
  const records = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).split('\0');
  const entries = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    const status = record.slice(0, 2), name = record.slice(3);
    const original_path = /[RC]/.test(status) ? records[++i] : undefined;
    entries.push({ status, name, path: path.join(root, name), ...(original_path ? { original_path } : {}) });
  }
  const staged = git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--']);
  const unstaged = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--']);
  const cap = 200000;
  return { cwd, root, is_repository: true, entries, staged: staged.slice(0, cap), unstaged: unstaged.slice(0, cap), truncated: staged.length > cap || unstaged.length > cap };
}
function boundedTerminalTail(lines) {
  const selectedChars = lines.reduce((sum, line) => sum + line.length, 0) + Math.max(0, lines.length - 1);
  let remaining = MAX_TERMINAL_SNAPSHOT_CHARS;
  const parts = [];
  // Select bounded suffixes before joining so a multi-megabyte retained buffer
  // does not become a multi-megabyte response or temporary string on every poll.
  for (let i = lines.length - 1; i >= 0 && remaining > 0; i--) {
    const line = lines[i];
    let start = Math.max(0, line.length - remaining);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start]) && /[\uD800-\uDBFF]/.test(line[start - 1])) start++;
    parts.push(line.slice(start));
    remaining -= line.length - start;
    if (start > 0) break;
    if (i > 0 && remaining > 0) { parts.push('\n'); remaining--; }
  }
  const output = parts.reverse().join('');
  return { output, omitted_prefix_chars: selectedChars - output.length };
}
export function terminalSnapshot(args, terminalManager) {
  if (args.instance !== undefined && args.instance !== SERVER_INSTANCE) throw new Error('MCP 已重启，旧会话已失效；请在 Chat 中重新打开工作台');
  const tail = boundedInteger(args.tail_lines, 500, 1, 1000);
  const sessions = terminalManager.listActiveSessions().map(s => ({ pid: s.pid, running: true, runtime_ms: s.runtime }));
  const completed = terminalManager.listCompletedSessions().map(s => ({ pid: s.pid, running: false, exit_code: s.exitCode, runtime_ms: s.endTime - s.startTime }));
  const data = { instance: SERVER_INSTANCE, sessions: [...sessions, ...completed.slice(-Math.max(0, 100 - sessions.length))].slice(0, 100), observed_at: new Date().toISOString() };
  if (args.pid !== undefined) {
    const pid = boundedInteger(args.pid, undefined, 2, Number.MAX_SAFE_INTEGER);
    const snapshot = terminalManager.readOutputPaginated(pid, -tail, tail);
    if (!snapshot) throw new Error('终端会话不存在或已过期');
    const preview = boundedTerminalTail(snapshot.lines);
    Object.assign(data, { pid, ...preview, running: !snapshot.isComplete, exit_code: snapshot.exitCode ?? null,
      total_lines: snapshot.totalLines, evicted_lines: snapshot.evictedLines ?? 0,
      truncated: snapshot.readFrom > 0 || snapshot.evictedLines > 0 || preview.omitted_prefix_chars > 0 });
  }
  return data;
}
export function workbenchResource() {
  const html = fs.readFileSync(new URL('./workbench-ui.html', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('./workbench-ui.mjs', import.meta.url), 'utf8');
  return { contents: [{ uri: WORKBENCH_URI, mimeType: 'text/html;profile=mcp-app', text: html.replace('/* WORKBENCH_SCRIPT */', () => script.replace(/<\/script/gi, '<\\/script')),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
      'openai/widgetDescription': '本机文件编辑、终端、搜索和 Git 改动工作台。按钮通过现有 MCP 连接执行，AI 请求发送到当前 Chat。',
      'openai/widgetPrefersBorder': true, 'openai/widgetCSP': { connect_domains: [], resource_domains: [], frame_domains: [] } } }] };
}
export function runWorkbench(name, args, terminalManager) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
  const tool = workbenchTools.find(t => t.name === name);
  if (!tool) throw new Error('Unknown workbench tool');
  for (const key of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error(`未知参数: ${key}`);
  switch (name) {
    case 'open_workbench': return { cwd: directory(args.cwd ?? defaultDirectory), instance: SERVER_INSTANCE, server_pid: process.pid, text_limit_bytes: MAX_TEXT_BYTES, access_mode: 'host_user' };
    case 'workbench_list_directory': return listDirectory(args);
    case 'workbench_read_file': return readText(args);
    case 'workbench_save_file': return saveText(args);
    case 'workbench_git_changes': return gitChanges(args);
    case 'workbench_terminal_snapshot': return terminalSnapshot(args, terminalManager);
    default: throw new Error('Unknown workbench tool');
  }
}
