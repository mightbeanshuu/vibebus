#!/usr/bin/env node

import { createStore } from "../src/store.js";
import { callTool } from "../src/tools.js";

const HELP = `vibebus

Human terminal helper for the VibeBus MCP shared agent bus.

Usage:
  vibebus clients
  vibebus status
  vibebus register <agent_id> [cli] [role] [provider] [model]
  vibebus inbox <agent_id>
  vibebus send <from> <to> <message...>
  vibebus broadcast <from> <message...>
  vibebus task <from> <title> <description...>
  vibebus tasks [status]
  vibebus claim <agent_id> <task_id>
  vibebus done <agent_id> <task_id> [note...]

Legacy aliases also work: cli-team and cli-team-mcp.
`;

async function main(argv) {
  const store = createStore({ env: process.env });
  const [command, ...args] = argv;

  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return;
  }

  let result;

  if (command === "clients") {
    result = await callTool(store, "known_clients", {});
  } else if (command === "status") {
    result = await callTool(store, "team_status", {});
  } else if (command === "register") {
    const [agent_id, cli = "manual", role = "agent", provider, model] = args;
    result = await callTool(store, "register_agent", { agent_id, cli, role, provider, model });
  } else if (command === "inbox") {
    const [agent_id] = args;
    result = await callTool(store, "read_inbox", { agent_id, mark_read: true });
  } else if (command === "send") {
    const [from, to, ...message] = args;
    result = await callTool(store, "send_message", { from, to, message: message.join(" ") });
  } else if (command === "broadcast") {
    const [from, ...message] = args;
    result = await callTool(store, "broadcast", { from, message: message.join(" ") });
  } else if (command === "task") {
    const [from, title, ...description] = args;
    result = await callTool(store, "create_task", { from, title, description: description.join(" ") });
  } else if (command === "tasks") {
    const [status] = args;
    result = await callTool(store, "list_tasks", { status });
  } else if (command === "claim") {
    const [agent_id, task_id] = args;
    result = await callTool(store, "claim_task", { agent_id, task_id });
  } else if (command === "done") {
    const [agent_id, task_id, ...note] = args;
    result = await callTool(store, "update_task", { agent_id, task_id, status: "done", note: note.join(" ") });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
