export function processGroupExists(pid, kill = process.kill) {
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // kill(2) uses EPERM when the group exists but cannot be signaled.
    // Treat it as live so the MCP reaper cannot crash the stdio server.
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}
