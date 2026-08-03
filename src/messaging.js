import { maybeAutoWake } from "./agents.js";
import { emit, eventsSince } from "./events.js";
import { nextId } from "./store.js";
import {
  clampMs,
  compareIds,
  ensureAgent,
  normalizeLimit,
  requireRecipient,
  requireString,
  timestamp,
  touchAgent,
} from "./shared.js";

export function sendMessage(store, input) {
  requireString(input, "from");
  requireString(input, "message");
  if (!input.channel) {
    requireRecipient(input, "to");
  }

  return store.update((state) => {
    const to = input.channel ? channelMembers(state, input.channel, input.from) : input.to;
    const message = makeMessage(state, { ...input, to, requires_ack: Boolean(input.requires_ack) });
    state.messages.push(message);

    emitMessage(state, message);
    touchAgent(state, input.from);
    const wakes = maybeAutoWake(state, {
      from: input.from,
      to: message.recipients,
      priority: message.priority,
      reason: `message from ${input.from}: ${truncate(message.message, 120)}`,
      trigger: "message",
    });

    return { ok: true, message, woke: wakes.map((wake) => wake.to), bus_seq: state.seq };
  });
}

export function sendToRole(store, input) {
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

    const message = makeMessage(state, { ...input, to: recipients, requires_ack: Boolean(input.requires_ack) });
    state.messages.push(message);

    emitMessage(state, message);
    touchAgent(state, input.from);
    const wakes = maybeAutoWake(state, {
      from: input.from,
      to: recipients,
      priority: message.priority,
      reason: `role message from ${input.from}: ${truncate(message.message, 120)}`,
      trigger: "send_to_role",
    });

    return { ok: true, recipients, message, woke: wakes.map((wake) => wake.to), bus_seq: state.seq };
  });
}

export function broadcast(store, input) {
  requireString(input, "from");
  requireString(input, "message");

  return store.update((state) => {
    const message = makeMessage(state, {
      ...input,
      to: "*",
      requires_ack: Boolean(input.requires_ack),
      exclude_self: Boolean(input.exclude_self),
    });
    state.messages.push(message);

    emitMessage(state, message);
    touchAgent(state, input.from);
    const wakes = maybeAutoWake(state, {
      from: input.from,
      to: message.recipients,
      priority: message.priority,
      reason: `broadcast from ${input.from}: ${truncate(message.message, 120)}`,
      trigger: "broadcast",
    });

    return { ok: true, message, woke: wakes.map((wake) => wake.to), bus_seq: state.seq };
  });
}

export function readInbox(store, input) {
  requireString(input, "agent_id");
  const limit = normalizeLimit(input.limit);

  return store.update((state) => {
    const lastReadId = readCursor(state, input.agent_id);
    const since = input.since_id || (input.unread_only ? lastReadId : "");

    const messages = state.messages
      .filter((message) => isVisibleTo(message, input.agent_id))
      .filter((message) => !since || compareIds(message.id, since) > 0)
      .filter((message) => input.include_acked || !hasAcked(message, input.agent_id))
      .filter((message) => !input.topic || message.topic === input.topic)
      .filter((message) => !input.priority || message.priority === input.priority)
      .slice(-limit);

    if (input.mark_read && messages.length > 0) {
      setReadCursor(state, input.agent_id, messages[messages.length - 1].id);
    }

    touchAgent(state, input.agent_id);

    return {
      ok: true,
      messages,
      read_cursor: readCursor(state, input.agent_id) || lastReadId,
      bus_seq: state.seq,
      pending_acks: messages.filter((message) => message.requires_ack && !hasAcked(message, input.agent_id)).map((message) => message.id),
    };
  });
}

/**
 * Blocking inbox read. v1 slept in fixed 250ms ticks; this parks on the state
 * watcher instead, so a message sent by another CLI lands here in single-digit
 * milliseconds and the wait costs nothing while idle.
 */
export async function waitForMessages(store, input, ctx = {}) {
  requireString(input, "agent_id");
  const timeoutMs = clampMs(input.timeout_ms, 15_000, 0, 600_000);
  const startedAt = Date.now();
  let cursor = store.seq();

  const first = readInbox(store, input);
  if (first.messages.length > 0 || timeoutMs === 0) {
    return { ...first, waited_ms: Date.now() - startedAt, timed_out: first.messages.length === 0 };
  }

  while (true) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      const final = readInbox(store, input);
      return { ...final, waited_ms: Date.now() - startedAt, timed_out: final.messages.length === 0 };
    }

    ctx.session?.progress?.(`waiting for inbox traffic (${Math.round(remaining / 1000)}s left)`);
    await store.waitForChange(cursor, Math.min(remaining, 10_000));
    cursor = store.seq();

    const result = readInbox(store, input);
    if (result.messages.length > 0) {
      return { ...result, waited_ms: Date.now() - startedAt, timed_out: false };
    }
  }
}

export function ackMessage(store, input) {
  requireString(input, "agent_id");
  requireString(input, "message_id");

  return store.update((state) => {
    const message = findMessage(state, input.message_id);
    if (!isVisibleTo(message, input.agent_id)) {
      throw new Error(`Message ${input.message_id} is not visible to ${input.agent_id}`);
    }

    message.acks ??= {};
    message.acks[input.agent_id] = { agent_id: input.agent_id, note: input.note ?? "", created_at: timestamp() };
    message.dead_lettered = false;
    touchAgent(state, input.agent_id);

    // Acking the message that a wake delivered closes the wake too, so nobody
    // has to remember a second call.
    const wake = message.wake_id ? state.wakes.find((item) => item.id === message.wake_id) : null;
    if (wake && wake.status !== "acknowledged") {
      wake.status = "acknowledged";
      wake.acknowledged_by = input.agent_id;
      wake.acknowledged_at = timestamp();
    }

    const pending = pendingAckFor(message, state);
    emit(state, "message.ack", {
      actor: input.agent_id,
      audience: [message.from, input.agent_id],
      ref: message.id,
      data: { note: input.note ?? "", pending },
    });

    return { ok: true, message, pending_ack: pending, bus_seq: state.seq };
  });
}

export function readThread(store, input) {
  requireString(input, "agent_id");
  requireString(input, "thread_id");
  const limit = normalizeLimit(input.limit);

  return store.update((state) => {
    const messages = state.messages
      .filter((message) => message.thread_id === input.thread_id)
      .filter((message) => isVisibleTo(message, input.agent_id))
      .slice(-limit);

    if (input.mark_read && messages.length > 0) {
      setReadCursor(state, input.agent_id, messages[messages.length - 1].id);
    }

    touchAgent(state, input.agent_id);
    return { ok: true, thread_id: input.thread_id, messages, bus_seq: state.seq };
  });
}

export function tailEvents(store, input = {}) {
  const state = store.read();
  const limit = normalizeLimit(input.limit, 100);
  const events = eventsSince(state, Number.parseInt(input.since_seq ?? 0, 10) || 0, {
    agentId: input.agent_id,
    types: input.types,
    limit,
  });

  return {
    ok: true,
    bus_seq: state.seq,
    cursor: events.length ? events[events.length - 1].seq : Number.parseInt(input.since_seq ?? 0, 10) || 0,
    events,
  };
}

/** Generic real-time stream: block until anything relevant happens on the bus. */
export async function waitForEvents(store, input = {}, ctx = {}) {
  const timeoutMs = clampMs(input.timeout_ms, 15_000, 0, 600_000);
  const startedAt = Date.now();
  let cursor = Number.parseInt(input.since_seq ?? store.seq(), 10) || 0;

  const first = tailEvents(store, { ...input, since_seq: cursor });
  if (first.events.length > 0 || timeoutMs === 0) {
    return { ...first, waited_ms: Date.now() - startedAt, timed_out: first.events.length === 0 };
  }

  while (true) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      const final = tailEvents(store, { ...input, since_seq: cursor });
      return { ...final, waited_ms: Date.now() - startedAt, timed_out: final.events.length === 0 };
    }

    ctx.session?.progress?.(`watching the bus (${Math.round(remaining / 1000)}s left)`);
    await store.waitForChange(cursor, Math.min(remaining, 10_000));

    const result = tailEvents(store, { ...input, since_seq: cursor });
    if (result.events.length > 0) {
      return { ...result, waited_ms: Date.now() - startedAt, timed_out: false };
    }
    cursor = result.bus_seq;
  }
}

export function channel(store, input) {
  requireString(input, "action");

  if (input.action === "list") {
    const state = store.read();
    return { ok: true, channels: Object.values(state.channels) };
  }

  requireString(input, "agent_id");
  requireString(input, "channel");

  return store.update((state) => {
    const name = input.channel;
    state.channels[name] ??= { name, members: [], created_at: timestamp(), created_by: input.agent_id };
    const record = state.channels[name];
    const agent = ensureAgent(state, input.agent_id);
    agent.channels ??= [];

    if (input.action === "join") {
      if (!record.members.includes(input.agent_id)) {
        record.members.push(input.agent_id);
      }
      if (!agent.channels.includes(name)) {
        agent.channels.push(name);
      }
      emit(state, "channel.joined", { actor: input.agent_id, ref: name, data: { members: record.members } });
    } else if (input.action === "leave") {
      record.members = record.members.filter((member) => member !== input.agent_id);
      agent.channels = agent.channels.filter((item) => item !== name);
      emit(state, "channel.left", { actor: input.agent_id, ref: name, data: { members: record.members } });
    } else {
      throw new Error(`Unknown channel action: ${input.action}`);
    }

    touchAgent(state, input.agent_id);
    return { ok: true, channel: record, bus_seq: state.seq };
  });
}

export function makeMessage(state, input) {
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
    topic: input.topic ?? (input.channel ? `#${input.channel}` : null),
    channel: input.channel ?? null,
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

export function emitMessage(state, message) {
  emit(state, "message", {
    actor: message.from,
    audience: message.to === "*" ? "*" : [...message.recipients, message.from],
    ref: message.id,
    data: {
      thread_id: message.thread_id,
      topic: message.topic,
      priority: message.priority,
      requires_ack: message.requires_ack,
      task_id: message.task_id ?? null,
      preview: truncate(message.message, 160),
    },
  });
}

export function isVisibleTo(message, agentId) {
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

export function resolveRecipients(state, to, from, excludeSelf = false) {
  const recipients = to === "*" ? Object.keys(state.agents) : Array.isArray(to) ? to : [to];
  return [...new Set(recipients.filter((agentId) => agentId && !(excludeSelf && agentId === from)))];
}

export function pendingAckFor(message, state) {
  if (!message.requires_ack) {
    return [];
  }
  const recipients = message.recipients?.length
    ? message.recipients
    : resolveRecipients(state, message.to, message.from, message.exclude_self);
  return recipients.filter((agentId) => !message.acks?.[agentId]);
}

export function findMessage(state, messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) {
    throw new Error(`Unknown message: ${messageId}`);
  }
  return message;
}

function channelMembers(state, name, from) {
  const record = state.channels[name];
  if (!record || record.members.length === 0) {
    throw new Error(`Channel ${name} has no members. Join it first with channel(action:"join").`);
  }
  const members = record.members.filter((member) => member !== from);
  return members.length ? members : record.members;
}

function hasAcked(message, agentId) {
  return Boolean(message.acks?.[agentId]);
}

function readCursor(state, agentId) {
  const value = state.reads[agentId];
  if (!value) {
    return "";
  }
  return typeof value === "string" ? value : value.inbox ?? "";
}

function setReadCursor(state, agentId, messageId) {
  const current = state.reads[agentId];
  state.reads[agentId] = typeof current === "object" && current !== null ? current : {};
  state.reads[agentId].inbox = messageId;
}

function truncate(value, width) {
  const text = String(value ?? "");
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}
