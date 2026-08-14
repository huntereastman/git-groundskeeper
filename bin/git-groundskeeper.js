#!/usr/bin/env node

import { runCli } from '../src/cli.js';
import { isMaintenanceCommand, runMaintenanceCli } from '../src/maintenance-cli.js';

const argv = process.argv.slice(2);
const runner = isMaintenanceCommand(argv) ? runMaintenanceCli : runCli;

runner(argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
