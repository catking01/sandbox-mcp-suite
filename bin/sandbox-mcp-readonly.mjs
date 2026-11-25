#!/usr/bin/env node
import { main } from '../lib/cli.mjs';
main(['serve', 'readonly', ...process.argv.slice(2)]).catch(error => {
  process.stderr.write(`sandbox-mcp-readonly: ${error.message}\n`);
  process.exitCode = 1;
});
