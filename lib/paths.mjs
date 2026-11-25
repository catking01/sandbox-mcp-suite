import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function resolvePaths({ env = process.env, home = os.homedir() } = {}) {
  const selected = env.SANDBOX_MCP_HOME || path.join(home, '.sandbox-mcp');
  if (!path.isAbsolute(selected)) throw new Error('SANDBOX_MCP_HOME must be an absolute path');
  const root = path.resolve(selected);
  return {
    home: root,
    configDir: path.join(root, 'config'),
    stateDir: path.join(root, 'state'),
    logsDir: path.join(root, 'logs'),
    tunnelDir: path.join(root, 'tunnel'),
  };
}

// Persist explicit configuration choices without inheriting unrelated process
// state or credentials. Resolve relative paths before a launcher changes cwd.
export function configOverrides(profile, env = process.env) {
  if (!['readonly', 'coding'].includes(profile)) throw new Error('Profile must be readonly or coding');
  const selected = profile === 'readonly' ? {
    SANDBOX_MCP_READONLY_CONFIG: env.SANDBOX_MCP_READONLY_CONFIG,
    SANDBOX_MCP_PERMISSIONS_CONFIG: env.SANDBOX_MCP_PERMISSIONS_CONFIG || env.LOCAL_EVIDENCE_PERMISSIONS_CONFIG,
    LOCAL_EVIDENCE_DENYLIST_CONFIG: env.LOCAL_EVIDENCE_DENYLIST_CONFIG,
    LOCAL_EVIDENCE_FILE_POLICY_CONFIG: env.LOCAL_EVIDENCE_FILE_POLICY_CONFIG,
  } : { SANDBOX_MCP_CODING_CONFIG: env.SANDBOX_MCP_CODING_CONFIG };
  return Object.fromEntries(Object.entries(selected).filter(([, value]) => value).map(([name, value]) => [name, path.resolve(value)]));
}
