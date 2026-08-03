import { createWake } from "./agents.js";
import { busError, diagnose, requireAgent, unreachableHint } from "./errors.js";
import { emit } from "./events.js";
import { emitMessage, makeMessage } from "./messaging.js";
import { planWake, presenceOf } from "./presence.js";
import { nextId } from "./store.js";
import { clampMs, normalizeLimit, requireString, timestamp, touchAgent } from "./shared.js";

/**
 * Blocking agent-to-agent question.
 *
 * This is the primitive that makes the bus bidirectional: the caller does not
 * just drop a note and hope. It waits for an answer, and if no answer arrives
 * it fails with a typed error explaining exactly which delivery tiers were
 * tried and what the target looked like.
 */
export async function askAgent(store, input, ctx = {}) {
  requireString(input, "from");
  requireString(input, "to");
  requireString(input, "question");

  const timeoutMs = clampMs(input.timeout_ms, 60_000, 1000, 600_000);
  const startedAt = Date.now();

  const created = store.update((state) => {
    const target = requireAgent(state, input.to, "ask target");
    const presence = presenceOf(target);
    const { plan } = planWake(target, { urgency: input.urgency ?? "high" });

    const ask = {
      id: nextId(state, "ask"),
      from: input.from,
      to: input.to,
      question: input.question,
      context: input.context ?? null,
      mode: input.mode ?? "auto",
      status: "pending",
      answer: null,
      answered_by: null,
      answered_at: null,
      serviced_by: null,
      attempts: [],
      files: input.files ?? [],
      created_at: timestamp(),
      expires_at: new Date(Date.now() + timeoutMs).toISOString(),
    };

    // Carry the question into the inbox too, so an agent driven by a human (or
    // by its own polling loop) can answer it without any sampling support.
    const message = makeMessage(state, {
      from: input.from,
      to: input.to,
      message: `[ask ${ask.id}] ${input.question}\n\nReply with reply_to_ask(ask_id:"${ask.id}", answer:"…").`,
      priority: input.priority ?? "high",
      topic: "ask",
      files: input.files,
      requires_ack: false,
    });
    message.ask_id = ask.id;
    ask.message_id = message.id;
    ask.thread_id = message.thread_id;

    state.messages.push(message);
    state.asks.push(ask);

    emit(state, "ask.created", {
      actor: input.from,
      audience: [input.from, input.to],
      ref: ask.id,
      data: { question: input.question, mode: ask.mode, timeout_ms: timeoutMs },
    });
    emitMessage(state, message);

    const wake = createWake(state, {
      from: input.from,
      to: input.to,
      reason: `question from ${input.from}: ${input.question.slice(0, 120)}`,
      urgency: input.urgency ?? "high",
      plan,
      presence,
      trigger: "ask_agent",
    });

    touchAgent(state, input.from);
    return { ask, message, wake, presence, plan, bus_seq: state.seq };
  });

  const resolved = await awaitResolution(store, {
    timeoutMs,
    startCursor: created.bus_seq,
    onTick: (remaining) => ctx.session?.progress?.(`waiting for ${input.to} to answer (${Math.round(remaining / 1000)}s left)`),
    resolve: (state) => {
      const ask = state.asks.find((item) => item.id === created.ask.id);
      if (!ask || ask.status === "pending" || ask.status === "servicing") {
        return null;
      }
      return ask;
    },
  });

  const latencyMs = Date.now() - startedAt;

  if (resolved && resolved.status === "answered") {
    return {
      ok: true,
      ask_id: resolved.id,
      answer: resolved.answer,
      answered_by: resolved.answered_by,
      via: resolved.via ?? "inbox",
      latency_ms: latencyMs,
      thread_id: resolved.thread_id,
    };
  }

  const state = store.read();
  const ask = state.asks.find((item) => item.id === created.ask.id);
  const diagnosis = diagnose(state, input.to);
  const attempts = ask?.attempts ?? [];

  if (resolved && resolved.status === "declined") {
    throw busError("ask_declined", `${input.to} declined to answer ask ${resolved.id}.`, {
      hint: resolved.answer ? `Reason given: ${resolved.answer}` : "Ask a different agent or rephrase the request.",
      details: { ask_id: resolved.id, latency_ms: latencyMs, target: diagnosis },
    });
  }

  if (input.soft_fail) {
    return {
      ok: false,
      ask_id: created.ask.id,
      answered: false,
      reason: "no_reply",
      latency_ms: latencyMs,
      target: diagnosis,
      attempts,
      hint: unreachableHint(diagnosis),
    };
  }

  throw busError("no_reply", `No reply from ${input.to} within ${timeoutMs}ms (ask ${created.ask.id}).`, {
    hint: unreachableHint(diagnosis),
    details: {
      ask_id: created.ask.id,
      question: input.question,
      waited_ms: latencyMs,
      wake_tiers_planned: created.plan,
      delivery_attempts: attempts,
      target: diagnosis,
      recovery: [
        `The question is still in ${input.to}'s inbox as ${created.message.id}; it can answer late with reply_to_ask.`,
        "Retry with a longer timeout_ms, or soft_fail:true to get a result object instead of an error.",
      ],
    },
  });
}

export function replyToAsk(store, input) {
  requireString(input, "agent_id");
  requireString(input, "ask_id");

  return store.update((state) => {
    const ask = state.asks.find((item) => item.id === input.ask_id);
    if (!ask) {
      throw busError("not_found", `Unknown ask: ${input.ask_id}`, {
        hint: "Ask ids look like ask_000001 and appear in the inbox message that carried the question.",
      });
    }
    if (ask.status === "answered" || ask.status === "declined") {
      throw busError("task_conflict", `Ask ${ask.id} was already ${ask.status} by ${ask.answered_by}.`, {
        hint: "Send a normal message instead if you want to add to the answer.",
        details: { answer: ask.answer },
      });
    }

    const declined = Boolean(input.decline);
    if (!declined) {
      requireString(input, "answer");
    }

    ask.status = declined ? "declined" : "answered";
    ask.answer = input.answer ?? input.reason ?? null;
    ask.answered_by = input.agent_id;
    ask.answered_at = timestamp();
    ask.via = input.via ?? "inbox";

    // Thread the answer back so the conversation stays readable.
    const reply = makeMessage(state, {
      from: input.agent_id,
      to: ask.from,
      message: declined ? `[declined ${ask.id}] ${ask.answer ?? "no reason given"}` : `[answer ${ask.id}] ${ask.answer}`,
      priority: "high",
      topic: "ask",
      thread_id: ask.thread_id,
      reply_to: ask.message_id,
    });
    reply.ask_id = ask.id;
    state.messages.push(reply);
    emitMessage(state, reply);

    emit(state, declined ? "ask.declined" : "ask.answered", {
      actor: input.agent_id,
      audience: [ask.from, ask.to],
      ref: ask.id,
      data: { via: ask.via, preview: String(ask.answer ?? "").slice(0, 160) },
    });

    touchAgent(state, input.agent_id);
    return { ok: true, ask, reply, bus_seq: state.seq };
  });
}

export function listAsks(store, input = {}) {
  const state = store.read();
  const limit = normalizeLimit(input.limit, 25);
  const asks = state.asks
    .filter((ask) => !input.status || ask.status === input.status)
    .filter((ask) => !input.agent_id || ask.to === input.agent_id || ask.from === input.agent_id)
    .slice(-limit);

  return { ok: true, asks, bus_seq: state.seq };
}

/**
 * Round-trip liveness proof. A live session answers automatically without
 * spending a model call, so this is the honest "is the bus actually working"
 * check: either you get a latency number, or a typed unreachable error.
 */
export async function pingAgent(store, input, ctx = {}) {
  requireString(input, "from");
  requireString(input, "to");
  const timeoutMs = clampMs(input.timeout_ms, 5000, 500, 60_000);
  const startedAt = Date.now();

  const created = store.update((state) => {
    requireAgent(state, input.to, "ping target");
    const ask = {
      id: nextId(state, "ask"),
      from: input.from,
      to: input.to,
      question: "__vibebus_ping__",
      mode: "ping",
      status: "pending",
      answer: null,
      answered_by: null,
      attempts: [],
      created_at: timestamp(),
      expires_at: new Date(Date.now() + timeoutMs).toISOString(),
    };
    state.asks.push(ask);
    emit(state, "ask.created", {
      actor: input.from,
      audience: [input.from, input.to],
      ref: ask.id,
      data: { mode: "ping" },
    });
    touchAgent(state, input.from);
    return { ask, bus_seq: state.seq };
  });

  const resolved = await awaitResolution(store, {
    timeoutMs,
    startCursor: created.bus_seq,
    onTick: () => ctx.session?.progress?.(`pinging ${input.to}`),
    resolve: (state) => {
      const ask = state.asks.find((item) => item.id === created.ask.id);
      return ask && ask.status === "answered" ? ask : null;
    },
  });

  const latencyMs = Date.now() - startedAt;

  if (resolved) {
    return {
      ok: true,
      alive: true,
      target: input.to,
      latency_ms: latencyMs,
      answered_by: resolved.answered_by,
      session: resolved.answer ?? null,
    };
  }

  const diagnosis = diagnose(store.read(), input.to);

  if (input.soft_fail) {
    return { ok: false, alive: false, target: input.to, latency_ms: latencyMs, reason: "no_session", diagnosis };
  }

  throw busError("agent_unreachable", `${input.to} did not answer a ping within ${timeoutMs}ms — no live MCP session is attached to that agent id.`, {
    hint: unreachableHint(diagnosis),
    details: {
      target: diagnosis,
      meaning:
        "The bus itself is fine — writes are landing. What is missing is a running process bound to this agent id that can respond.",
      recovery: [
        "Start that CLI and let it call register_agent.",
        "Or use wake_agent with max_tier:\"process\" if a wake_command is registered.",
      ],
    },
  });
}

/**
 * Ask the human sitting behind another agent's CLI, via MCP elicitation.
 */
export async function requestApproval(store, input, ctx = {}) {
  requireString(input, "from");
  requireString(input, "to");
  requireString(input, "question");
  const timeoutMs = clampMs(input.timeout_ms, 120_000, 1000, 600_000);
  const startedAt = Date.now();

  const created = store.update((state) => {
    const target = requireAgent(state, input.to, "approval target");

    const approval = {
      id: nextId(state, "approval"),
      from: input.from,
      to: input.to,
      question: input.question,
      options: input.options ?? ["approve", "reject"],
      detail: input.detail ?? null,
      status: "pending",
      action: null,
      content: null,
      resolved_by: null,
      created_at: timestamp(),
      expires_at: new Date(Date.now() + timeoutMs).toISOString(),
    };
    state.approvals.push(approval);

    const message = makeMessage(state, {
      from: input.from,
      to: input.to,
      message: `[approval ${approval.id}] ${input.question}\n\nOptions: ${approval.options.join(", ")}\nAnswer with resolve_approval(approval_id:"${approval.id}", action:"…").`,
      priority: "urgent",
      topic: "approval",
      requires_ack: false,
    });
    message.approval_id = approval.id;
    approval.message_id = message.id;
    state.messages.push(message);
    emitMessage(state, message);

    emit(state, "approval.requested", {
      actor: input.from,
      audience: [input.from, input.to],
      ref: approval.id,
      data: { question: input.question, options: approval.options },
    });

    createWake(state, {
      from: input.from,
      to: input.to,
      reason: `approval needed: ${input.question.slice(0, 120)}`,
      urgency: "urgent",
      plan: planWake(target, { urgency: "urgent" }).plan,
      trigger: "request_approval",
    });

    touchAgent(state, input.from);
    return { approval, bus_seq: state.seq };
  });

  const resolved = await awaitResolution(store, {
    timeoutMs,
    startCursor: created.bus_seq,
    onTick: (remaining) => ctx.session?.progress?.(`waiting on ${input.to} for approval (${Math.round(remaining / 1000)}s left)`),
    resolve: (state) => {
      const approval = state.approvals.find((item) => item.id === created.approval.id);
      return approval && approval.status !== "pending" ? approval : null;
    },
  });

  const latencyMs = Date.now() - startedAt;

  if (resolved && resolved.status === "resolved") {
    return {
      ok: true,
      approval_id: resolved.id,
      action: resolved.action,
      content: resolved.content ?? null,
      resolved_by: resolved.resolved_by,
      latency_ms: latencyMs,
    };
  }

  const diagnosis = diagnose(store.read(), input.to);
  if (input.soft_fail) {
    return { ok: false, approval_id: created.approval.id, action: "timeout", latency_ms: latencyMs, target: diagnosis };
  }

  throw busError("no_reply", `No approval decision from ${input.to} within ${timeoutMs}ms (approval ${created.approval.id}).`, {
    hint: diagnosis.supports?.elicitation
      ? "The request was pushed to that CLI; nobody answered the prompt."
      : "That client does not support MCP elicitation, so no prompt could be shown. A human must read its inbox and call resolve_approval.",
    details: { approval_id: created.approval.id, waited_ms: latencyMs, target: diagnosis },
  });
}

export function resolveApproval(store, input) {
  requireString(input, "agent_id");
  requireString(input, "approval_id");
  requireString(input, "action");

  return store.update((state) => {
    const approval = state.approvals.find((item) => item.id === input.approval_id);
    if (!approval) {
      throw busError("not_found", `Unknown approval: ${input.approval_id}`);
    }
    approval.status = "resolved";
    approval.action = input.action;
    approval.content = input.content ?? null;
    approval.resolved_by = input.agent_id;
    approval.resolved_at = timestamp();

    emit(state, "approval.resolved", {
      actor: input.agent_id,
      audience: [approval.from, approval.to],
      ref: approval.id,
      data: { action: approval.action },
    });

    touchAgent(state, input.agent_id);
    return { ok: true, approval, bus_seq: state.seq };
  });
}

/** Shared blocking loop: park on the state watcher until a predicate resolves. */
export async function awaitResolution(store, { timeoutMs, startCursor, resolve, onTick }) {
  const deadline = Date.now() + timeoutMs;
  let cursor = startCursor ?? store.seq();

  const immediate = resolve(store.read());
  if (immediate) {
    return immediate;
  }

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    onTick?.(remaining);
    await store.waitForChange(cursor, Math.min(remaining, 5000));
    cursor = store.seq();

    const found = resolve(store.read());
    if (found) {
      return found;
    }
  }

  return null;
}
