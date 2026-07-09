#!/usr/bin/env node

import { runMcpServer } from "../src/mcp-server.js";

runMcpServer({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
