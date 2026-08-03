import { emit } from "./events.js";
import { planWake, presenceOf, describeAgent } from "./presence.js";
import { nextId } from "./store.js";
import {
  clampMs,
  ensureAgent,
  headlessCommandFor,
  inferProvider,
  normalizeLimit,
  requireString,
  timestamp,
  touchAgent,
} from "./shared.js";

const PRIORITY_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };
const URGENCY_TO_PRIORITY = { low: "low", normal: "normal", high: "high", urgent: "urgent" };

export function registerAgent(store, input, ctx = {}) {
  requireString(input, "agent_id");
  const now = timestamp();
  const session = ctx.session;

  return store.update((state) => {
    const existing = state.agents[input.agent_id] ?? {};
    const supports = {
      ...(existing.supports ?? {}),
      ...(session?.clientCapabilitySummary?.() ?? {}),
    };

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
      channels: existing.channels ?? [],
      supports,
      status: existing.status ?? "registered",
      note: existing.note ?? "",
      wake_command: input.wake_command ?? existing.wake_command ?? headlessCommandFor(input.cli ?? existing.cli),
      // The MCP server inherits its CLI's environment, so TMUX_PANE points at
      // the pane the agent is actually running in. Registering it is what
      // consents to being woken by keystroke injection.
      tmux_target: input.tmux_target ?? existing.tmux_target ?? detectTmuxTarget(ctx.env),
      auto_wake: input.auto_wake ?? existing.auto_wake ?? true,
      sleep_until: null,
      registered_at: existing.registered_at ?? now,
      last_seen_at: now,
    };

    emit(state, "agent.registered", {
      actor: input.agent_id,
      ref: input.agent_id,
      data: {
        cli: state.agents[input.agent_id].cli,
        role: state.agents[input.agent_id].role,
        supports,
      },
    });

    session?.bind?.(input.agent_id);

    return {
      ok: true,
      agent: describeAgent(state.agents[input.agent_id]),
      bus_seq: state.seq,
      push: session?.pushSummary?.() ?? { available: false },
    };
  });
}

export function heartbeat(store, input) {
  requireString(input, "agent_id");

  return store.update((state) => {
    const agent = touchAgent(state, input.agent_id);
    agent.status = input.status ?? agent.status ?? "active";
    agent.note = input.note ?? agent.note ?? "";
    agent.task_id = input.task_id ?? agent.task_id ?? null;
    if (input.progress !== undefined) {
      agent.progress = Math.min(100, Math.max(0, Number(input.progress) || 0));
    }
    if (input.eta) {
      agent.eta = input.eta;
    }

    emit(state, "agent.heartbeat", {
      actor: input.agent_id,
      ref: input.agent_id,
      data: { status: agent.status, note: agent.note, task_id: agent.task_id, progress: agent.progress ?? null },
    });

    return { ok: true, agent: describeAgent(agent), bus_seq: state.seq };
  });
}

export function who(store, input = {}) {
  const state = store.read();
  const now = Date.now();
  const agents = Object.values(state.agents)
    .map((agent) => describeAgent(agent, now))
    .filter((agent) => !input.presence || agent.presence === input.presence)
    .filter((agent) => !input.role || agent.role === input.role)
    .sort((left, right) => (left.seconds_since_seen ?? 1e9) - (right.seconds_since_seen ?? 1e9));

  return {
    ok: true,
    now: new Date(now).toISOString(),
    bus_seq: state.seq,
    agents,
    pending_wakes: state.wakes.filter((wake) => wake.status === "pending" || wake.status === "delivered"),
    counts: agents.reduce((acc, agent) => {
      acc[agent.presence] = (acc[agent.presence] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * Park an agent until someone wakes it. Because wakes clear `sleep_until` and
 * every process watches the state file, a sleeping agent resumes within a few
 * milliseconds of being woken rather than at the next poll tick.
 */
export async function sleepAgent(store, input, ctx = {}) {
  requireString(input, "agent_id");
  const durationMs = clampMs(input.duration_ms, 300_000, 1000, 24 * 60 * 60_000);
  const blockMs = clampMs(input.block_ms, 60_000, 0, 600_000);
  const shouldBlock = input.block !== false && blockMs > 0;
  const until = new Date(Date.now() + durationMs).toISOString();

  const started = store.update((state) => {
    const agent = touchAgent(state, input.agent_id);
    agent.sleep_until = until;
    agent.sleep_reason = input.reason ?? null;
    agent.slept_at = timestamp();
    agent.status = "asleep";
    agent.woken_by = null;
    agent.woken_reason = null;
    agent.wake_on = normalizeWakeFilter(input.wake_on);

    emit(state, "agent.slept", {
      actor: input.agent_id,
      ref: input.agent_id,
      data: { until, reason: agent.sleep_reason, wake_on: agent.wake_on },
    });

    return { ok: true, agent: describeAgent(agent), sleep_until: until, bus_seq: state.seq };
  });

  if (!shouldBlock) {
    return { ...started, blocked: false };
  }

  const deadline = Date.now() + blockMs;
  let cursor = started.bus_seq;

  while (true) {
    const state = store.read();
    const agent = state.agents[input.agent_id];
    const stillAsleep = agent?.sleep_until && Date.parse(agent.sleep_until) > Date.now();

    if (!stillAsleep) {
      return finishSleep(store, input.agent_id, agent?.woken_by ? "woken" : "elapsed");
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ...started,
        blocked: true,
        outcome: "still_asleep",
        note: "Block window ended; the agent is still asleep. Call sleep again to keep parking.",
      };
    }

    ctx.session?.progress?.(`asleep, waiting for a wake signal (${Math.round(remaining / 1000)}s left)`);
    await store.waitForChange(cursor, Math.min(remaining, 5000));
    cursor = store.seq();
  }
}

function finishSleep(store, agentId, outcome) {
  return store.update((state) => {
    const agent = touchAgent(state, agentId);
    agent.status = outcome === "woken" ? "waking" : "active";

    const unread = unreadFor(state, agentId);

    emit(state, "agent.woken", {
      actor: agentId,
      ref: agentId,
      data: { outcome, woken_by: agent.woken_by ?? null, reason: agent.woken_reason ?? null },
    });

    return {
      ok: true,
      blocked: true,
      outcome,
      woken_by: agent.woken_by ?? null,
      wake_reason: agent.woken_reason ?? null,
      agent: describeAgent(agent),
      unread_messages: unread,
      bus_seq: state.seq,
    };
  });
}

/**
 * Ring the bell on another agent. Always lands on the bus tier instantly; the
 * higher tiers are serviced by whichever process owns the target's live MCP
 * session (see pump.js).
 */
export async function wakeAgent(store, input, ctx = {}) {
  requireString(input, "from");
  requireString(input, "to");
  const urgency = input.urgency ?? "normal";
  const waitMs = clampMs(input.wait_ms, 0, 0, 30_000);

  const result = store.update((state) => {
    const target = state.agents[input.to];
    if (!target) {
      throw new Error(`Unknown agent: ${input.to}. Call who to list registered agents.`);
    }

    const { presence, plan, reachable } = planWake(target, { urgency, max_tier: input.max_tier });
    const wake = createWake(state, {
      from: input.from,
      to: input.to,
      reason: input.reason ?? "wake requested",
      urgency,
      plan,
      presence,
      payload: input.payload ?? null,
      trigger: "wake_agent",
    });

    // A woken agent needs to know why, so the wake carries a real inbox message.
    const message = {
      id: nextId(state, "msg"),
      thread_id: nextId(state, "thread"),
      from: input.from,
      to: input.to,
      message: input.reason ?? "Wake up: there is work for you on the bus.",
      priority: URGENCY_TO_PRIORITY[urgency] ?? "normal",
      topic: "wake",
      reply_to: null,
      task_id: input.task_id ?? null,
      files: [],
      requires_ack: Boolean(input.requires_ack),
      recipients: [input.to],
      acks: {},
      wake_id: wake.id,
      created_at: timestamp(),
    };
    state.messages.push(message);
    wake.message_id = message.id;

    emit(state, "message", {
      actor: input.from,
      audience: [input.to, input.from],
      ref: message.id,
      data: { topic: "wake", priority: message.priority, preview: message.message.slice(0, 160) },
    });

    touchAgent(state, input.from);

    return {
      ok: true,
      wake,
      message,
      presence,
      reachable,
      plan,
      bus_seq: state.seq,
      note: describePlan(plan, presence),
    };
  });

  if (waitMs === 0) {
    return result;
  }

  // Optionally hang around long enough to report which tier actually landed.
  const deadline = Date.now() + waitMs;
  let cursor = result.bus_seq;

  while (Date.now() < deadline) {
    await store.waitForChange(cursor, Math.min(deadline - Date.now(), 2000));
    cursor = store.seq();
    const wake = store.read().wakes.find((item) => item.id === result.wake.id);
    if (wake && (wake.status === "acknowledged" || wake.delivered.length > 0)) {
      return { ...result, wake, delivered: wake.delivered, acknowledged: wake.status === "acknowledged" };
    }
  }

  const wake = store.read().wakes.find((item) => item.id === result.wake.id);
  return { ...result, wake, delivered: wake?.delivered ?? [], timed_out: true };
}

/**
 * Fired automatically when work arrives for an agent that is not watching.
 * This is what makes "hand off a task and the other agent just starts" work
 * without anyone remembering to call wake_agent.
 */
export function maybeAutoWake(state, { from, to, priority = "normal", reason, trigger }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter((id) => id && id !== "*" && id !== from);
  const woken = [];

  for (const agentId of recipients) {
    const agent = state.agents[agentId];
    if (!agent || agent.auto_wake === false) {
      continue;
    }

    const presence = presenceOf(agent);
    if (presence === "online") {
      continue;
    }

    if (presence === "asleep" && !passesWakeFilter(agent.wake_on, { priority, from })) {
      continue;
    }

    const urgency = priority === "urgent" ? "urgent" : priority === "high" ? "high" : "normal";
    const { plan } = planWake(agent, { urgency });
    woken.push(createWake(state, { from, to: agentId, reason, urgency, plan, presence, trigger }));
  }

  return woken;
}

export function acknowledgeWake(store, input) {
  requireString(input, "agent_id");
  requireString(input, "wake_id");

  return store.update((state) => {
    const wake = state.wakes.find((item) => item.id === input.wake_id);
    if (!wake) {
      throw new Error(`Unknown wake: ${input.wake_id}`);
    }
    wake.status = "acknowledged";
    wake.acknowledged_by = input.agent_id;
    wake.acknowledged_at = timestamp();
    wake.note = input.note ?? null;
    touchAgent(state, input.agent_id);

    emit(state, "agent.woken", {
      actor: input.agent_id,
      audience: [wake.from, wake.to],
      ref: wake.id,
      data: { acknowledged: true, note: wake.note },
    });

    return { ok: true, wake, bus_seq: state.seq };
  });
}

export function createWake(state, { from, to, reason, urgency = "normal", plan = ["bus"], presence, payload = null, trigger }) {
  const target = ensureAgent(state, to);
  const ttlMs = urgency === "urgent" ? 15 * 60_000 : 60 * 60_000;

  const wake = {
    id: nextId(state, "wake"),
    from,
    to,
    reason: reason ?? "wake requested",
    urgency,
    trigger: trigger ?? "manual",
    presence_at_request: presence ?? presenceOf(target),
    tiers: plan,
    delivered: [],
    status: "pending",
    payload,
    created_at: timestamp(),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };

  state.wakes.push(wake);

  // Clearing the sleep window is what actually unblocks a parked agent.
  target.sleep_until = null;
  target.woken_by = from;
  target.woken_reason = wake.reason;
  target.woken_at = wake.created_at;

  emit(state, "wake", {
    actor: from,
    audience: [to, from],
    ref: wake.id,
    data: { to, reason: wake.reason, urgency, tiers: plan, trigger: wake.trigger },
  });

  return wake;
}

export function recordWakeDelivery(store, { wake_id, tier, by, detail }) {
  return store.update((state) => {
    const wake = state.wakes.find((item) => item.id === wake_id);
    if (!wake) {
      return { ok: false };
    }
    wake.delivered.push({ tier, by, detail: detail ?? null, at: timestamp() });
    if (wake.status === "pending") {
      wake.status = "delivered";
    }
    return { ok: true, wake };
  });
}

/** Atomically take ownership of a wake tier so two processes cannot double-fire it. */
export function claimWakeTier(store, { wake_id, tier, by }) {
  return store.update((state) => {
    const wake = state.wakes.find((item) => item.id === wake_id);
    if (!wake || wake.status === "acknowledged" || wake.status === "expired") {
      return { ok: false };
    }
    wake.claims ??= {};
    if (wake.claims[tier]) {
      return { ok: false, owner: wake.claims[tier] };
    }
    wake.claims[tier] = { by, at: timestamp() };
    return { ok: true, wake };
  });
}

function unreadFor(state, agentId) {
  const cursor = state.reads[agentId]?.inbox ?? "";
  return state.messages
    .filter((message) => isRecipient(message, agentId))
    .filter((message) => !cursor || Number(message.id.split("_").at(-1)) > Number(cursor.split("_").at(-1)))
    .slice(-20);
}

function isRecipient(message, agentId) {
  if (message.to === agentId || message.to === "*") {
    return true;
  }
  return Array.isArray(message.to) && message.to.includes(agentId);
}

function normalizeWakeFilter(wakeOn) {
  if (!wakeOn) {
    return { min_priority: "normal", from: [], topics: [] };
  }
  return {
    min_priority: wakeOn.min_priority ?? "normal",
    from: Array.isArray(wakeOn.from) ? wakeOn.from : [],
    topics: Array.isArray(wakeOn.topics) ? wakeOn.topics : [],
  };
}

function passesWakeFilter(wakeOn, { priority, from, topic }) {
  const filter = normalizeWakeFilter(wakeOn);
  if ((PRIORITY_RANK[priority] ?? 1) < (PRIORITY_RANK[filter.min_priority] ?? 1)) {
    return false;
  }
  if (filter.from.length > 0 && !filter.from.includes(from)) {
    return false;
  }
  if (filter.topics.length > 0 && topic && !filter.topics.includes(topic)) {
    return false;
  }
  return true;
}

function detectTmuxTarget(env = process.env) {
  if (env?.VIBEBUS_TMUX === "0") {
    return null;
  }
  return env?.TMUX_PANE ?? null;
}

function describePlan(plan, presence) {
  if (plan.length <= 1) {
    return `Target is ${presence}; only the bus tier is reachable. It will see this the next time it reads the bus.`;
  }
  return `Target is ${presence}; escalating through ${plan.join(" -> ")}.`;
}
