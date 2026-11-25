import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultShell } from './platform.mjs';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));

function isTunnelClient(pid) {
  try {
    const executable = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.basename(executable) === 'tunnel-client';
  } catch {
    return false;
  }
}

export function runManagedStdio({
  processObject = process,
  spawnChild = spawn,
  childServerPath = serverPath,
  isManagedParent = isTunnelClient,
  signalParent = (pid, signal) => processObject.kill(pid, signal),
  startupGraceMs = 1000,
} = {}) {
  defaultShell();
  const parentPid = processObject.ppid;
  const managedMode = processObject.env.SANDBOX_MANAGED_TUNNEL === '1';
  const startedAt = performance.now();
  const childEnv = { ...processObject.env };
  delete childEnv.SANDBOX_MANAGED_TUNNEL;
  delete childEnv.SANDBOX_COMMANDER_TUNNEL_PID;
  if (managedMode && parentPid > 1) childEnv.SANDBOX_COMMANDER_TUNNEL_PID = String(parentPid);

  let child;
  let stopping = false;
  let finished = false;

  const removeSignalHandlers = () => {
    processObject.removeListener('SIGINT', handleSigint);
    processObject.removeListener('SIGTERM', handleSigterm);
  };

  const requestParentRestart = () => {
    if (!managedMode || parentPid <= 1 || parentPid !== processObject.ppid) {
      processObject.stderr?.write('managed-stdio: parent restart skipped because managed parent identity is unavailable\n');
      return;
    }
    if (!isManagedParent(parentPid)) {
      processObject.stderr?.write('managed-stdio: parent restart skipped because parent is not tunnel-client\n');
      return;
    }
    try {
      signalParent(parentPid, 'SIGTERM');
      processObject.stderr?.write('managed-stdio: requested Tunnel restart after stdio child exit\n');
    } catch {
      // The supervisor still exits. The parent may already be stopping.
      processObject.stderr?.write('managed-stdio: failed to request Tunnel restart\n');
    }
  };

  const requestParentRestartAfterStartupGrace = () => {
    const remaining = Math.max(0, startupGraceMs - (performance.now() - startedAt));
    if (remaining === 0) {
      requestParentRestart();
      return;
    }
    setTimeout(requestParentRestart, remaining);
  };

  const finish = (exitCode, signal, error) => {
    if (finished) return;
    finished = true;
    processObject.exitCode = exitCode ?? (stopping ? 0 : 1);
    removeSignalHandlers();
    if (error) processObject.stderr?.write('managed-stdio: stdio child failed to start\n');
    if (!stopping) {
      if (!error) {
        const exitDetail = signal ? `signal=${signal}` : `exit=${processObject.exitCode}`;
        processObject.stderr?.write(`managed-stdio: stdio child exited unexpectedly (${exitDetail})\n`);
      }
      requestParentRestartAfterStartupGrace();
    }
  };

  const handleSigint = () => stopChild('SIGINT');
  const handleSigterm = () => stopChild('SIGTERM');

  function stopChild(signal) {
    if (stopping || finished) return;
    stopping = true;
    try {
      if (child && !child.killed) child.kill(signal);
      else finish(1);
    } catch {
      finish(1);
    }
  }

  processObject.on('SIGINT', handleSigint);
  processObject.on('SIGTERM', handleSigterm);

  try {
    child = spawnChild(processObject.execPath, [childServerPath], {
      cwd: processObject.cwd(),
      env: childEnv,
      stdio: 'inherit',
    });
  } catch {
    finish(1, undefined, true);
    return { stop: stopChild };
  }

  child.once('error', error => finish(1, undefined, error));
  child.once('exit', (code, signal) => finish(code, signal));

  return { child, stop: stopChild };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runManagedStdio();
}
