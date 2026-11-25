#!/usr/bin/env node
// Read-only localhost monitor for Sandbox MCP for test activity.
// No filesystem writes, terminal, Codex app-server, model API or ChatGPT scraping.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHAT_SYNC_FILE, readSyncEvents } from './chat-sync.mjs';
import { defaultShell, browserCommand } from './platform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(here, 'local-monitor.html'), 'utf8');

export function parseArgs(argv) {
  let port = 0, open = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i]);
    else if (argv[i] === '--open') open = true;
    else throw new Error('Unsupported monitor option: ' + argv[i]);
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid local monitor port');
  }
  return { port, open };
}
function reply(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(data) + '\n');
}
export function createLocalWorkbench({ syncFile = CHAT_SYNC_FILE } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer((req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const host = req.headers.host;
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) {
      return reply(res, 421, { error: 'Host rejected' });
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      return reply(res, 400, { error: 'Invalid local request' });
    }
    const url = new URL(req.url, 'http://' + host);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; form-action 'none'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer'
      });
      return res.end(page);
    }
    if (req.method === 'GET' && url.pathname === '/api/sync') {
      if (req.headers['x-local-workbench-token'] !== token) {
        return reply(res, 403, { error: 'Unauthorized local monitor' });
      }
      try {
        const events = readSyncEvents({
          after: url.searchParams.get('after') ?? '',
          limit: 150
        }, syncFile);
        // This window monitors Chat/MCP, not the standalone app's historical UI actions.
        return reply(res, 200, { events: events.events.filter(e => e.source === 'chat_mcp'), cursor: events.cursor });
      } catch (error) {
        return reply(res, 400, { error: error.message });
      }
    }
    // No commands, file writes, approvals or local model invocations are exposed.
    return reply(res, 404, { error: 'Monitor is read-only' });
  });
  return {
    server,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return 'http://127.0.0.1:' + server.address().port + '/#token=' + token;
    },
    async close() {
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  defaultShell();
  const options = parseArgs(process.argv.slice(2));
  const monitor = createLocalWorkbench();
  const url = await monitor.listen(options.port);
  // Only the native launcher captures this line; do not log the token elsewhere.
  process.stdout.write('SANDBOX_WORKBENCH_URL ' + url + '\n');
  if (options.open) execFile(browserCommand(), [url], error => {
    if (error) process.stderr.write('Could not open the browser automatically. Open the local monitor URL printed above.\n');
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await monitor.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
