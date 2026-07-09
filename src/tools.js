import { nextId } from "./store.js";

const KNOWN_CLIENTS = [
  { id: "claude", label: "Claude Code", provider: "anthropic", mcp: "stdio" },
  { id: "codex", label: "OpenAI Codex CLI", provider: "openai", mcp: "stdio" },
  { id: "gemini", label: "Gemini CLI", provider: "google", mcp: "stdio" },
  { id: "antigravity", label: "Google Antigravity", provider: "google", mcp: "stdio" },
  { id: "antigravit", label: "Antigravity alias", provider: "google", mcp: "stdio" },
  { id: "grok", label: "Grok CLI", provider: "xai", mcp: "stdio" },
  { id: "cursor", label: "Cursor", provider: "cursor", mcp: "stdio" },
  { id: "windsurf", label: "Windsurf", provider: "codeium", mcp: "stdio" },
  { id: "continue", label: "Continue", provider: "continue", mcp: "stdio" },
  { id: "vscode", label: "VS Code MCP", provider: "microsoft", mcp: "stdio" },
  { id: "lmstudio", label: "LM Studio", provider: "lmstudio", mcp: "stdio" },
  { id: "opencode", label: "OpenCode", provider: "sst", mcp: "stdio" },
  { id: "aider", label: "Aider", provider: "aider", mcp: "stdio" },
  { id: "goose", label: "Goose", provider: "block", mcp: "stdio" },
  { id: "qwen", label: "Qwen Code", provider: "alibaba", mcp: "stdio" },
  { id: "crush", label: "Crush", provider: "charm", mcp: "stdio" },
  { id: "amp", label: "Amp", provider: "sourcegraph", mcp: "stdio" },
  { id: "openhands", label: "OpenHands", provider: "all-hands", mcp: "stdio" },
  { id: "openclaude", label: "OpenClaude", provider: "openclaude", mcp: "stdio" },
  { id: "shannon", label: "Shannon", provider: "shannon", mcp: "stdio" },
  { id: "zed", label: "Zed Agent", provider: "zed", mcp: "stdio" },
];

export const TOOL_DEFINITIONS = [
  {
    name: "known_clients",
    description: "List known CLI/IDE agent clients and the normalized client ids to use when registering.",
    inputSchema: objectSchema({}),
  },
  {
    name: "register_agent",
    description: "Register or update any CLI/IDE agent on the shared coordination bus.",
    inputSchema: objectSchema({
      agent_id: stringProp("Stable agent id, for example codex-main, claude-reviewer, antigravity-ui, grok-research."),
      cli: stringProp("Normalized client id. Examples: codex, claude, gemini, antigravity, antigravit, grok, cursor, windsurf, continue, vscode, lmstudio, aider, goose, qwen, crush, amp.", false),
      provider: stringProp("Model/provider owner, for example openai, anthropic, google, xai, local.", false),
      model: stringProp("Active model name if known.", false),
      session_id: stringProp("Current CLI session/conversation id if known.", false),
      role: stringProp("Agent role or responsibility.", false),
      workspace: stringProp("Current workspace path.", false),
      capabilities: arrayProp("Short capability labels.", false),
    }, ["agent_id"]),
  },
  {
    name: "heartbeat",
    description: "Update an agent's current status and short progress note.",
    inputSchema: objectSchema({
      agent_id: stringProp("Registered agent id."),
      status: stringProp("Status such as idle, working, blocked, reviewing.", false),
      note: stringProp("Short progress note.", false),
      task_id: stringProp("Current task id.", false),
    }, ["agent_id"]),
  },
  {
    name: "send_message",
    description: "Send a directed message to one agent or a list of agents.",
    inputSchema: objectSchema({
      from: stringProp("Sender agent id."),
      to: recipientProp("Recipient agent id, '*' for broadcast visibility, or an array of agent ids."),
      message: stringProp("Message body."),
      priority: enumProp(["low", "normal", "high", "urgent"], "Priority.", false),
      topic: stringProp("Optional topic/thread label.", false),
    }, ["from", "to", "message"]),
  },
  {
    name: "broadcast",
    description: "Broadcast an instruction or update to every registered agent.",
    inputSchema: objectSchema({
      from: stringProp("Sender agent id."),
      message: stringProp("Message body."),
      priority: enumProp(["low", "normal", "high", "urgent"], "Priority.", false),
      topic: stringProp("Optional topic/thread label.", false),
      exclude_self: booleanProp("Exclude sender from inbox.", false),
    }, ["from", "message"]),
  },
  {
    name: "read_inbox",
    description: "Read messages visible to an agent. Can mark messages as read.",
    inputSchema: objectSchema({
      agent_id: stringProp("Agent id reading its inbox."),
      since_id: stringProp("Only return messages after this id.", false),
      unread_only: booleanProp("Only return messages after this agent's read cursor.", false),
      mark_read: booleanProp("Advance read cursor to latest returned message.", false),
      limit: numberProp("Maximum messages to return.", false),
    }, ["agent_id"]),
  },
  {
    name: "create_task",
    description: "Create a shared task that any agent can claim or an assignee can handle.",
    inputSchema: objectSchema({
      from: stringProp("Creator agent id."),
      title: stringProp("Short task title."),
      description: stringProp("Task details.", false),
      assignee: stringProp("Preferred assignee agent id.", false),
      priority: enumProp(["low", "normal", "high", "urgent"], "Priority.", false),
      files: arrayProp("Related file paths.", false),
    }, ["from", "title"]),
  },
  {
    name: "list_tasks",
    description: "List shared tasks, optionally filtered by status or assignee.",
    inputSchema: objectSchema({
      status: enumProp(["open", "claimed", "blocked", "done", "cancelled"], "Task status.", false),
      assignee: stringProp("Assigned or claimed agent id.", false),
      limit: numberProp("Maximum tasks to return.", false),
    }),
  },
  {
    name: "claim_task",
    description: "Claim an open task for an agent.",
    inputSchema: objectSchema({
      agent_id: stringProp("Claiming agent id."),
      task_id: stringProp("Task id."),
    }, ["agent_id", "task_id"]),
  },
  {
    name: "update_task",
    description: "Update task status, note, assignee, or related files.",
    inputSchema: objectSchema({
      agent_id: stringProp("Updating agent id."),
      task_id: stringProp("Task id."),
      status: enumProp(["open", "claimed", "blocked", "done", "cancelled"], "New status.", false),
      note: stringProp("Progress note.", false),
      assignee: stringProp("Assignee agent id.", false),
      files: arrayProp("Related file paths.", false),
    }, ["agent_id", "task_id"]),
  },
  {
    name: "record_decision",
    description: "Record a team decision so agents can align on constraints and choices.",
    inputSchema: objectSchema({
      from: stringProp("Decision author agent id."),
      title: stringProp("Short decision title."),
      decision: stringProp("Decision text."),
      rationale: stringProp("Reasoning or tradeoff.", false),
    }, ["from", "title", "decision"]),
  },
  {
    name: "team_status",
    description: "Summarize agents, open tasks, recent messages, and decisions.",
    inputSchema: objectSchema({
      limit: numberProp("Number of recent messages/decisions.", false),
    }),
  },
];

export async function callTool(store, name, input = {}) {
  switch (name) {
    case "known_clients":
      return knownClients();
    case "register_agent":
      return registerAgent(store, input);
    case "heartbeat":
      return heartbeat(store, input);
    case "send_message":
      return sendMessage(store, input);
    case "broadcast":
      return broadcast(store, input);
    case "read_inbox":
      return readInbox(store, input);
    case "create_task":
      return createTask(store, input);
    case "list_tasks":
      return listTasks(store, input);
    case "claim_task":
      return claimTask(store, input);
    case "update_task":
      return updateTask(store, input);
    case "record_decision":
      return recordDecision(store, input);
    case "team_status":
      return teamStatus(store, input);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function knownClients() {
  return {
    ok: true,
    clients: KNOWN_CLIENTS,
    note: "Use a custom cli value when your agent is not listed; VibeBus is MCP-client agnostic.",
  };
}

function registerAgent(store, input) {
  requireString(input, "agent_id");
  const now = timestamp();

  return store.update((state) => {
    const existing = state.agents[input.agent_id] ?? {};
    state.agents[input.agent_id] = {
      ...existing,
      agent_id: input.agent_id,
      cli: input.cli ?? existing.cli ?? "unknown",
      provider: input.provider ?? existing.provider ?? inferProvider(input.cli),
      model: input.model ?? existing.model ?? null,
      session_id: input.session_id ?? existing.session_id ?? null,
      role: input.role ?? existing.role ?? "agent",
      workspace: input.workspace ?? existing.workspace ?? null,
      capabilities: input.capabilities ?? existing.capabilities ?? [],
      status: existing.status ?? "registered",
      note: existing.note ?? "",
      registered_at: existing.registered_at ?? now,
      last_seen_at: now,
    };

    return { ok: true, agent: state.agents[input.agent_id] };
  });
}

function heartbeat(store, input) {
  requireString(input, "agent_id");
  const now = timestamp();

  return store.update((state) => {
    const existing = state.agents[input.agent_id] ?? {
      agent_id: input.agent_id,
      cli: "unknown",
      provider: null,
      model: null,
      session_id: null,
      role: "agent",
      registered_at: now,
    };

    state.agents[input.agent_id] = {
      ...existing,
      status: input.status ?? existing.status ?? "active",
      note: input.note ?? existing.note ?? "",
      task_id: input.task_id ?? existing.task_id ?? null,
      last_seen_at: now,
    };

    return { ok: true, agent: state.agents[input.agent_id] };
  });
}

function sendMessage(store, input) {
  requireString(input, "from");
  requireRecipient(input, "to");
  requireString(input, "message");

  return store.update((state) => {
    const message = makeMessage(state, {
      from: input.from,
      to: input.to,
      message: input.message,
      priority: input.priority,
      topic: input.topic,
    });
    state.messages.push(message);
    touchAgent(state, input.from);
    return { ok: true, message };
  });
}

function broadcast(store, input) {
  requireString(input, "from");
  requireString(input, "message");

  return store.update((state) => {
    const message = makeMessage(state, {
      from: input.from,
      to: "*",
      message: input.message,
      priority: input.priority,
      topic: input.topic,
      exclude_self: Boolean(input.exclude_self),
    });
    state.messages.push(message);
    touchAgent(state, input.from);
    return { ok: true, message };
  });
}

function readInbox(store, input) {
  requireString(input, "agent_id");
  const limit = normalizeLimit(input.limit);

  return store.update((state) => {
    const lastReadId = state.reads[input.agent_id] ?? "";
    const since = input.since_id || (input.unread_only ? lastReadId : "");
    const messages = state.messages
      .filter((message) => isVisibleTo(message, input.agent_id))
      .filter((message) => !since || compareIds(message.id, since) > 0)
      .slice(-limit);

    if (input.mark_read && messages.length > 0) {
      state.reads[input.agent_id] = messages[messages.length - 1].id;
    }

    touchAgent(state, input.agent_id);
    return { ok: true, messages, read_cursor: state.reads[input.agent_id] ?? lastReadId };
  });
}

function createTask(store, input) {
  requireString(input, "from");
  requireString(input, "title");

  return store.update((state) => {
    const now = timestamp();
    const task = {
      id: nextId(state, "task"),
      title: input.title,
      description: input.description ?? "",
      status: input.assignee ? "claimed" : "open",
      priority: input.priority ?? "normal",
      creator: input.from,
      assignee: input.assignee ?? null,
      files: input.files ?? [],
      notes: [],
      created_at: now,
      updated_at: now,
    };
    state.tasks.push(task);
    touchAgent(state, input.from);
    return { ok: true, task };
  });
}

function listTasks(store, input) {
  const state = store.read();
  const limit = normalizeLimit(input.limit);
  const tasks = state.tasks
    .filter((task) => !input.status || task.status === input.status)
    .filter((task) => !input.assignee || task.assignee === input.assignee)
    .slice(-limit);

  return { ok: true, tasks };
}

function claimTask(store, input) {
  requireString(input, "agent_id");
  requireString(input, "task_id");

  return store.update((state) => {
    const task = findTask(state, input.task_id);
    if (!["open", "blocked"].includes(task.status) && task.assignee && task.assignee !== input.agent_id) {
      throw new Error(`Task ${input.task_id} is already ${task.status} by ${task.assignee}`);
    }
    task.status = "claimed";
    task.assignee = input.agent_id;
    task.updated_at = timestamp();
    task.notes.push(note(input.agent_id, "claimed"));
    touchAgent(state, input.agent_id);
    return { ok: true, task };
  });
}

function updateTask(store, input) {
  requireString(input, "agent_id");
  requireString(input, "task_id");

  return store.update((state) => {
    const task = findTask(state, input.task_id);
    if (input.status) {
      task.status = input.status;
    }
    if (input.assignee !== undefined) {
      task.assignee = input.assignee || null;
    }
    if (input.files) {
      task.files = input.files;
    }
    if (input.note) {
      task.notes.push(note(input.agent_id, input.note));
    }
    task.updated_at = timestamp();
    touchAgent(state, input.agent_id);
    return { ok: true, task };
  });
}

function recordDecision(store, input) {
  requireString(input, "from");
  requireString(input, "title");
  requireString(input, "decision");

  return store.update((state) => {
    const decision = {
      id: nextId(state, "decision"),
      from: input.from,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale ?? "",
      created_at: timestamp(),
    };
    state.decisions.push(decision);
    touchAgent(state, input.from);
    return { ok: true, decision };
  });
}

function teamStatus(store, input) {
  const state = store.read();
  const limit = normalizeLimit(input.limit ?? 10);

  return {
    ok: true,
    agents: Object.values(state.agents),
    open_tasks: state.tasks.filter((task) => ["open", "claimed", "blocked"].includes(task.status)),
    recent_messages: state.messages.slice(-limit),
    recent_decisions: state.decisions.slice(-limit),
    state_path: store.path,
  };
}

function makeMessage(state, input) {
  return {
    id: nextId(state, "msg"),
    from: input.from,
    to: input.to,
    message: input.message,
    priority: input.priority ?? "normal",
    topic: input.topic ?? null,
    exclude_self: Boolean(input.exclude_self),
    created_at: timestamp(),
  };
}

function isVisibleTo(message, agentId) {
  if (message.to === agentId) {
    return true;
  }
  if (message.to === "*" && !(message.exclude_self && message.from === agentId)) {
    return true;
  }
  if (Array.isArray(message.to) && message.to.includes(agentId)) {
    return true;
  }
  return message.from === agentId;
}

function findTask(state, taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Unknown task: ${taskId}`);
  }
  return task;
}

function touchAgent(state, agentId) {
  if (!state.agents[agentId]) {
    state.agents[agentId] = {
      agent_id: agentId,
      cli: "unknown",
      provider: null,
      model: null,
      session_id: null,
      role: "agent",
      status: "active",
      note: "",
      capabilities: [],
      workspace: null,
      registered_at: timestamp(),
    };
  }
  state.agents[agentId].last_seen_at = timestamp();
}

function note(agentId, text) {
  return { agent_id: agentId, text, created_at: timestamp() };
}

function requireString(input, key) {
  if (typeof input?.[key] !== "string" || input[key].trim() === "") {
    throw new Error(`${key} is required`);
  }
}

function requireRecipient(input, key) {
  const value = input?.[key];
  if (typeof value === "string" && value.trim() !== "") {
    return;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() !== "")) {
    return;
  }
  throw new Error(`${key} must be an agent id, '*', or an array of agent ids`);
}

function inferProvider(cli) {
  return KNOWN_CLIENTS.find((client) => client.id === cli)?.provider ?? null;
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value ?? 50, 10);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(200, Math.max(1, parsed));
}

function compareIds(left, right) {
  return Number(left.split("_").at(-1)) - Number(right.split("_").at(-1));
}

function timestamp() {
  return new Date().toISOString();
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringProp(description, required = true) {
  return { type: "string", description, minLength: required ? 1 : 0 };
}

function booleanProp(description) {
  return { type: "boolean", description };
}

function numberProp(description) {
  return { type: "number", description };
}

function arrayProp(description) {
  return { type: "array", description, items: { type: "string" } };
}

function enumProp(values, description) {
  return { type: "string", enum: values, description };
}

function recipientProp(description) {
  return {
    oneOf: [
      { type: "string", minLength: 1 },
      { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    ],
    description,
  };
}
