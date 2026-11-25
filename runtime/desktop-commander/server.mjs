import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { processGroupExists as exists } from './process-group.mjs';
import { WORKBENCH_URI, SERVER_INSTANCE, workbenchTools, workbenchResource, runWorkbench } from './workbench.mjs';
import { appendSyncEvent, readSyncEvents } from './chat-sync.mjs';
import { createTerminalOutputReader, terminalOutputSchema, TERMINAL_OUTPUT_VERSION } from './terminal-output.mjs';
import { createRuntimeJournal } from './runtime-journal.mjs';
import { resolvePaths } from '../../lib/paths.mjs';
import { defaultShell } from './platform.mjs';

const shell = defaultShell();
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const state = path.resolve(process.env.SANDBOX_COMMANDER_STATE_DIR || path.join(resolvePaths().stateDir, 'commander'));
process.env.SANDBOX_COMMANDER_STATE_DIR = state;
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
const base = './node_modules/@wonderwhy-er/desktop-commander/dist/';
const { CONFIG_FILE } = await import(base + 'config.js');
const terminalSource = fs.readFileSync(new URL(base + 'terminal-manager.js', import.meta.url), 'utf8');
if (CONFIG_FILE !== path.join(state, 'config.json') || !['sandboxCommanderProcessStarted', 'sandboxCommanderUnicodeBoundary', 'sandboxCommanderUtf8Streams'].every(marker => terminalSource.includes(marker))) throw new Error('Run prepare.mjs after installing dependencies');
const processToolsSource = fs.readFileSync(new URL(base + 'tools/improved-process-tools.js', import.meta.url), 'utf8');
if (!terminalSource.includes("childProcess.stdin?.on('error', () => {});") ||
    !processToolsSource.includes('await terminalManager.sendInputToProcess(pid, input, timeout_ms)')) {
  throw new Error('Run prepare.mjs to apply the terminal stdin repair');
}
if (!fs.readFileSync(new URL('./node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js', import.meta.url), 'utf8').includes('sandboxCommanderCancelId')) throw new Error('Run prepare.mjs after installing dependencies');
const { configManager } = await import(base + 'config-manager.js');
const configFile = path.join(state, 'config.json');
if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, JSON.stringify({ ...configManager.getDefaultConfig(), allowedDirectories: [], telemetryEnabled: false, defaultShell: shell, fileReadLineLimit: 1000, fileWriteLineLimit: 1000, pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false }), { mode: 0o600, flag: 'wx' });
await configManager.init();
if ((await configManager.getValue('blockedCommands')) === undefined) await configManager.setValue('blockedCommands', configManager.getDefaultConfig().blockedCommands);
// This endpoint is explicitly host-wide. Do not inherit upstream's separate user settings.
await configManager.setValue('allowedDirectories', []);
const handlers = await import(base + 'handlers/index.js');
const { toolArgSchemas } = await import(base + 'tools/schemas.js');
const { searchManager } = await import(base + 'search-manager.js');
const { terminalManager } = await import(base + 'terminal-manager.js');
const readTerminalOutput = createTerminalOutputReader(terminalManager, { instance: SERVER_INSTANCE, defaultLength: await configManager.getValue('fileReadLineLimit') });
const journal = createRuntimeJournal({ filePath:path.join(state,'runtime-events.jsonl'), instance:SERVER_INSTANCE, version:TERMINAL_OUTPUT_VERSION });
const pendingCalls = new Set();
const tunnelPid = Number(process.env.SANDBOX_COMMANDER_TUNNEL_PID);
const protectedPids = new Set([process.pid, process.ppid]);
if (Number.isSafeInteger(tunnelPid) && tunnelPid > 1) protectedPids.add(tunnelPid);
const toolMap = {
  read_file: ['handleReadFile', 'Read a local file; supports line offsets and tail reads.'],
  read_multiple_files: ['handleReadMultipleFiles', 'Read several local files.'],
  write_file: ['handleWriteFile', 'Write or append a local file.'],
  edit_block: ['handleEditBlock', 'Replace a text block; checks expected replacement count.'],
  create_directory: ['handleCreateDirectory', 'Create a local directory.'],
  list_directory: ['handleListDirectory', 'List local directories with bounded depth.'],
  move_file: ['handleMoveFile', 'Move or rename a local file or directory.'],
  get_file_info: ['handleGetFileInfo', 'Read file metadata.'],
  start_search: ['handleStartSearch', 'Start a file-name or content search.'],
  get_more_search_results: ['handleGetMoreSearchResults', 'Page through search results.'],
  stop_search: ['handleStopSearch', 'Stop a search session.'],
  list_searches: ['handleListSearches', 'List search sessions.'],
  start_process: ['handleStartProcess', 'Run a shell command on this computer. timeout_ms is the initial wait, not a lifetime limit. Use cd in the command to select its directory.'],
  read_process_output: ['handleReadProcessOutput', 'Read process output with a separate cursor per Chat session and optional reader_id. Supports replayable cursor reads and non-consuming line offsets; returns exit status. Without an identity, returns a non-consuming tail.'],
  interact_with_process: ['handleInteractWithProcess', 'Send input to a running process, including a REPL.'],
  force_terminate: ['handleForceTerminate', 'Terminate a managed process group, including ordinary child processes.'],
  list_sessions: ['handleListSessions', 'List managed terminal sessions.'],
  list_processes: ['handleListProcesses', 'List processes visible to the current OS user.'],
  kill_process: ['handleKillProcess', 'Terminate a specified PID using current OS permissions.']
};
for (const [name, [handler]] of Object.entries(toolMap)) {
  if (typeof handlers[handler] !== 'function' || !toolArgSchemas[name]) throw new Error(`Missing upstream tool: ${name}`);
}
const groups = new Set();
globalThis.sandboxCommanderProcessStarted = pid => { if (Number.isInteger(pid) && pid > 1) groups.add(pid); };
const reaper = setInterval(() => { for (const pid of groups) if (!exists(pid)) groups.delete(pid); }, 1000);
reaper.unref();
async function terminate(pid) {
  if (!groups.has(pid)) throw new Error(`Unknown managed process group: ${pid}`);
  if (exists(pid)) process.kill(-pid, 'SIGTERM');
  for (let i = 0; i < 20 && exists(pid); i++) await new Promise(r => setTimeout(r, 50));
  if (exists(pid)) process.kill(-pid, 'SIGKILL');
  for (let i = 0; i < 20 && exists(pid); i++) await new Promise(r => setTimeout(r, 50));
  if (exists(pid)) throw new Error(`Process group ${pid} has not terminated`);
  groups.delete(pid);
}
const result = text => ({ content: [{ type: 'text', text }] });
const server = new Server({ name: 'sandbox-mcp-for-test', version: TERMINAL_OUTPUT_VERSION }, { capabilities: { tools: {}, resources: {} }, instructions: 'Local Desktop Commander tools on this host, running with the current OS user permissions. No project-root restriction. Use absolute paths. Commands and writes affect the real host. Only call open_workbench when the user explicitly wants the in-Chat UI. Sandbox Monitor is a separate read-only local app; ordinary tool status is recorded automatically, and progress text is shared only through workbench_sync_publish when the user requests it. For editor saves use workbench_read_file and workbench_save_file with the returned version. UI actions use the existing MCP route; no model API is called and the host determines Chat/Work availability and billing. Ordinary Sandbox MCP remains a separate read-only service. No multi-device, remote pairing, or document-generation tools. Process sessions last until completion, cancellation, or this MCP process stops.' });
const localReads = new Set(['read_file', 'read_multiple_files', 'list_directory', 'get_file_info', 'get_more_search_results', 'list_searches', 'read_process_output', 'list_sessions', 'list_processes']);
const destructiveTools = new Set(['write_file', 'edit_block', 'move_file', 'start_process', 'interact_with_process', 'force_terminate', 'kill_process']);
// Bound the only collection validated element-by-element by the exposed
// Commander Zod 3 schemas, before parsing can allocate one issue per item.
// Zod 3's .max() still parses every element, so it is not a sufficient guard.
const MAX_READ_FILE_PATHS = 100;
function inputSchema(name) {
  if (name === 'read_process_output') return terminalOutputSchema;
  const schema = zodToJsonSchema(toolArgSchemas[name], { $refStrategy: 'none' });
  if (name === 'read_multiple_files') schema.properties.paths.maxItems = MAX_READ_FILE_PATHS;
  return schema;
}
const syncTools = [
  {
    name: 'workbench_sync_publish',
    title: '同步 Chat 公开思路与任务进度',
    description: 'Explicitly publish a user-facing approach summary, stage progress, or final summary to the user-owned Sandbox Monitor. Never publish hidden chain-of-thought; approach means a brief public rationale only. The user must request synchronization.' ,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['request','approach','progress','final','note'] },
        text: { type: 'string', minLength: 1, maxLength: 8000 }
      },
      required: ['kind','text']
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true }
  },
  {
    name: 'workbench_sync_status',
    title: '读取本地工作台共享状态',
    description: 'Read the latest user-owned Chat/MCP and local-workbench activity events. This does not read the complete ChatGPT conversation history.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      after: { type: 'string', maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: 200 }
    } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true }
  }
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  ...Object.entries(toolMap).map(([name, [, description]]) => ({ name, description, inputSchema: inputSchema(name),
    _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
    annotations: { readOnlyHint: localReads.has(name), destructiveHint: destructiveTools.has(name), idempotentHint: ['list_directory', 'get_file_info', 'list_searches', 'list_sessions', 'list_processes'].includes(name), openWorldHint: ['start_process', 'interact_with_process'].includes(name) } })),
  ...workbenchTools,
  ...syncTools,
] }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: WORKBENCH_URI, name: 'Sandbox MCP 本机工作台', mimeType: 'text/html;profile=mcp-app', description: 'Chat 内嵌的文件、终端、搜索和 Git 工作台' }] }));
server.setRequestHandler(ReadResourceRequestSchema, async request => {
  if (request.params.uri !== WORKBENCH_URI) throw new Error('Unknown UI resource');
  return workbenchResource();
});
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;
  const chatSession = request.params?._meta?.['openai/session'];
  const monitored = name !== 'workbench_sync_publish' && name !== 'workbench_sync_status';
  const operation = monitored ? crypto.randomUUID() : null;
  const startedAt = process.hrtime.bigint();
  if (monitored) {
    pendingCalls.add(operation);
    // A start event records a received MCP request, not ChatGPT's private reasoning.
    // Do not store tool parameters, file contents, or model-provided prompts.
    try { appendSyncEvent({ source: 'chat_mcp', kind: 'tool', name, status: 'started', operation, session: chatSession }); }
    catch { /* A monitor outage cannot block the original tool call. */ }
  }
  let outcome = 'ok';
  try {
    if (stopping) throw new Error('MCP server is stopping');
    if (name === 'workbench_sync_publish') {
      if (!args || !['request','approach','progress','final','note'].includes(args.kind)
          || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 8000
          || Object.keys(args).some(k => !['kind','text'].includes(k))) {
        throw new Error('Invalid workbench_sync_publish parameters');
      }
      const event = appendSyncEvent({ source: 'chat_mcp', kind: args.kind, text: args.text, session: chatSession });
      return { structuredContent: { id: event.id, at: event.at, published: true }, ...result('Shared with local Sandbox Monitor') };
    }
    if (name === 'workbench_sync_status') {
      if (!args || Object.keys(args).some(k => !['after','limit'].includes(k))) throw new Error('Invalid workbench_sync_status parameters');
      const events = readSyncEvents({ after: args.after ?? '', limit: args.limit ?? 50 });
      return { structuredContent: events, ...result('Local sync events: ' + events.events.length) };
    }
    if (workbenchTools.some(tool => tool.name === name)) {
      const data = runWorkbench(name, args, terminalManager);
      return { structuredContent: data, ...result(name === 'open_workbench' ? `本机工作台已打开: ${data.cwd}。界面不可用时仍可使用文件、终端和搜索工具。` : `${name}: ${data.path ?? data.root ?? data.cwd ?? data.pid ?? 'ok'}`) };
    }
    if (!Object.hasOwn(toolMap, name)) throw new Error(`Unknown tool: ${name}`);
    if (name === 'read_process_output') return await readTerminalOutput(args, chatSession, { signal:extra?.signal });
    if (name === 'read_multiple_files' && Array.isArray(args.paths) && args.paths.length > MAX_READ_FILE_PATHS) {
      throw new Error(`read_multiple_files accepts at most ${MAX_READ_FILE_PATHS} paths per call; split the request into smaller batches`);
    }
    toolArgSchemas[name].parse(args);
    if (['kill_process', 'force_terminate'].includes(name) && (!Number.isSafeInteger(args.pid) || args.pid <= 1 || protectedPids.has(args.pid))) throw new Error('A positive target PID other than the MCP, supervisor, or Tunnel process is required');
    if (name === 'read_file' && args.isUrl) throw new Error('This endpoint exposes local file reads only');
    if (name === 'force_terminate') { await terminate(args.pid); return result(`Process group ${args.pid} terminated`); }
    const response = await handlers[toolMap[name][0]](args);
    if (name === 'start_process' && !response.isError) {
      const firstText = response.content?.find(c => c.type === 'text')?.text ?? '';
      const pid = Number(firstText.match(/^(?:Process|Node\.js session) started with PID (-?\d+)/)?.[1]);
      if (Number.isSafeInteger(pid) && pid > 1) response.structuredContent = { pid };
    }
    // Remove completed, empty groups to avoid retaining stale PIDs.
    for (const pid of groups) if (!exists(pid)) groups.delete(pid);
    if (response.isError) outcome = 'error';
    return response;
  } catch (error) {
    outcome = name === 'read_process_output' && extra?.signal?.aborted ? 'cancelled' : 'error';
    if (outcome === 'cancelled') journal('read_cancelled', { pending_calls:pendingCalls.size });
    return { ...result(error.message), isError: true };
  } finally {
    pendingCalls.delete(operation);
    if (monitored) {
      const duration_ms = Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6));
      // Duration is MCP request elapsed time, not AI thinking time or a child process lifetime.
      try { appendSyncEvent({ source: 'chat_mcp', kind: 'tool', name, status: outcome, operation, duration_ms, session: chatSession }); }
      catch { /* A dashboard failure must not alter the original tool outcome. */ }
    }
  }
});
let stopping = false;
async function shutdown(reason = 'unknown', error) {
  if (stopping) return;
  stopping = true;
  journal('shutdown_started', { reason, code:error?.code, active_terminals:terminalManager.listActiveSessions().length, active_searches:searchManager.listSearchSessions().length, pending_calls:pendingCalls.size });
  let failed = false;
  for (const s of searchManager.listSearchSessions()) searchManager.terminateSearch(s.id);
  for (const pid of groups) { try { await terminate(pid); } catch (e) { failed = true; process.stderr.write(`${e.message}\n`); } }
  if (process.env.SANDBOX_MANAGED_TUNNEL === '1') {
    try {
      const parent = execFileSync('/bin/ps', ['-p', String(process.ppid), '-o', 'comm='], {encoding:'utf8'}).trim();
      if (path.basename(parent) === 'tunnel-client') {
        journal('parent_restart_requested', { reason, requested:true });
        process.kill(process.ppid, 'SIGTERM');
      }
    } catch (error) { journal('parent_restart_requested', { reason, requested:false, failed:true, code:error?.code }); }
  }
  await server.close();
  journal('shutdown_finished', { reason, exit_code:failed ? 1 : 0 });
  process.exit(failed ? 1 : 0);
}
process.on('SIGTERM', () => shutdown('sigterm'));
process.on('SIGINT', () => shutdown('sigint'));
process.stdin.on('end', () => shutdown('stdin_end'));
process.stdout.on('error', error => shutdown('stdout_error', error));
server.onerror = error => journal('protocol_error', { code:error?.code });
server.onclose = () => journal('transport_closed', { pending_calls:pendingCalls.size });
await server.connect(new StdioServerTransport());
journal('startup', { active_terminals:0, active_searches:0, pending_calls:0 });
