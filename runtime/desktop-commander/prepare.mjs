import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultShell } from './platform.mjs';
// package.json overrides only Commander's sharp dependency to 0.35.5 for the
// upstream libvips/libheif/librsvg fixes. Its PDF image path uses raw input,
// resize and JPEG/WebP output, which remain supported in that release.
defaultShell();
const root = path.dirname(fileURLToPath(import.meta.url));
const upstream = path.join(root, 'node_modules/@wonderwhy-er/desktop-commander');
const pkg = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json')));
if (pkg.version !== '0.2.48') throw new Error('Review patches before upgrading Desktop Commander');
function patch(file, before, after) {
  const target = path.join(upstream, 'dist', file);
  const source = fs.readFileSync(target, 'utf8');
  if (source.includes(after)) return;
  const previous = (Array.isArray(before) ? before : [before]).find(value => source.includes(value));
  if (!previous) throw new Error(`Upstream patch mismatch: ${file}`);
  fs.writeFileSync(target, source.replace(previous, after));
}
patch('config.js', "const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');", "const CONFIG_DIR = process.env.SANDBOX_COMMANDER_STATE_DIR;\nif (!CONFIG_DIR || !path.isAbsolute(CONFIG_DIR)) throw new Error('Absolute SANDBOX_COMMANDER_STATE_DIR required');");
// Give sessions their own process group so cancellation includes ordinary descendants.
patch('terminal-manager.js', 'const childProcess = spawn(spawnConfig.executable, spawnConfig.args, spawnOptions);', 'const childProcess = spawn(spawnConfig.executable, spawnConfig.args, { ...spawnOptions, detached: process.platform !== "win32" });');
patch('terminal-manager.js', "const childProcess = spawn(spawnConfig.executable, spawnConfig.args, { ...spawnOptions, detached: process.platform !== \"win32\" });", "const childProcess = spawn(spawnConfig.executable, spawnConfig.args, { ...spawnOptions, detached: process.platform !== \"win32\" });\nglobalThis.sandboxCommanderProcessStarted?.(childProcess.pid);");
patch('terminal-manager.js', '            console.log(`Enhanced SSH command: ${enhancedCommand}`);', '            // Keep stdio free of diagnostics and do not log full commands.');
patch('terminal-manager.js',
`        this.sessions.set(childProcess.pid, session);`,
`        // A failed stdin write also emits an error after its callback.
        childProcess.stdin?.on('error', () => {});
        this.sessions.set(childProcess.pid, session);`);
patch('terminal-manager.js',
[String.raw`    sendInputToProcess(pid, input) {
        const session = this.sessions.get(pid);
        if (!session) {
            return false;
        }
        try {
            if (session.process.stdin && !session.process.stdin.destroyed) {
                // Ensure input ends with a newline for most REPLs
                const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
                session.process.stdin.write(inputWithNewline);
                return true;
            }
            return false;
        }
        catch (error) {
            console.error(` + '`Error sending input to process ${pid}:`' + String.raw`, error);
            return false;
        }
    }`,
String.raw`    async sendInputToProcess(pid, input, timeoutMs) {
        const stdin = this.sessions.get(pid)?.process.stdin;
        if (!stdin?.writable || stdin.destroyed) return false;

        const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
        const writeTimeoutMs = Math.min(Math.max(1000, timeoutMs), 2_147_483_647);
        let timer;
        try {
            return await new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Timed out writing to process stdin. Input delivery is unknown.')), writeTimeoutMs);
                stdin.write(inputWithNewline, error => resolve(!error));
            });
        }
        finally {
            clearTimeout(timer);
        }
    }`],
String.raw`    async sendInputToProcess(pid, input, timeoutMs) {
        const session = this.sessions.get(pid);
        const stdin = session?.process.stdin;
        if (!stdin?.writable || stdin.destroyed) return false;
        if (session.sandboxCommanderPendingInput) {
            throw new Error('Previous process stdin write is still pending. Input delivery is unknown; new input was not queued.');
        }

        const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
        const writeTimeoutMs = Math.min(Math.max(1000, timeoutMs), 2_147_483_647);
        const pending = {};
        session.sandboxCommanderPendingInput = pending;
        return await new Promise((resolve, reject) => {
            let completed = false;
            const finish = (success, error) => {
                if (completed) return;
                completed = true;
                clearTimeout(timer);
                stdin.removeListener('error', failed);
                stdin.removeListener('close', failed);
                if (session.sandboxCommanderPendingInput === pending) delete session.sandboxCommanderPendingInput;
                if (error) reject(error);
                else resolve(success);
            };
            const failed = () => finish(false);
            // A timeout cannot retract bytes already handed to the stream. Keep
            // this input pending until its callback, error or close settles it.
            const timer = setTimeout(() => reject(new Error('Timed out writing to process stdin. Input delivery is unknown.')), writeTimeoutMs);
            stdin.once('error', failed);
            stdin.once('close', failed);
            try {
                stdin.write(inputWithNewline, error => finish(!error));
            } catch (error) {
                finish(false, error);
            }
        });
    }`);
patch('tools/improved-process-tools.js',
    'const success = terminalManager.sendInputToProcess(pid, input);',
    'const success = await terminalManager.sendInputToProcess(pid, input, timeout_ms);');
// A forced line separator must never separate a valid UTF-16 surrogate pair.
patch('terminal-manager.js',
`            childProcess.stdout.on('data', (data) => {`,
`            // sandboxCommanderUtf8Streams: decode UTF-8 across pipe chunk boundaries.
            childProcess.stdout.setEncoding('utf8');
            childProcess.stderr.setEncoding('utf8');
            childProcess.stdout.on('data', (data) => {`);
patch('terminal-manager.js',
`            session.outputLines[lastIndex] = overlong.slice(0, MAX_LINE_CHARS);
            session.outputLines.push(overlong.slice(MAX_LINE_CHARS));`,
`            // sandboxCommanderUnicodeBoundary: keep supplementary characters intact.
            let splitAt = MAX_LINE_CHARS;
            const before = overlong.charCodeAt(splitAt - 1), after = overlong.charCodeAt(splitAt);
            if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) splitAt--;
            session.outputLines[lastIndex] = overlong.slice(0, splitAt);
            session.outputLines.push(overlong.slice(splitAt));`);
console.log('Prepared Desktop Commander 0.2.48: isolated configuration, process groups, stdin error handling and Unicode-safe forced line boundaries');
// JSON-RPC permits zero and empty-string request IDs; neither means "absent".
// SDK 1.32.2 still uses the same truthiness check as 1.29.0. Retain this
// existing correction until the upstream cancellation handler fixes it.
const sdk = path.join(root, 'node_modules/@modelcontextprotocol/sdk');
if (JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'))).version !== '1.32.2') throw new Error('Review cancellation patch before upgrading MCP SDK');
const protocolPath = path.join(sdk, 'dist/esm/shared/protocol.js');
const protocolSource = fs.readFileSync(protocolPath, 'utf8');
const cancelBefore = '        if (!notification.params.requestId) {';
const cancelAfter = '        // sandboxCommanderCancelId: preserve valid falsy JSON-RPC IDs.\n        if (notification.params.requestId === undefined || notification.params.requestId === null) {';
if (!protocolSource.includes(cancelAfter)) {
  if (protocolSource.split(cancelBefore).length !== 2) throw new Error('MCP SDK cancellation patch mismatch');
  fs.writeFileSync(protocolPath, protocolSource.replace(cancelBefore, cancelAfter));
}
console.log('Prepared MCP SDK 1.32.2: zero and empty-string cancellation IDs');
