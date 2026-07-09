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
      thread_id: stringProp("Existing thread id to attach this message to.", false),
      reply_to: stringProp("Message id this message replies to.", false),
      task_id: stringProp("Related task id.", false),
      files: arrayProp("Related file paths.", false),
      requires_ack: booleanProp("Require recipient acknowledgement.", false),
    }, ["from", "to", "message"]),
  },
  {
    name: "send_to_role",
    description: "Send one message to all registered agents matching a role, CLI, or provider.",
    inputSchema: objectSchema({
      from: stringProp("Sender agent id."),
      message: stringProp("Message body."),
      role: stringProp("Target agent role.", false),
      cli: stringProp("Target CLI id.", false),
      provider: stringProp("Target model/provider.", false),
      priority: enumProp(["low", "normal", "high", "urgent"], "Priority.", false),
      topic: stringProp("Optional topic/thread label.", false),
      requires_ack: booleanProp("Require acknowledgements from recipients.", false),
      exclude_self: booleanProp("Exclude sender from recipients.", false),
    }, ["from", "message"]),
  },
  {
    name: "broadcast",
    description: "Broadcast an instruction or update to every registered agent.",
    inputSchema: objectSchema({
      from: stringProp("Sender agent id."),
      message: stringProp("Message body."),
      priority: enumProp(["low", "normal", "high", "urgent"], "Priority.", false),
      topic: stringProp("Optional topic/thread label.", false),
      thread_id: stringProp("Existing thread id to attach this message to.", false),
      reply_to: stringProp("Message id this message replies to.", false),
      task_id: stringProp("Related task id.", false),
      files: arrayProp("Related file paths.", false),
      requires_ack: booleanProp("Require recipient acknowledgement.", false),
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
      include_acked: booleanProp("Include messages this agent has already acknowledged.", false),
      limit: numberProp("Maximum messages to return.", false),
    }, ["agent_id"]),
  },
  {
    name: "wait_for_messages",
    description: "Poll an agent inbox for new messages with a bounded timeout.",
    inputSchema: objectSchema({
      agent_id: stringProp("Agent id waiting on its inbox."),
      since_id: stringProp("Only return messages after this id.", false),
      unread_only: booleanProp("Only return messages after this agent's read cursor.", false),
      mark_read: booleanProp("Advance read cursor to latest returned message.", false),
      timeout_ms: numberProp("Maximum wait time, capped at 30000ms.", false),
      poll_ms: numberProp("Poll interval, capped between 100ms and 5000ms.", false),
      limit: numberProp("Maximum messages to return.", false),
    }, ["agent_id"]),
  },
  {
    name: "ack_message",
    description: "Acknowledge receipt or completion of a message that requires acknowledgement.",
    inputSchema: objectSchema({
      agent_id: stringProp("Acknowledging agent id."),
      message_id: stringProp("Message id to acknowledge."),
      note: stringProp("Optional acknowledgement note.", false),
    }, ["agent_id", "message_id"]),
  },
  {
    name: "read_thread",
    description: "Read all visible messages in a message thread.",
    inputSchema: objectSchema({
      agent_id: stringProp("Agent id reading the thread."),
      thread_id: stringProp("Thread id."),
      mark_read: booleanProp("Advance read cursor to latest returned message.", false),
      limit: numberProp("Maximum messages to return.", false),
    }, ["agent_id", "thread_id"]),
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
    name: "handoff_task",
    description: "Create or assign a task and send a required-ack handoff message in one atomic update.",
    inputSchema: objectSchema({
      from: stringProp("Sender agent id."),
      to: recipientProp("Recipient agent id or ids."),
      title: stringProp("Task title."),
      description: stringProp("Task details.", false),
      priority: enumProp(["low", "normal", "high", "urgent"], "Priority.", false),
      files: arrayProp("Related file paths.", false),
      message: stringProp("Handoff message. Defaults to task description.", false),
      topic: stringProp("Topic/thread label.", false),
    }, ["from", "to", "title"]),
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
    case "send_to_role":
      return sendToRole(store, input);
    case "broadcast":
      return broadcast(store, input);
    case "read_inbox":
      return readInbox(store, input);
    case "wait_for_messages":
      return waitForMessages(store, input);
    case "ack_message":
      return ackMessage(store, input);
    case "read_thread":
      return readThread(store, input);
    case "create_task":
      return createTask(store, input);
    case "handoff_task":
      return handoffTask(store, input);
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
    note: "Use a custom cli value when your agent is not listed; Vibe Bus is MCP-client agnostic.",
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
      thread_id: input.thread_id,
      reply_to: input.reply_to,
      task_id: input.task_id,
      files: input.files,
      requires_ack: Boolean(input.requires_ack),
    });
    state.messages.push(message);
    touchAgent(state, input.from);
    return { ok: true, message };
  });
}

function sendToRole(store, input) {
  requireString(input, "from");
  requireString(input, "message");
  if (!input.role && !input.cli && !input.provider) {
    throw new Error("At least one of role, cli, or provider is required");
  }

  return store.update((state) => {
    const recipients = Object.values(state.agents)
      .filter((agent) => !input.role || agent.role === input.role)
      .filter((agent) => !input.cli || agent.cli === input.cli)
      .filter((agent) => !input.provider || agent.provider === input.provider)
      .filter((agent) => !(input.exclude_self && agent.agent_id === input.from))
      .map((agent) => agent.agent_id);

    if (recipients.length === 0) {
      throw new Error("No registered agents matched the requested role/cli/provider");
    }

    const message = makeMessage(state, {
      from: input.from,
      to: recipients,
      message: input.message,
      priority: input.priority,
      topic: input.topic,
      requires_ack: Boolean(input.requires_ack),
    });
    state.messages.push(message);
    touchAgent(state, input.from);
    return { ok: true, recipients, message };
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
      thread_id: input.thread_id,
      reply_to: input.reply_to,
      task_id: input.task_id,
      files: input.files,
      requires_ack: Boolean(input.requires_ack),
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
    const lastReadId = state.reads[input.agent_id]?.inbox ?? state.reads[input.agent_id] ?? "";
    const since = input.since_id || (input.unread_only ? lastReadId : "");
    const messages = state.messages
      .filter((message) => isVisibleTo(message, input.agent_id))
      .filter((message) => !since || compareIds(message.id, since) > 0)
      .filter((message) => input.include_acked || !hasAcked(message, input.agent_id))
      .slice(-limit);

    if (input.mark_read && messages.length > 0) {
      state.reads[input.agent_id] = normalizeReadState(state.reads[input.agent_id]);
      state.reads[input.agent_id].inbox = messages[messages.length - 1].id;
    }

    touchAgent(state, input.agent_id);
    return { ok: true, messages, read_cursor: normalizeReadState(state.reads[input.agent_id]).inbox || lastReadId };
  });
}

async function waitForMessages(store, input) {
  requireString(input, "agent_id");
  const timeoutMs = Math.min(Math.max(Number.parseInt(input.timeout_ms ?? 1500, 10) || 1500, 0), 30000);
  const pollMs = Math.min(Math.max(Number.parseInt(input.poll_ms ?? 250, 10) || 250, 100), 5000);
  const startedAt = Date.now();

  while (true) {
    const result = readInbox(store, input);
    if (result.messages.length > 0 || Date.now() - startedAt >= timeoutMs) {
      return { ...result, waited_ms: Date.now() - startedAt, timed_out: result.messages.length === 0 };
    }
    await sleep(pollMs);
  }
}

function ackMessage(store, input) {
  requireString(input, "agent_id");
  requireString(input, "message_id");

  return store.update((state) => {
    const message = findMessage(state, input.message_id);
    if (!isVisibleTo(message, input.agent_id)) {
      throw new Error(`Message ${input.message_id} is not visible to ${input.agent_id}`);
    }
    message.acks ??= {};
    message.acks[input.agent_id] = {
      agent_id: input.agent_id,
      note: input.note ?? "",
      created_at: timestamp(),
    };
    touchAgent(state, input.agent_id);
    return { ok: true, message, pending_ack: pendingAckFor(message, state) };
  });
}

function readThread(store, input) {
  requireString(input, "agent_id");
  requireString(input, "thread_id");
  const limit = normalizeLimit(input.limit);

  return store.update((state) => {
    const messages = state.messages
      .filter((message) => message.thread_id === input.thread_id)
      .filter((message) => isVisibleTo(message, input.agent_id))
      .slice(-limit);

    if (input.mark_read && messages.length > 0) {
      state.reads[input.agent_id] = normalizeReadState(state.reads[input.agent_id]);
      state.reads[input.agent_id].inbox = messages[messages.length - 1].id;
    }

    touchAgent(state, input.agent_id);
    return { ok: true, thread_id: input.thread_id, messages };
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

function handoffTask(store, input) {
  requireString(input, "from");
  requireRecipient(input, "to");
  requireString(input, "title");

  return store.update((state) => {
    const now = timestamp();
    const recipients = Array.isArray(input.to) ? input.to : [input.to];
    const firstAssignee = recipients.length === 1 && recipients[0] !== "*" ? recipients[0] : null;
    const task = {
      id: nextId(state, "task"),
      title: input.title,
      description: input.description ?? "",
      status: firstAssignee ? "claimed" : "open",
      priority: input.priority ?? "normal",
      creator: input.from,
      assignee: firstAssignee,
      files: input.files ?? [],
      notes: [note(input.from, "handoff created")],
      created_at: now,
      updated_at: now,
    };
    state.tasks.push(task);

    const message = makeMessage(state, {
      from: input.from,
      to: input.to,
      message: input.message || input.description || input.title,
      priority: input.priority,
      topic: input.topic ?? "handoff",
      task_id: task.id,
      files: input.files,
      requires_ack: true,
    });
    state.messages.push(message);
    touchAgent(state, input.from);
    return { ok: true, task, message, pending_ack: pendingAckFor(message, state) };
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
  const replyTo = input.reply_to ? findMessage(state, input.reply_to) : null;
  const recipients = resolveRecipients(state, input.to, input.from, Boolean(input.exclude_self));
  const threadId = input.thread_id ?? replyTo?.thread_id ?? nextId(state, "thread");

  return {
    id: nextId(state, "msg"),
    thread_id: threadId,
    from: input.from,
    to: input.to,
    message: input.message,
    priority: input.priority ?? "normal",
    topic: input.topic ?? null,
    reply_to: input.reply_to ?? null,
    task_id: input.task_id ?? null,
    files: input.files ?? [],
    requires_ack: Boolean(input.requires_ack),
    recipients,
    acks: {},
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

function resolveRecipients(state, to, from, excludeSelf = false) {
  const recipients = to === "*" ? Object.keys(state.agents) : Array.isArray(to) ? to : [to];
  return [...new Set(recipients.filter((agentId) => agentId && !(excludeSelf && agentId === from)))];
}

function hasAcked(message, agentId) {
  return Boolean(message.acks?.[agentId]);
}

function pendingAckFor(message, state) {
  if (!message.requires_ack) {
    return [];
  }
  const recipients = message.recipients?.length ? message.recipients : resolveRecipients(state, message.to, message.from, message.exclude_self);
  return recipients.filter((agentId) => !message.acks?.[agentId]);
}

function findMessage(state, messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) {
    throw new Error(`Unknown message: ${messageId}`);
  }
  return message;
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

function normalizeReadState(value) {
  if (!value) {
    return { inbox: "" };
  }
  if (typeof value === "string") {
    return { inbox: value };
  }
  return { inbox: value.inbox ?? "" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
