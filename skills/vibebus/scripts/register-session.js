#!/usr/bin/env node

import { createStore } from "../../../src/store.js";
import { callTool } from "../../../src/tools.js";

const [agent_id, cli = "custom", role = "agent", workspace = process.cwd()] = process.argv.slice(2);

if (!agent_id) {
  process.stderr.write("Usage: register-session.js <agent_id> [cli] [role] [workspace]\n");
  process.exit(2);
}

const result = await callTool(createStore({ env: process.env }), "register_agent", {
  agent_id,
  cli,
  role,
  workspace,
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
