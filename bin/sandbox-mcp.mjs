#!/usr/bin/env node
import { main } from '../lib/cli.mjs';
main().catch(error => {
  process.stderr.write(`sandbox-mcp: ${error.message}\n`);
  process.exitCode = 1;
});
