// Shared local-only activity feed between the connected MCP and Sandbox Workbench.app.
// Tool events expose names/status only. Conversation text is added only by explicit publish.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolvePaths } from '../../lib/paths.mjs';

export const CHAT_SYNC_FILE = process.env.SANDBOX_WORKBENCH_SYNC_FILE ??
  path.join(resolvePaths().stateDir, 'chat-sync', 'events.jsonl');

const MAX_TEXT = 8000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const acceptedSources = new Set(['chat_mcp', 'local_app']);
const acceptedKinds = new Set(['tool', 'request', 'approach', 'progress', 'final', 'note']);

function sessionKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function appendSyncEvent(event, filePath = CHAT_SYNC_FILE) {
  if (!event || !acceptedSources.has(event.source) || !acceptedKinds.has(event.kind)) {
    throw new Error('Invalid sync event');
  }
  if (event.text !== undefined && (typeof event.text !== 'string' || event.text.length > MAX_TEXT)) {
    throw new Error('Sync text exceeds 8000 characters');
  }
  const record = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    source: event.source,
    kind: event.kind,
    ...(typeof event.name === 'string' ? { name: event.name.slice(0, 120) } : {}),
    ...(typeof event.status === 'string' ? { status: event.status.slice(0, 40) } : {}),
    ...(typeof event.operation === 'string' && /^[0-9a-f-]{36}$/.test(event.operation) ? { operation: event.operation } : {}),
    ...(Number.isSafeInteger(event.duration_ms) && event.duration_ms >= 0 ? { duration_ms: event.duration_ms } : {}),
    ...(typeof event.text === 'string' ? { text: event.text } : {}),
    ...(sessionKey(event.session) ? { session: sessionKey(event.session) } : {}),
  };
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Avoid world-readable journals even when the caller has a permissive umask.
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
  try { fs.writeSync(fd, JSON.stringify(record) + '\n'); }
  finally { fs.closeSync(fd); }
  // Keep storage bounded. The feed is an ephemeral view, not a durable audit log.
  if (fs.statSync(filePath).size > MAX_JOURNAL_BYTES) {
    const recent = readSyncEvents({ limit: 150 }, filePath).events;
    const temporary = filePath + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, recent.map(line => JSON.stringify(line)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, filePath);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return record;
}

export function readSyncEvents({ after = '', limit = 100 } = {}, filePath = CHAT_SYNC_FILE) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || typeof after !== 'string' || after.length > 128) {
    throw new Error('Invalid sync cursor or limit');
  }
  let fd;
  try { fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === 'ENOENT') return { events: [], cursor: after };
    throw error;
  }
  let contents;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Sync journal is not a regular file');
    const start = Math.max(0, stat.size - MAX_READ_BYTES);
    const bytes = Buffer.alloc(stat.size - start);
    const count = fs.readSync(fd, bytes, 0, bytes.length, start);
    contents = bytes.subarray(0, count).toString('utf8');
    if (start > 0) contents = contents.slice(contents.indexOf('\n') + 1);
  } finally { fs.closeSync(fd); }
  const events = [];
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (typeof item.id === 'string' && typeof item.at === 'string') events.push(item);
    } catch { /* Recover partial final journal writes without showing malformed records. */ }
  }
  const tail = events.slice(-200);
  const index = after ? tail.findIndex(event => event.id === after) : -1;
  const selected = (index >= 0 ? tail.slice(index + 1) : tail).slice(-limit);
  return { events: selected, cursor: selected.at(-1)?.id ?? after };
}
