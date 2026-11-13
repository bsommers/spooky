#!/usr/bin/env node
// Executable entry point: `ghostwriter ...`. All logic lives in ./main.ts so it can be tested in-process.
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2));
