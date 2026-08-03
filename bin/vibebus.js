#!/usr/bin/env node

import { startDashboard } from "../src/dashboard.js";
import { BusError } from "../src/errors.js";
import { describeAgent, planWake } from "../src/presence.js";
import { createStore } from "../src/store.js";
import { callTool } from "../src/tools.js";

const HELP = `vibebus — the local party line for CLI coding agents

Coordination
  vibebus status                          team overview
  vibebus who                             live presence board
  vibebus doctor                          check whether the bus is actually working
  vibebus clients                         known CLI/IDE client ids

Identity
  vibebus register <agent_id> [cli] [role] [provider] [model]

Talking
  vibebus send <from> <to> <message...>
  vibebus role <from> <role> <message...>
  vibebus broadcast <from> <message...>
  vibebus inbox <agent_id>
  vibebus thread <agent_id> <thread_id>
  vibebus ack <agent_id> <message_id> [note...]
  vibebus ask <from> <to> <question...>    blocking question, hard error if unanswered
  vibebus ping <from> <to>                 prove an agent is alive

Waking
  vibebus wake <from> <to> [reason...]     escalate until something reaches it
  vibebus sleep <agent_id> [block_ms]      park until woken
  vibebus wait <agent_id> [timeout_ms]     block for inbox traffic

Work
  vibebus task <from> <title> <description...>
  vibebus handoff <from> <to> <title> <description...>
  vibebus tasks [status]
  vibebus claim <agent_id> <task_id>
  vibebus done <agent_id> <task_id> [note...]
  vibebus lease <acquire|release|list> [agent_id] [paths...]
  vibebus ctx <get|set|list> [key] [value]

Watching
  vibebus watch [agent_id]                 live event stream in this terminal
  vibebus tail [since_seq]                 recent journal entries
  vibebus serve [port]                     localhost dashboard (default 7717)

Options
  --json    print the raw MCP payload

Legacy aliases also work: cli-team and cli-team-mcp.
`;

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (text) => c("2", text);
const bold = (text) => c("1", text);
const cyan = (text) => c("36", text);
const green = (text) => c("32", text);
const yellow = (text) => c("33", text);
const red = (text) => c("31", text);

async function main(argv) {
  const store = createStore({ env: process.env });
  const json = argv.includes("--json");
  argv = argv.filter((arg) => arg !== "--json");
  const [command, ...args] = argv;

  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return;
  }

  // Long-running commands own the process and never print a result payload.
  if (command === "watch") {
    return watch(store, args[0]);
  }
  if (command === "serve") {
    return serve(store, args[0]);
  }
  if (command === "doctor") {
    return doctor(store, json);
  }

  const result = await run(store, command, args);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(command, result, store));
  store.close();
}

async function run(store, command, args) {
  switch (command) {
    case "clients":
      return callTool(store, "known_clients", {});
    case "status":
      return callTool(store, "team_status", {});
    case "who":
      return callTool(store, "who", {});
    case "register": {
      const [agent_id, cli = "manual", role = "agent", provider, model] = args;
      return callTool(store, "register_agent", { agent_id, cli, role, provider, model });
    }
    case "inbox":
      return callTool(store, "read_inbox", { agent_id: args[0], mark_read: true });
    case "send": {
      const [from, to, ...message] = args;
      return callTool(store, "send_message", { from, to, message: message.join(" ") });
    }
    case "role": {
      const [from, role, ...message] = args;
      return callTool(store, "send_to_role", { from, role, message: message.join(" "), requires_ack: true });
    }
    case "broadcast": {
      const [from, ...message] = args;
      return callTool(store, "broadcast", { from, message: message.join(" ") });
    }
    case "ask": {
      const [from, to, ...question] = args;
      return callTool(store, "ask_agent", { from, to, question: question.join(" ") });
    }
    case "ping": {
      const [from, to] = args;
      return callTool(store, "ping_agent", { from, to });
    }
    case "wake": {
      const [from, to, ...reason] = args;
      return callTool(store, "wake_agent", { from, to, reason: reason.join(" ") || undefined, urgency: "high" });
    }
    case "sleep": {
      const [agent_id, block_ms] = args;
      return callTool(store, "sleep_agent", { agent_id, block_ms: block_ms ? Number(block_ms) : undefined });
    }
    case "task": {
      const [from, title, ...description] = args;
      return callTool(store, "create_task", { from, title, description: description.join(" ") });
    }
    case "handoff": {
      const [from, to, title, ...description] = args;
      return callTool(store, "handoff_task", { from, to, title, description: description.join(" ") });
    }
    case "tasks":
      return callTool(store, "list_tasks", { status: args[0] });
    case "claim":
      return callTool(store, "claim_task", { agent_id: args[0], task_id: args[1] });
    case "done": {
      const [agent_id, task_id, ...note] = args;
      return callTool(store, "update_task", { agent_id, task_id, status: "done", note: note.join(" ") });
    }
    case "ack": {
      const [agent_id, message_id, ...note] = args;
      return callTool(store, "ack_message", { agent_id, message_id, note: note.join(" ") });
    }
    case "thread":
      return callTool(store, "read_thread", { agent_id: args[0], thread_id: args[1] });
    case "wait":
      return callTool(store, "wait_for_messages", {
        agent_id: args[0],
        unread_only: true,
        mark_read: true,
        timeout_ms: args[1] ? Number(args[1]) : undefined,
      });
    case "lease": {
      const [action, agent_id, ...paths] = args;
      return callTool(store, "lease", { action, agent_id, paths });
    }
    case "ctx": {
      const [action, key, ...rest] = args;
      return callTool(store, "context", {
        action,
        agent_id: "cli",
        key,
        value: rest.length ? parseMaybeJson(rest.join(" ")) : undefined,
      });
    }
    case "tail":
      return callTool(store, "tail_events", { since_seq: Number(args[0] ?? 0), limit: 40 });
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

/** Stream the journal into this terminal until interrupted. */
function watch(store, agentId) {
  let cursor = store.seq();
  process.stdout.write(`${bold("Vibe Bus")} ${dim(`watching ${store.path} from seq ${cursor}`)}\n`);
  process.stdout.write(dim("Ctrl-C to stop.\n\n"));

  const drain = () => {
    const state = store.read();
    const events = state.events.filter((event) => event.seq > cursor);
    if (events.length === 0) {
      return;
    }
    cursor = state.seq;

    for (const event of events) {
      if (agentId && event.audience !== "*" && !(Array.isArray(event.audience) ? event.audience.includes(agentId) : event.audience === agentId)) {
        continue;
      }
      process.stdout.write(formatEvent(event));
    }
  };

  store.onChange(drain);
  drain();
  setInterval(() => {}, 1 << 30);
}

function serve(store, port) {
  const dashboard = startDashboard(store, { port: Number(port) || 7717 });
  process.stdout.write(`${bold("Vibe Bus dashboard")} ${cyan(dashboard.url)}\n`);
  process.stdout.write(dim(`streaming ${store.path}\nCtrl-C to stop.\n`));
  process.on("SIGINT", () => {
    dashboard.close();
    process.exit(0);
  });
}

/**
 * Answers the only question that matters when things go quiet: is the bus
 * broken, or is nobody home?
 */
async function doctor(store, json) {
  const state = store.read();
  const now = Date.now();
  const agents = Object.values(state.agents).map((agent) => describeAgent(agent, now));

  const writeProbe = (() => {
    try {
      const before = store.seq();
      store.update((draft) => {
        draft.doctor_probe_at = new Date().toISOString();
        return true;
      });
      return { ok: store.seq() >= before, seq: store.seq() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  })();

  const report = {
    state_path: store.path,
    bus_seq: state.seq,
    writable: writeProbe.ok,
    write_error: writeProbe.error ?? null,
    agents: agents.map((agent) => ({
      agent_id: agent.agent_id,
      presence: agent.presence,
      session_live: agent.session_live,
      reachable: agent.reachable,
      wake_plan: planWake(agent, { urgency: "high" }, now).plan,
      seconds_since_seen: agent.seconds_since_seen,
    })),
    stuck: {
      dead_letters: state.messages.filter((message) => message.dead_lettered).length,
      unanswered_asks: state.asks.filter((ask) => ask.status === "pending").length,
      undelivered_wakes: state.wakes.filter((wake) => wake.status === "pending").length,
      expired_leases: 0,
    },
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [
    bold("Vibe Bus doctor"),
    "",
    `${label("state file")} ${report.state_path}`,
    `${label("writable")} ${report.writable ? green("yes") : red(`no — ${report.write_error}`)}`,
    `${label("journal seq")} ${report.bus_seq}`,
    "",
    bold("Agents"),
  ];

  if (agents.length === 0) {
    lines.push(dim("  none registered — start a CLI and have it call register_agent"));
  } else {
    for (const agent of report.agents) {
      const reach = Object.entries(agent.reachable)
        .filter(([, value]) => value)
        .map(([key]) => key)
        .join(" ");
      lines.push(
        `  ${cyan(agent.agent_id.padEnd(20))} ${presenceColor(agent.presence)}  ` +
          `${dim(`last seen ${agent.seconds_since_seen ?? "?"}s ago`)}  ${dim(`reachable: ${reach || "bus only"}`)}`,
      );
    }
  }

  lines.push("", bold("Stuck work"));
  const stuck = report.stuck;
  const anyStuck = stuck.dead_letters + stuck.unanswered_asks + stuck.undelivered_wakes > 0;
  lines.push(
    `  ${stuck.dead_letters ? red(`${stuck.dead_letters} dead letters`) : green("0 dead letters")}  ` +
      `${stuck.unanswered_asks ? yellow(`${stuck.unanswered_asks} unanswered questions`) : green("0 unanswered questions")}  ` +
      `${stuck.undelivered_wakes ? yellow(`${stuck.undelivered_wakes} undelivered wakes`) : green("0 undelivered wakes")}`,
  );

  lines.push("");
  const reachableAgents = report.agents.filter((agent) => agent.reachable.session || agent.reachable.process);
  if (!report.writable) {
    lines.push(red("The bus itself is broken: the state file is not writable."));
  } else if (agents.length === 0) {
    lines.push(yellow("The bus is healthy but empty. Nothing can answer until an agent registers."));
  } else if (reachableAgents.length === 0) {
    lines.push(
      yellow("The bus is healthy, but no agent has a live session or a wake_command."),
      dim("Messages will land and wait; nothing will respond until a CLI reconnects."),
    );
  } else if (anyStuck) {
    lines.push(yellow("The bus is healthy and reachable, but work is piling up unanswered — see above."));
  } else {
    lines.push(green("Bus healthy, agents reachable, nothing stuck."));
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function label(text) {
  return dim(`${text.padEnd(14)}`);
}

function presenceColor(presence) {
  if (presence === "online") return green(presence.padEnd(8));
  if (presence === "offline") return red(presence.padEnd(8));
  return yellow(presence.padEnd(8));
}

function formatEvent(event) {
  const at = (event.at ?? "").slice(11, 19);
  const type = event.type.padEnd(18);
  const actor = (event.actor ?? "bus").padEnd(16);
  const detail =
    event.data?.preview ??
    event.data?.title ??
    event.data?.reason ??
    event.data?.summary ??
    (event.data?.paths ? event.data.paths.join(", ") : "") ??
    event.ref ??
    "";

  const paint = event.type === "wake" ? yellow : event.type.startsWith("ask") ? cyan : (text) => text;
  return `${dim(at)}  ${dim(String(event.seq).padStart(5))}  ${paint(type)} ${cyan(actor)} ${detail}\n`;
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof BusError) {
    process.stderr.write(`${red(error.code)}: ${error.message}\n`);
    if (error.hint) {
      process.stderr.write(`${dim(`hint: ${error.hint}`)}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatResult(command, result, store) {
  if (command === "clients") {
    return `${[
      `Vibe Bus clients (${result.clients.length})`,
      "",
      table(["id", "provider", "headless wake command"], result.clients.map((client) => [client.id, client.provider, client.headless ?? "-"])),
    ].join("\n")}\n`;
  }

  if (command === "status") {
    return formatStatus(result, store);
  }

  if (command === "who") {
    return `${[
      `Presence (${result.agents.length} agents)`,
      "",
      table(
        ["id", "presence", "session", "cli", "role", "reachable", "seen"],
        result.agents.map((agent) => [
          agent.agent_id,
          agent.presence,
          agent.session_live ? "live" : "-",
          agent.cli,
          agent.role,
          Object.entries(agent.reachable).filter(([, value]) => value).map(([key]) => key).join(","),
          `${agent.seconds_since_seen ?? "?"}s`,
        ]),
      ),
    ].join("\n")}\n`;
  }

  if (command === "register") {
    const agent = result.agent;
    return `Registered ${agent.agent_id} as ${agent.role} (${agent.cli}${agent.provider ? `/${agent.provider}` : ""}).\n`;
  }

  if (command === "inbox" || command === "wait") {
    const header =
      command === "wait"
        ? `Inbox wait: ${result.timed_out ? "timed out" : "new messages"} (${result.waited_ms}ms)`
        : `Inbox (${result.messages.length})`;
    return `${header}\n\n${formatMessages(result.messages)}\n`;
  }

  if (command === "send" || command === "broadcast" || command === "role") {
    const woke = result.woke?.length ? `  woke=${result.woke.join(",")}` : "";
    return `${formatMessageResult(result).trimEnd()}${woke}\n`;
  }

  if (command === "ask") {
    return `${green("answered")} by ${result.answered_by} in ${result.latency_ms}ms via ${result.via}\n\n${result.answer}\n`;
  }

  if (command === "ping") {
    return `${green("alive")} ${result.target} responded in ${result.latency_ms}ms\n`;
  }

  if (command === "wake") {
    return [
      `Wake ${result.wake.id} -> ${result.wake.to}`,
      `presence=${result.presence}  tiers=${result.plan.join(" -> ")}`,
      result.note,
      "",
    ].join("\n");
  }

  if (command === "sleep") {
    if (result.outcome === "woken") {
      return `${green("woken")} by ${result.woken_by}: ${result.wake_reason ?? ""}\n${result.unread_messages?.length ?? 0} unread message(s).\n`;
    }
    return `Sleep finished (${result.outcome ?? "parked"}).\n`;
  }

  if (command === "task" || command === "handoff") {
    const parts = [`Task ${result.task.id}: ${result.task.title}`, `status=${result.task.status}`, `assignee=${result.task.assignee ?? "-"}`];
    if (result.message) {
      parts.push(`message=${result.message.id}`, `thread=${result.message.thread_id}`);
    }
    if (result.pending_ack?.length) {
      parts.push(`pending_ack=${result.pending_ack.join(",")}`);
    }
    if (result.woke?.length) {
      parts.push(`woke=${result.woke.join(",")}`);
    }
    return `${parts.join("  ")}\n`;
  }

  if (command === "tasks") {
    return result.tasks.length ? `${taskTable(result.tasks)}\n` : "No tasks.\n";
  }

  if (command === "claim" || command === "done") {
    const unblocked = result.unblocked?.length ? `  unblocked=${result.unblocked.join(",")}` : "";
    return `Task ${result.task.id}: ${result.task.status}  assignee=${result.task.assignee ?? "-"}  ${result.task.title}${unblocked}\n`;
  }

  if (command === "ack") {
    return `Acked ${result.message.id}. Pending: ${result.pending_ack.length ? result.pending_ack.join(", ") : "none"}\n`;
  }

  if (command === "thread") {
    return `Thread ${result.thread_id}\n\n${formatMessages(result.messages)}\n`;
  }

  if (command === "lease") {
    if (result.leases) {
      return result.leases.length
        ? `${table(["id", "agent", "paths", "expires"], result.leases.map((item) => [item.id, item.agent_id, item.paths.join(", "), item.expires_at]))}\n`
        : "No files claimed.\n";
    }
    if (result.lease) {
      return `Leased ${result.lease.paths.join(", ")} to ${result.lease.agent_id} until ${result.lease.expires_at}\n`;
    }
    return `Released ${result.released.length} lease(s).\n`;
  }

  if (command === "ctx") {
    if (result.entries) {
      return result.entries.length
        ? `${table(["key", "v", "by", "value"], result.entries.map((entry) => [entry.key, entry.version, entry.updated_by, JSON.stringify(entry.value)]))}\n`
        : "No shared context yet.\n";
    }
    if (result.entry) {
      return `${result.entry.key} (v${result.entry.version}, by ${result.entry.updated_by})\n${JSON.stringify(result.entry.value, null, 2)}\n`;
    }
    return `Deleted ${result.deleted}\n`;
  }

  if (command === "tail") {
    return result.events.length ? result.events.map(formatEvent).join("") : "No events yet.\n";
  }

  return `${JSON.stringify(result, null, 2)}\n`;
}

function formatStatus(result, store) {
  const presence = Object.entries(result.presence ?? {})
    .map(([key, value]) => `${value} ${key}`)
    .join(", ");

  const sections = [
    bold("Vibe Bus status"),
    "",
    `${dim("state")} ${store?.path ?? result.state_path}   ${dim("seq")} ${result.bus_seq}   ${dim("presence")} ${presence || "none"}`,
    "",
    bold("Agents"),
    result.agents.length
      ? table(
          ["id", "presence", "cli", "role", "status", "note"],
          result.agents.map((agent) => [agent.agent_id, agent.presence, agent.cli, agent.role, agent.status ?? "-", agent.note ?? ""]),
        )
      : dim("No registered agents yet."),
    "",
    bold("Open tasks"),
    result.open_tasks.length ? taskTable(result.open_tasks) : dim("No open tasks."),
  ];

  if (result.leases?.length) {
    sections.push(
      "",
      bold("Leases"),
      table(["agent", "paths"], result.leases.map((lease) => [lease.agent_id, lease.paths.join(", ")])),
    );
  }

  if (result.open_asks?.length) {
    sections.push(
      "",
      bold("Waiting on an answer"),
      table(["ask", "from", "to", "question"], result.open_asks.map((ask) => [ask.id, ask.from, ask.to, ask.question])),
    );
  }

  if (result.dead_letters?.length) {
    sections.push(
      "",
      red("Dead letters (never acknowledged)"),
      table(["msg", "from", "pending", "preview"], result.dead_letters.map((item) => [item.id, item.from, item.pending.join(","), item.preview])),
    );
  }

  sections.push("", bold("Recent messages"), result.recent_messages.length ? formatMessages(result.recent_messages) : dim("No messages yet."));

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
    return dim("No messages.");
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

function taskTable(tasks) {
  return table(
    ["id", "status", "assignee", "prio", "title"],
    tasks.map((task) => [task.id, task.status, task.assignee ?? "-", task.priority ?? "normal", task.title]),
  );
}

function table(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.min(34, Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length))),
  );
  const render = (row) =>
    row.map((cell, index) => truncate(String(cell ?? ""), widths[index]).padEnd(widths[index])).join("  ").trimEnd();
  return [
    dim(render(headers)),
    dim(render(headers.map((header, index) => "-".repeat(Math.min(header.length + 2, widths[index]))))),
    ...rows.map(render),
  ].join("\n");
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
