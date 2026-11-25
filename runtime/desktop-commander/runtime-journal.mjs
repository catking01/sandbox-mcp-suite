import fs from 'node:fs';
import path from 'node:path';

const events = new Set(['startup','shutdown_started','parent_restart_requested','shutdown_finished','protocol_error','transport_closed','read_cancelled']);
const reasons = new Set(['sigterm','sigint','stdin_end','stdout_error','transport_closed','unknown']);

// Best-effort diagnostics: never record tool arguments, output, request IDs or error text.
export function createRuntimeJournal({ filePath, instance, version, maxBytes = 256 * 1024 }) {
  return (event, details = {}) => {
    let fd;
    try {
      if (!events.has(event)) return false;
      const record = { schema:'sandbox_runtime_event.v1', at:new Date().toISOString(), instance, version, pid:process.pid, ppid:process.ppid, event };
      if (reasons.has(details.reason)) record.reason = details.reason;
      if (typeof details.code === 'string' && /^[A-Z_0-9-]{1,32}$/.test(details.code)) record.code = details.code;
      for (const key of ['active_terminals','active_searches','pending_calls','exit_code']) if (Number.isSafeInteger(details[key]) && details[key] >= 0) record[key] = details[key];
      if (typeof details.requested === 'boolean') record.requested = details.requested;
      if (typeof details.failed === 'boolean') record.failed = details.failed;
      const line = JSON.stringify(record) + '\n';
      fs.mkdirSync(path.dirname(filePath), { recursive:true, mode:0o700 });
      fd = fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return false;
      if (stat.size + Buffer.byteLength(line) > maxBytes) {
        const bytes = Buffer.alloc(Math.min(stat.size, Math.floor(maxBytes / 2)));
        fs.readSync(fd, bytes, 0, bytes.length, stat.size - bytes.length);
        const tail = bytes.toString('utf8');
        const retained = tail.slice(tail.indexOf('\n') + 1).split('\n').filter(Boolean).slice(-64).join('\n');
        fs.ftruncateSync(fd, 0);
        if (retained) fs.writeSync(fd, retained + '\n');
      }
      fs.writeSync(fd, line);
      return true;
    } catch { return false; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  };
}
