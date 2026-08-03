/**
 * The event journal is the backbone of the real-time bus.
 *
 * Every mutation appends an event carrying a monotonic `seq`. Processes track a
 * single integer cursor, so "what did I miss?" is a slice, and "did anything
 * happen?" is one comparison. Notifications, wakeups, dashboards, and blocking
 * waits are all built on top of this one stream.
 */
export const EVENT_TYPES = [
  "agent.registered",
  "agent.heartbeat",
  "agent.presence",
  "agent.slept",
  "agent.woken",
  "message",
  "message.ack",
  "message.dead_letter",
  "task.created",
  "task.claimed",
  "task.updated",
  "task.unblocked",
  "decision",
  "ask.created",
  "ask.answered",
  "ask.declined",
  "ask.expired",
  "approval.requested",
  "approval.resolved",
  "lease.acquired",
  "lease.released",
  "lease.expired",
  "context.set",
  "context.deleted",
  "channel.joined",
  "channel.left",
  "wake",
  "bus.compacted",
];

export function emit(state, type, { actor = null, audience = "*", ref = null, data = {} } = {}) {
  state.seq = (state.seq ?? 0) + 1;

  const event = {
    seq: state.seq,
    type,
    at: new Date().toISOString(),
    actor,
    audience: normalizeAudience(audience),
    ref,
    data,
  };

  state.events ??= [];
  state.events.push(event);
  return event;
}

export function eventVisibleTo(event, agentId) {
  if (!agentId) {
    return true;
  }
  const audience = event.audience;
  if (audience === "*" || audience === undefined || audience === null) {
    return true;
  }
  if (Array.isArray(audience)) {
    return audience.includes(agentId);
  }
  return audience === agentId;
}

export function eventsSince(state, sinceSeq, { agentId, types, limit = 100 } = {}) {
  const cursor = Number.isFinite(sinceSeq) ? sinceSeq : 0;
  const typeFilter = types?.length ? new Set(types) : null;

  return (state.events ?? [])
    .filter((event) => event.seq > cursor)
    .filter((event) => !typeFilter || typeFilter.has(event.type))
    .filter((event) => eventVisibleTo(event, agentId))
    .slice(-limit);
}

/** Resource URIs a given event type invalidates, for resources/updated pushes. */
export function resourcesTouchedBy(type) {
  if (type.startsWith("agent.")) {
    return ["vibebus://agents", "vibebus://status", "vibebus://events"];
  }
  if (type.startsWith("message")) {
    return ["vibebus://messages", "vibebus://status", "vibebus://events"];
  }
  if (type.startsWith("task.")) {
    return ["vibebus://tasks", "vibebus://status", "vibebus://events"];
  }
  if (type.startsWith("lease.")) {
    return ["vibebus://leases", "vibebus://status", "vibebus://events"];
  }
  if (type.startsWith("context.")) {
    return ["vibebus://context", "vibebus://events"];
  }
  if (type === "decision") {
    return ["vibebus://decisions", "vibebus://status", "vibebus://events"];
  }
  return ["vibebus://status", "vibebus://events"];
}

function normalizeAudience(audience) {
  if (audience === "*" || audience === null || audience === undefined) {
    return "*";
  }
  if (Array.isArray(audience)) {
    const list = [...new Set(audience.filter(Boolean))];
    return list.length ? list : "*";
  }
  return audience;
}
