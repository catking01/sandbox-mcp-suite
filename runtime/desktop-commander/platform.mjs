// Process groups and shell behavior are supported on these POSIX platforms.
// Do not silently fall back to Windows semantics for process cancellation.
export function defaultShell(platform = process.platform) {
  if (platform === 'darwin') return '/bin/zsh';
  if (platform === 'linux') return '/bin/bash';
  throw new Error(`Sandbox MCP Commander supports macOS and Linux; platform ${platform} is not supported.`);
}

export function browserCommand(platform = process.platform) {
  defaultShell(platform);
  return platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
}
