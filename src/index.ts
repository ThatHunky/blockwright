#!/usr/bin/env node
import { NAME, VERSION } from './version.js';

if (process.argv.includes('--version')) {
  console.log(`${NAME} ${VERSION}`);
  process.exit(0);
}
console.error(`${NAME} ${VERSION}: run with --version; the MCP server entry arrives in a later task`);
process.exit(1);
