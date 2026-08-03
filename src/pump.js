import { spawn } from "node:child_process";

import { claimWakeTier, recordWakeDelivery } from "./agents.js";
import { eventsSince, eventVisibleTo, resourcesTouchedBy } from "./events.js";
import { replyToAsk, resolveApproval } from "./asks.js";
import { presenceOf } from "./presence.js";
import { buildWakePrompt, canType, typeIntoTerminal } from "./terminal.js";
import { timestamp } from "./shared.js";

const SESSION_HEARTBEAT_MS = 30_000;
const TICK_DEBOUNCE_MS = 15;

/**
 * The background half of every MCP server process.
 *
 * While the client is idle, this loop keeps watching the shared bus and turns
 * incoming activity into outbound MCP traffic: resource-updated notifications,
 * live log lines, auto-answered pings, sampled answers to other agents'
 * questions, elicitation prompts, and — for agents that have no process left at
 * all — relaunching them.
 */
export function startPump({ store, session, env = process.env, onError } = {}) {
  let cursor = store.seq();
  let running = false;
  let queued = false;
  let stopped = false;
  let debounce = null;

  const handled = new Set();
  const allowSpawn = env.VIBEBUS_ALLOW_SPAWN === "1";
  const samplingEnabled = env.VIBEBUS_SAMPLING !== "0";

  const schedule = () => {
    if (stopped) {
      return;
    }
    if (debounce) {
      return;
    }
    debounce = setTimeout(() => {
      debounce = null;
      tick().catch((error) => onError?.(error));
    }, TICK_DEBOUNCE_MS);
    debounce.unref?.();
  };

  async function tick() {
    if (running) {
      queued = true;
      return;
    }
    running = true;

    try {
      const state = store.read();
      const events = eventsSince(state, cursor, { limit: 500 });
      cursor = state.seq;

      if (events.length > 0) {
        pushResourceUpdates(events);
        pushLogLines(events, state);
      }

      await serviceWork(state);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        schedule();
      }
    }
  }

  function pushResourceUpdates(events) {
    const uris = new Set();
    for (const event of events) {
      for (const uri of resourcesTouchedBy(event.type)) {
        uris.add(uri);
      }
    }
    for (const uri of uris) {
      session.notifyResourceUpdated(uri);
    }
  }

  function pushLogLines(events, state) {
    const agentId = session.agentId;
    if (!agentId) {
      return;
    }

    for (const event of events) {
      if (event.actor === agentId || !eventVisibleTo(event, agentId)) {
        continue;
      }

      const level = levelFor(event);
      session.notifyLog(level, {
        event: event.type,
        seq: event.seq,
        from: event.actor,
        ref: event.ref,
        summary: summarize(event, state),
        ...event.data,
      });
    }
  }

  async function serviceWork(state) {
    const agentId = session.agentId;

    // Process-tier wakes are the one job a process does on another agent's
    // behalf: the target has nothing running to service its own wake.
    await serviceProcessWakes(state, agentId);

    if (!agentId) {
      return;
    }

    await servicePings(state, agentId);
    await serviceAsks(state, agentId);
    await serviceWakes(state, agentId);
    await serviceApprovals(state, agentId);
  }

  /** Pings never spend a model call — answering proves the session is live. */
  async function servicePings(state, agentId) {
    const pings = state.asks.filter((ask) => ask.to === agentId && ask.mode === "ping" && ask.status === "pending");

    for (const ask of pings) {
      if (once(`ping:${ask.id}`)) {
        continue;
      }
      try {
        replyToAsk(store, {
          agent_id: agentId,
          ask_id: ask.id,
          answer: JSON.stringify(session.clientCapabilitySummary()),
          via: "session",
        });
      } catch (error) {
        onError?.(error);
      }
    }
  }

  /** Answer another agent's question by running this client's model. */
  async function serviceAsks(state, agentId) {
    if (!samplingEnabled || !session.capabilities.sampling) {
      return;
    }

    const asks = state.asks.filter((ask) => ask.to === agentId && ask.status === "pending" && ask.mode !== "ping");

    for (const ask of asks) {
      if (once(`ask:${ask.id}`)) {
        continue;
      }

      const claimed = claimWakeTier(store, { wake_id: ask.id, tier: "sampling", by: process.pid });
      void claimed;

      try {
        session.notifyLog("info", { event: "ask.servicing", ask_id: ask.id, from: ask.from });

        const { text, model } = await session.sample({
          system:
            "You are answering a question from another AI coding agent on a shared local bus. " +
            "Answer directly and concretely from what you know about this workspace. " +
            "If you genuinely cannot answer, say so plainly and say what you would need.",
          prompt: buildAskPrompt(ask),
          maxTokens: 900,
        });

        if (text) {
          replyToAsk(store, { agent_id: agentId, ask_id: ask.id, answer: text, via: `sampling:${model ?? "unknown"}` });
        }
      } catch (error) {
        // Leave the ask pending: a human or the agent's own loop can still
        // answer it, and the asker's timeout will report the real reason.
        session.notifyLog("warning", { event: "ask.sampling_failed", ask_id: ask.id, error: error.message });
        onError?.(error);
      }
    }
  }

  async function serviceWakes(state, agentId) {
    const wakes = state.wakes.filter(
      (wake) => wake.to === agentId && (wake.status === "pending" || wake.status === "delivered"),
    );

    for (const wake of wakes) {
      // Session tier: always, and free.
      if (!once(`wake:session:${wake.id}`) && wake.tiers.includes("session")) {
        session.notifyLog(wake.urgency === "urgent" ? "warning" : "notice", {
          event: "wake",
          wake_id: wake.id,
          from: wake.from,
          urgency: wake.urgency,
          reason: wake.reason,
          action: "Read your inbox with read_inbox, then acknowledge with ack_message.",
        });
        recordWakeDelivery(store, { wake_id: wake.id, tier: "session", by: agentId });
      }

      if (wake.tiers.includes("model") && samplingEnabled && session.capabilities.sampling && !once(`wake:model:${wake.id}`)) {
        const claim = claimWakeTier(store, { wake_id: wake.id, tier: "model", by: `${agentId}:${process.pid}` });
        if (claim.ok) {
          await wakeModel(wake, agentId);
        }
      }

      if (wake.tiers.includes("terminal") && !once(`wake:terminal:${wake.id}`)) {
        const target = state.agents[agentId];
        if (canType(target) && env.VIBEBUS_TERMINAL !== "0") {
          const claim = claimWakeTier(store, { wake_id: wake.id, tier: "terminal", by: `${agentId}:${process.pid}` });
          if (claim.ok) {
            wakeViaTerminal(wake, agentId, target, state);
          }
        }
      }

      if (wake.tiers.includes("human") && session.capabilities.elicitation && !once(`wake:human:${wake.id}`)) {
        const claim = claimWakeTier(store, { wake_id: wake.id, tier: "human", by: `${agentId}:${process.pid}` });
        if (claim.ok) {
          await wakeHuman(wake, agentId);
        }
      }
    }
  }

  async function wakeModel(wake, agentId) {
    try {
      const { text, model } = await session.sample({
        system:
          "You are a coding agent that was just woken by a teammate on a shared local agent bus. " +
          "State in one or two sentences what you will do about it. Be concrete.",
        prompt:
          `Agent "${wake.from}" woke you (urgency: ${wake.urgency}).\n\n` +
          `Reason: ${wake.reason}\n` +
          (wake.payload ? `Context: ${JSON.stringify(wake.payload)}\n` : "") +
          `\nWhat will you do?`,
        maxTokens: 300,
      });

      recordWakeDelivery(store, { wake_id: wake.id, tier: "model", by: agentId, detail: text?.slice(0, 400) ?? null });

      if (text) {
        store.update((state) => {
          const agent = state.agents[agentId];
          if (agent) {
            agent.status = "waking";
            agent.note = text.slice(0, 240);
            agent.last_seen_at = timestamp();
          }
          return { ok: true };
        });
      }

      session.notifyLog("notice", { event: "wake.model_answered", wake_id: wake.id, model, reply: text });
    } catch (error) {
      session.notifyLog("warning", { event: "wake.model_failed", wake_id: wake.id, error: error.message });
    }
  }

  /**
   * Type the wake straight into the agent's own prompt.
   *
   * This is the tier that actually resumes an idle interactive agent: the text
   * lands in its input box and is submitted, exactly as if the human had pasted
   * it. Works across tmux, Terminal.app, and iTerm2, so it does not depend on
   * the client implementing MCP sampling.
   */
  function wakeViaTerminal(wake, agentId, target, state) {
    // If the wake came from a blocked question, hand over the ask id so the
    // agent can answer it directly instead of hunting through its inbox.
    const ask = (state.asks ?? []).find(
      (item) => item.to === agentId && item.status === "pending" && item.mode !== "ping",
    );

    const prompt = buildWakePrompt({
      agentId,
      from: wake.from,
      reason: wake.reason,
      urgency: wake.urgency,
      askId: ask?.id ?? null,
    });

    typeIntoTerminal(target.terminal ?? { kind: "tmux", pane: target.tmux_target }, prompt, (result) => {
      if (!result.ok) {
        session.notifyLog("warning", { event: "wake.terminal_failed", wake_id: wake.id, error: result.error });
        return;
      }
      recordWakeDelivery(store, {
        wake_id: wake.id,
        tier: "terminal",
        by: agentId,
        detail: `${result.method}:${result.target}`,
      });
      session.notifyLog("notice", { event: "wake.terminal_typed", wake_id: wake.id, method: result.method });
    });
  }

  async function wakeHuman(wake, agentId) {
    try {
      const { action, content } = await session.elicit({
        message: `Vibe Bus: ${wake.from} needs ${agentId}.\n\n${wake.reason}`,
        schema: {
          type: "object",
          properties: {
            response: { type: "string", title: "Reply", description: "What should the bus tell them?" },
          },
          required: [],
        },
        timeoutMs: 180_000,
      });

      recordWakeDelivery(store, { wake_id: wake.id, tier: "human", by: agentId, detail: action });
      session.notifyLog("notice", { event: "wake.human_answered", wake_id: wake.id, action, content });
    } catch (error) {
      session.notifyLog("warning", { event: "wake.human_failed", wake_id: wake.id, error: error.message });
    }
  }

  async function serviceApprovals(state, agentId) {
    if (!session.capabilities.elicitation) {
      return;
    }

    const approvals = state.approvals.filter((approval) => approval.to === agentId && approval.status === "pending");

    for (const approval of approvals) {
      if (once(`approval:${approval.id}`)) {
        continue;
      }

      try {
        const { action, content } = await session.elicit({
          message: `${approval.from} asks: ${approval.question}${approval.detail ? `\n\n${approval.detail}` : ""}`,
          schema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                title: "Decision",
                enum: approval.options,
              },
              note: { type: "string", title: "Note", description: "Optional explanation" },
            },
            required: ["decision"],
          },
        });

        resolveApproval(store, {
          agent_id: agentId,
          approval_id: approval.id,
          action: action === "accept" ? content?.decision ?? "approve" : action,
          content: content ?? null,
        });
      } catch (error) {
        session.notifyLog("warning", { event: "approval.failed", approval_id: approval.id, error: error.message });
      }
    }
  }

  /**
   * Last resort: the target agent has no process at all. If it registered a
   * wake_command, relaunch it headlessly so it can rejoin the bus.
   */
  async function serviceProcessWakes(state, selfAgentId) {
    if (!allowSpawn) {
      return;
    }

    const candidates = state.wakes.filter(
      (wake) =>
        wake.to !== selfAgentId &&
        wake.tiers.includes("process") &&
        (wake.status === "pending" || wake.status === "delivered"),
    );

    for (const wake of candidates) {
      if (once(`wake:process:${wake.id}`)) {
        continue;
      }

      const target = state.agents[wake.to];
      if (!target?.wake_command || presenceOf(target) !== "offline") {
        continue;
      }

      const claim = claimWakeTier(store, { wake_id: wake.id, tier: "process", by: `${selfAgentId ?? "anon"}:${process.pid}` });
      if (!claim.ok) {
        continue;
      }

      try {
        const command = target.wake_command.replaceAll("{prompt}", buildRelaunchPrompt(wake, target));
        const child = spawn(command, {
          shell: true,
          detached: true,
          stdio: "ignore",
          cwd: target.workspace ?? undefined,
        });
        child.unref();

        recordWakeDelivery(store, { wake_id: wake.id, tier: "process", by: `pid:${process.pid}`, detail: command });
        session.notifyLog("warning", { event: "wake.process_spawned", wake_id: wake.id, target: wake.to, command });
      } catch (error) {
        session.notifyLog("error", { event: "wake.process_failed", wake_id: wake.id, error: error.message });
      }
    }
  }

  function once(key) {
    if (handled.has(key)) {
      return true;
    }
    handled.add(key);
    if (handled.size > 5000) {
      // Bounded memory: the oldest keys refer to long-resolved work.
      for (const value of [...handled].slice(0, 2500)) {
        handled.delete(value);
      }
    }
    return false;
  }

  // Keep this agent's session freshness current so `who` can tell the
  // difference between "the model is idle" and "the process is gone".
  const heartbeat = setInterval(() => {
    if (!session.agentId) {
      return;
    }
    try {
      store.update((state) => {
        const agent = state.agents[session.agentId];
        if (agent) {
          agent.session_alive_at = timestamp();
          agent.session_pid = process.pid;
        }
        return { ok: true };
      });
    } catch (error) {
      onError?.(error);
    }
  }, SESSION_HEARTBEAT_MS);
  heartbeat.unref?.();

  const unsubscribe = store.onChange(schedule);
  schedule();

  return {
    tick,
    stop() {
      stopped = true;
      unsubscribe?.();
      clearInterval(heartbeat);
      if (debounce) {
        clearTimeout(debounce);
      }
    },
  };
}

function buildAskPrompt(ask) {
  return [
    `Agent "${ask.from}" asks:`,
    "",
    ask.question,
    ask.context ? `\nAdditional context:\n${ask.context}` : "",
    ask.files?.length ? `\nRelevant files: ${ask.files.join(", ")}` : "",
    "",
    "Answer in plain text. No preamble.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRelaunchPrompt(wake, target) {
  return (
    `You were relaunched by Vibe Bus. Register as ${target.agent_id} with register_agent, ` +
    `read your inbox, and handle this: ${wake.reason}`
  ).replaceAll('"', "'");
}

function levelFor(event) {
  if (event.type === "wake") {
    return event.data?.urgency === "urgent" ? "warning" : "notice";
  }
  if (event.type === "ask.created" || event.type === "approval.requested") {
    return "notice";
  }
  if (event.type === "lease.expired" || event.type === "ask.expired") {
    return "warning";
  }
  return "info";
}

function summarize(event, state) {
  switch (event.type) {
    case "message":
      return `${event.actor} sent a ${event.data.priority ?? "normal"} message${event.data.topic ? ` about ${event.data.topic}` : ""}`;
    case "task.created":
      return `${event.actor} created ${event.ref}: ${event.data.title}`;
    case "task.claimed":
      return `${event.actor} claimed ${event.ref}`;
    case "task.updated":
      return `${event.ref} moved ${event.data.from} -> ${event.data.to}`;
    case "task.unblocked":
      return `${event.ref} is unblocked (${event.data.by} finished)`;
    case "wake":
      return `${event.actor} is waking ${event.data.to}: ${event.data.reason}`;
    case "ask.created":
      return `${event.actor} asked a question and is waiting for an answer`;
    case "ask.answered":
      return `${event.actor} answered ${event.ref}`;
    case "lease.acquired":
      return `${event.actor} locked ${event.data.paths?.join(", ")}`;
    case "lease.expired":
      return `lease on ${event.data.paths?.join(", ")} expired`;
    case "decision":
      return `${event.actor} recorded a decision: ${event.data.title}`;
    default:
      return `${event.type} from ${event.actor ?? "bus"}${state ? "" : ""}`;
  }
}
