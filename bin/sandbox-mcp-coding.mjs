#!/usr/bin/env node
import { main } from '../lib/cli.mjs';
main(['serve', 'coding', ...process.argv.slice(2)]).catch(error => {
  process.stderr.write(`sandbox-mcp-coding: ${error.message}\n`);
  process.exitCode = 1;
});
