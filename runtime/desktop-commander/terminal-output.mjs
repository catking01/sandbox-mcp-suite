// Reader-isolated views over the pinned Desktop Commander retained output buffer.
// Positions are UTF-16 code units in its normalized buffer, never stdout byte offsets.
import crypto from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

export const TERMINAL_OUTPUT_VERSION = '1.2.2';
const MAX_CHARS = 128 * 1024;
const integer = (value, fallback, min, max, name) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
};
export const terminalOutputSchema = {
  type: 'object', additionalProperties: false, required: ['pid'], properties: {
    pid: { type: 'integer', minimum: 2 },
    timeout_ms: { type: 'integer', minimum: 0, maximum: 60000 },
    offset: { type: 'integer', description: '0: reader-isolated incremental output; negative: tail; positive: line index in the retained buffer. Nonzero offsets never consume a reader cursor.' },
    length: { type: 'integer', minimum: 1, maximum: 10000 },
    verbose_timing: { type: 'boolean' },
    reader_id: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional stable reader name, scoped to the current Chat session. It is a cursor namespace, not authorization.' },
    cursor: { type: 'string', minLength: 1, maxLength: 1024, description: 'Use start or the returned next_cursor for a stateless, replayable read. Cannot combine with reader_id or nonzero offset.' }
  }
};
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const checkCancelled = signal => {
  if (signal?.aborted) { const error = new Error('Output read cancelled'); error.name = 'AbortError'; throw error; }
};
function boundedText(text, length) {
  let end = Math.min(text.length, MAX_CHARS), at = 0;
  for (let i = 0; i < length; i++) {
    const newline = text.indexOf('\n', at);
    if (newline < 0 || newline >= end) break;
    at = newline + 1;
    if (i === length - 1) end = at;
  }
  // Do not split a surrogate pair at the response budget boundary.
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}
export function createTerminalOutputReader(manager, { instance, maxReaders = 1024, defaultLength = 1000 } = {}) {
  if (typeof instance !== 'string' || !instance) throw new Error('Server instance is required');
  const readers = new Map(), busy = new Set();
  function snapshot(pid) {
    const active = manager.getSession(pid);
    const session = active ?? manager.listCompletedSessions().find(s => s.pid === pid);
    if (!session) throw new Error(`No session found for PID ${pid}`);
    const started = new Date(session.startTime).getTime();
    if (!Number.isSafeInteger(started)) throw new Error('Process start identity is unavailable');
    const earliest = session.evictedChars ?? 0;
    const size = session.bufferedChars ?? Math.max(0, session.outputLines.reduce((sum, line) => sum + line.length + 1, 0) - 1);
    return { session, earliest, end: earliest + size, started,
      processKey: `${pid}:${started}`, running: Boolean(active), exitCode: active ? null : session.exitCode };
  }
  function cursorFor(pid, started, at) {
    return Buffer.from(JSON.stringify({ v: 1, instance, pid, started, at })).toString('base64url');
  }
  function parseCursor(value, pid, current) {
    if (value === 'start') return 0;
    let c;
    try { c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new Error('Invalid output cursor'); }
    if (c?.v !== 1 || c.instance !== instance || c.pid !== pid || c.started !== current.started) throw new Error('Output cursor belongs to another process or server instance');
    if (!Number.isSafeInteger(c.at) || c.at < 0 || c.at > current.end) throw new Error('Output cursor is outside the retained stream');
    return c.at;
  }
  function pruneReaders() {
    const live = new Set([...manager.listActiveSessions(), ...manager.listCompletedSessions()].map(s => {
      const session = manager.getSession(s.pid) ?? s;
      return `${s.pid}:${new Date(session.startTime).getTime()}`;
    }));
    for (const [key, value] of readers) if (!live.has(value.processKey) && !busy.has(key)) readers.delete(key);
  }
  return async function readTerminalOutput(args, chatSession, { signal } = {}) {
    const startedAt = Date.now();
    checkCancelled(signal);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid output arguments');
    for (const key of Object.keys(args)) if (!Object.hasOwn(terminalOutputSchema.properties, key)) throw new Error(`Unknown output argument: ${key}`);
    const pid = integer(args.pid, undefined, 2, Number.MAX_SAFE_INTEGER, 'pid');
    const offset = integer(args.offset, 0, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'offset');
    const length = integer(args.length, defaultLength, 1, 10000, 'length');
    const timeout = integer(args.timeout_ms, 5000, 0, 60000, 'timeout_ms');
    if (args.verbose_timing !== undefined && typeof args.verbose_timing !== 'boolean') throw new Error('verbose_timing must be boolean');
    for (const name of ['reader_id', 'cursor']) if (args[name] !== undefined && (typeof args[name] !== 'string' || !args[name].trim() || args[name].length > (name === 'reader_id' ? 128 : 1024))) throw new Error(`Invalid ${name}`);
    if (args.cursor !== undefined && (args.reader_id !== undefined || offset !== 0)) throw new Error('cursor cannot be combined with reader_id or nonzero offset');
    let current = snapshot(pid);
    const hasSession = typeof chatSession === 'string' && Boolean(chatSession.trim());
    const identity = hasSession ? digest(JSON.stringify(['session', chatSession, args.reader_id ?? 'default'])) : args.reader_id ? digest(JSON.stringify(['explicit', args.reader_id])) : null;
    const mode = offset !== 0 ? 'line_snapshot' : args.cursor !== undefined ? 'cursor' : identity ? 'reader' : 'stateless_tail';
    const key = mode === 'reader' ? `${current.processKey}:${identity}` : null;
    if (key && busy.has(key)) throw new Error('Reader already has an outstanding read; use a distinct reader_id or replayable cursor');
    if (key && !readers.has(key)) {
      pruneReaders();
      if (readers.size >= maxReaders) throw new Error('Reader capacity reached; use a stateless cursor');
      readers.set(key, { processKey: current.processKey, at: 0 });
    }
    if (key) busy.add(key);
    try {
      let at = mode === 'cursor' ? parseCursor(args.cursor, pid, current) : key ? readers.get(key).at : null;
      const processKey = current.processKey;
      if (at !== null) {
        const deadline = Date.now() + timeout;
        while (current.running && at >= current.end && Date.now() < deadline) {
          await pause(Math.min(25, deadline - Date.now()), undefined, { signal });
          checkCancelled(signal);
          current = snapshot(pid);
          if (current.processKey !== processKey) throw new Error('Process identity changed while reading');
        }
      }
      checkCancelled(signal);
      let from, output, dropped = 0, capped = false, omittedPrefix = 0;
      if (at !== null) {
        dropped = Math.max(0, current.earliest - at);
        from = Math.max(at, current.earliest);
        output = boundedText(current.session.outputLines.join('\n').slice(from - current.earliest), length);
        capped = from + output.length < current.end;
        if (key) readers.get(key).at = from + output.length;
      } else {
        const lines = current.session.outputLines;
        const first = mode === 'stateless_tail' ? Math.max(0, lines.length - length) : offset < 0 ? Math.max(0, lines.length + offset) : Math.min(offset, lines.length);
        from = current.earliest + lines.slice(0, first).reduce((sum, line) => sum + line.length + 1, 0);
        from = Math.min(from, current.end);
        const selected = lines.slice(first, first + length).join('\n');
        output = boundedText(selected, length);
        capped = output.length < selected.length;
        // With no identity, always show the latest retained content, not the oldest part of an oversized tail.
        if (mode === 'stateless_tail' && selected.length > MAX_CHARS) {
          let start = selected.length - MAX_CHARS;
          if (/[\uDC00-\uDFFF]/.test(selected[start]) && /[\uD800-\uDBFF]/.test(selected[start - 1])) start++;
          from += start; output = selected.slice(start); capped = true; omittedPrefix = start;
        }
      }
      const next = from + output.length;
      const hasMore = next < current.end;
      const data = { version: TERMINAL_OUTPUT_VERSION, instance, pid, process_started_at: new Date(current.started).toISOString(), mode,
        output, running: current.running, exit_code: current.exitCode,
        cursor_unit: 'normalized_buffer_utf16_code_units', from_char: from, next_char: next, earliest_char: current.earliest, total_chars: current.end,
        dropped_chars: dropped, retained_buffer_evicted_chars: current.earliest, truncated: capped,
        omitted_prefix_chars: omittedPrefix, has_more: hasMore, next_cursor: cursorFor(pid, current.started, next) };
      const notices = [];
      if (mode === 'stateless_tail') notices.push('No reader identity supplied: non-consuming tail. Use reader_id or next_cursor for incremental reads.');
      if (!hasSession && args.reader_id) notices.push('Explicit reader_id is a shared caller-chosen namespace; it is not an authorization identity.');
      if (dropped) notices.push(`${dropped} buffered code units were evicted before this reader consumed them.`);
      else if (current.earliest) notices.push(`The retained buffer starts after ${current.earliest} evicted code units; line offsets refer to retained lines.`);
      if (omittedPrefix) notices.push(`Tail preview omitted ${omittedPrefix} earlier code units from this response. next_cursor is at the end, not a way to recover that prefix; use cursor: start to read earlier retained output.`);
      if (capped && hasMore) notices.push('Response bounded; continue with next_cursor to read the remaining suffix.');
      if (!current.running) notices.push(`Process completed with exit code ${current.exitCode}`);
      if (args.verbose_timing) notices.push(`Timing: ${Date.now() - startedAt}ms`);
      return { structuredContent: data, content: [{ type: 'text', text: `[${mode}: ${output.length} code units]\n\n${output || '(No output in requested range)'}${notices.length ? '\n\n' + notices.join('\n') : ''}` }] };
    } finally { if (key) busy.delete(key); }
  };
}
