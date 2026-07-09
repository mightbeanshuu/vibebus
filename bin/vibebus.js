#!/usr/bin/env node

import { createStore } from "../src/store.js";
import { callTool } from "../src/tools.js";

const HELP = `vibebus

Human terminal helper for the Vibe Bus MCP shared agent bus.

Usage:
  vibebus clients
  vibebus status
  vibebus register <agent_id> [cli] [role] [provider] [model]
  vibebus inbox <agent_id>
  vibebus send <from> <to> <message...>
  vibebus role <from> <role> <message...>
  vibebus broadcast <from> <message...>
  vibebus task <from> <title> <description...>
  vibebus handoff <from> <to> <title> <description...>
  vibebus tasks [status]
  vibebus claim <agent_id> <task_id>
  vibebus done <agent_id> <task_id> [note...]
  vibebus ack <agent_id> <message_id> [note...]
  vibebus thread <agent_id> <thread_id>
  vibebus wait <agent_id> [timeout_ms]

Options:
  --json   Print raw JSON output.

Legacy aliases also work: cli-team and cli-team-mcp.
`;

async function main(argv) {
  const store = createStore({ env: process.env });
  const json = argv.includes("--json");
  argv = argv.filter((arg) => arg !== "--json");
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
  } else if (command === "role") {
    const [from, role, ...message] = args;
    result = await callTool(store, "send_to_role", { from, role, message: message.join(" "), requires_ack: true });
  } else if (command === "broadcast") {
    const [from, ...message] = args;
    result = await callTool(store, "broadcast", { from, message: message.join(" ") });
  } else if (command === "task") {
    const [from, title, ...description] = args;
    result = await callTool(store, "create_task", { from, title, description: description.join(" ") });
  } else if (command === "handoff") {
    const [from, to, title, ...description] = args;
    result = await callTool(store, "handoff_task", { from, to, title, description: description.join(" ") });
  } else if (command === "tasks") {
    const [status] = args;
    result = await callTool(store, "list_tasks", { status });
  } else if (command === "claim") {
    const [agent_id, task_id] = args;
    result = await callTool(store, "claim_task", { agent_id, task_id });
  } else if (command === "done") {
    const [agent_id, task_id, ...note] = args;
    result = await callTool(store, "update_task", { agent_id, task_id, status: "done", note: note.join(" ") });
  } else if (command === "ack") {
    const [agent_id, message_id, ...note] = args;
    result = await callTool(store, "ack_message", { agent_id, message_id, note: note.join(" ") });
  } else if (command === "thread") {
    const [agent_id, thread_id] = args;
    result = await callTool(store, "read_thread", { agent_id, thread_id });
  } else if (command === "wait") {
    const [agent_id, timeout_ms] = args;
    result = await callTool(store, "wait_for_messages", { agent_id, unread_only: true, mark_read: true, timeout_ms });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(command, result));
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

function formatResult(command, result) {
  if (command === "clients") {
    return [
      `Vibe Bus clients (${result.clients.length})`,
      "",
      table(
        ["id", "provider", "label"],
        result.clients.map((client) => [client.id, client.provider, client.label]),
      ),
      "",
      "Tip: use `vibebus clients --json` for the raw MCP payload.",
    ].join("\n") + "\n";
  }

  if (command === "status") {
    return formatStatus(result);
  }

  if (command === "register") {
    const agent = result.agent;
    return `Registered ${agent.agent_id} as ${agent.role} (${agent.cli}${agent.provider ? `/${agent.provider}` : ""}).\n`;
  }

  if (command === "inbox" || command === "wait") {
    const header = command === "wait" ? `Inbox wait: ${result.timed_out ? "timed out" : "new messages"} (${result.waited_ms}ms)` : `Inbox (${result.messages.length})`;
    return `${header}\n\n${formatMessages(result.messages)}\n`;
  }

  if (command === "send" || command === "broadcast" || command === "role") {
    return formatMessageResult(result);
  }

  if (command === "task" || command === "handoff") {
    const parts = [`Task ${result.task.id}: ${result.task.title}`, `status=${result.task.status}`, `assignee=${result.task.assignee ?? "-"}`];
    if (result.message) {
      parts.push(`message=${result.message.id}`);
      parts.push(`thread=${result.message.thread_id}`);
    }
    if (result.pending_ack?.length) {
      parts.push(`pending_ack=${result.pending_ack.join(",")}`);
    }
    return `${parts.join("  ")}\n`;
  }

  if (command === "tasks") {
    return formatTasks(result.tasks);
  }

  if (command === "claim" || command === "done") {
    return `Task ${result.task.id}: ${result.task.status}  assignee=${result.task.assignee ?? "-"}  title=${result.task.title}\n`;
  }

  if (command === "ack") {
    return `Acked ${result.message.id}. Pending: ${result.pending_ack.length ? result.pending_ack.join(", ") : "none"}\n`;
  }

  if (command === "thread") {
    return `Thread ${result.thread_id}\n\n${formatMessages(result.messages)}\n`;
  }

  return `${JSON.stringify(result, null, 2)}\n`;
}

function formatStatus(result) {
  const sections = [
    "Vibe Bus status",
    "",
    `State: ${result.state_path}`,
    "",
    "Agents",
    result.agents.length ? table(["id", "cli", "role", "status", "note"], result.agents.map((agent) => [
      agent.agent_id,
      agent.cli,
      agent.role,
      agent.status ?? "-",
      agent.note ?? "",
    ])) : "No registered agents yet.",
    "",
    "Open tasks",
    result.open_tasks.length ? taskTable(result.open_tasks) : "No open tasks.",
    "",
    "Recent messages",
    result.recent_messages.length ? formatMessages(result.recent_messages) : "No messages yet.",
  ];

  return `${sections.join("\n")}\n`;
}

function formatMessageResult(result) {
  const message = result.message;
  const recipients = result.recipients?.join(",") || formatRecipient(message.to);
  const pending = result.pending_ack?.length ? `  pending_ack=${result.pending_ack.join(",")}` : "";
  return `Message ${message.id} -> ${recipients}  thread=${message.thread_id}  priority=${message.priority}${pending}\n`;
}

function formatMessages(messages) {
  if (!messages.length) {
    return "No messages.";
  }
  return table(
    ["id", "thread", "from", "to", "prio", "ack", "message"],
    messages.map((message) => [
      message.id,
      message.thread_id ?? "-",
      message.from,
      formatRecipient(message.to),
      message.priority ?? "normal",
      message.requires_ack ? ackSummary(message) : "-",
      message.message,
    ]),
  );
}

function formatTasks(tasks) {
  if (!tasks.length) {
    return "No tasks.\n";
  }
  return `${taskTable(tasks)}\n`;
}

function taskTable(tasks) {
  return table(
    ["id", "status", "assignee", "prio", "title"],
    tasks.map((task) => [
      task.id,
      task.status,
      task.assignee ?? "-",
      task.priority ?? "normal",
      task.title,
    ]),
  );
}

function table(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.min(34, Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length))),
  );
  const render = (row) => row.map((cell, index) => truncate(String(cell ?? ""), widths[index]).padEnd(widths[index])).join("  ").trimEnd();
  return [render(headers), render(headers.map((header, index) => "-".repeat(Math.min(header.length + 2, widths[index])))), ...rows.map(render)].join("\n");
}

function truncate(value, width) {
  if (value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function formatRecipient(to) {
  return Array.isArray(to) ? to.join(",") : to;
}

function ackSummary(message) {
  const acked = Object.keys(message.acks ?? {}).length;
  const total = message.recipients?.length ?? 0;
  return `${acked}/${total}`;
}
