import { spawn } from 'node:child_process';

// A real local stdio handshake; no model, shell command, Tunnel or network call.
export function probeStdio({ command, args, env, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', settled = false, reply, expectedId = 1;
    const stop = () => {
      child.stdin.end();
      const terminate = setTimeout(() => child.kill('SIGTERM'), 500);
      const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
      terminate.unref(); kill.unref();
      child.once('close', () => { clearTimeout(terminate); clearTimeout(kill); });
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error); else resolve(value);
    };
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const timer = setTimeout(() => finish(new Error(`Local MCP handshake timed out after ${timeoutMs}ms${stderr ? ': ' + stderr.trim() : ''}`)), timeoutMs);
    child.on('error', error => finish(error));
    child.stdin.on('error', error => { if (!settled) finish(error); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      if (settled) return;
      buffer += data;
      if (buffer.length > 2 * 1024 * 1024) return finish(new Error('MCP probe output exceeded its limit'));
      for (let at; (at = buffer.indexOf('\n')) !== -1;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { return finish(new Error('Non-JSON output on MCP stdout')); }
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
          return finish(new Error('Invalid JSON-RPC message on MCP stdout'));
        }
        if (message.id !== 1 && message.id !== 2) continue;
        if (message.id !== expectedId) return finish(new Error('Unexpected MCP response order'));
        if (message.error) return finish(new Error(`MCP: ${message.error.message}`));
        if (message.id === 1) {
          const server = message.result?.serverInfo;
          if (!server || typeof server.name !== 'string' || typeof server.version !== 'string' ||
              typeof message.result.protocolVersion !== 'string' || !message.result.protocolVersion) {
            return finish(new Error('Incomplete MCP initialize response'));
          }
          reply = message.result;
          expectedId = 2;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else {
          if (!Array.isArray(message.result?.tools) || message.result.tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.name)) {
            return finish(new Error('Invalid MCP tools/list response'));
          }
          return finish(null, { server: reply.serverInfo, protocolVersion: reply.protocolVersion, tools: message.result.tools.map(tool => tool.name) });
        }
      }
    });
    child.on('close', (code, signal) => {
      if (!settled) finish(new Error(`MCP exited before discovery (${code ?? signal})${stderr ? ': ' + stderr.trim() : ''}`));
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sandbox-mcp-doctor', version: '0.1.0' } } });
  });
}
