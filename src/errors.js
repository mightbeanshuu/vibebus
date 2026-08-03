import { presenceOf } from "./presence.js";

/**
 * Vibe Bus fails loudly.
 *
 * The worst outcome for a coordination bus is looking healthy while nothing is
 * actually delivered, so anything that expects a reply and does not get one
 * raises a typed error carrying: what was attempted, what the target looked
 * like at the time, and the one thing the caller should do next.
 */
export class BusError extends Error {
  constructor(code, message, { status = 400, hint = null, details = {} } = {}) {
    super(message);
    this.name = "BusError";
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.details = details;
  }

  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        status: this.status,
        message: this.message,
        hint: this.hint,
        details: this.details,
      },
    };
  }
}

export const ERROR_CODES = {
  unknown_agent: 404,
  not_found: 404,
  invalid_request: 400,
  no_reply: 504,
  ask_timeout: 504,
  wake_undelivered: 504,
  timeout: 504,
  ask_declined: 409,
  lease_conflict: 409,
  context_conflict: 409,
  task_conflict: 409,
  agent_unreachable: 503,
  no_session: 503,
  unsupported: 501,
};

export function busError(code, message, options = {}) {
  return new BusError(code, message, { status: ERROR_CODES[code] ?? 500, ...options });
}

export function requireAgent(state, agentId, label = "agent") {
  const agent = state.agents[agentId];
  if (!agent) {
    throw busError("unknown_agent", `Unknown ${label}: ${agentId}`, {
      hint: "Call who (or team_status) to list registered agents. The target must call register_agent once per session.",
      details: { requested: agentId, registered: Object.keys(state.agents) },
    });
  }
  return agent;
}

/**
 * A snapshot of why an agent did or did not answer. Embedded in every
 * delivery failure so the caller never has to guess whether the bus is broken
 * or the other agent simply is not running.
 */
export function diagnose(state, agentId, now = Date.now()) {
  const agent = state.agents[agentId];
  if (!agent) {
    return { agent_id: agentId, registered: false };
  }

  const lastSeen = Date.parse(agent.last_seen_at ?? 0);
  const pendingWakes = (state.wakes ?? []).filter(
    (wake) => wake.to === agentId && (wake.status === "pending" || wake.status === "delivered"),
  );

  return {
    agent_id: agentId,
    registered: true,
    presence: presenceOf(agent, now),
    cli: agent.cli,
    model: agent.model ?? null,
    status: agent.status ?? null,
    last_seen_at: agent.last_seen_at ?? null,
    seconds_since_seen: Number.isFinite(lastSeen) ? Math.round((now - lastSeen) / 1000) : null,
    sleep_until: agent.sleep_until ?? null,
    supports: agent.supports ?? {},
    has_wake_command: Boolean(agent.wake_command),
    pending_wakes: pendingWakes.map((wake) => ({ id: wake.id, tiers: wake.tiers, delivered: wake.delivered.length })),
  };
}

/** Why a wake or reply attempt failed, phrased as an action the user can take. */
export function unreachableHint(diagnosis) {
  if (!diagnosis.registered) {
    return "That agent has never registered on this bus. Start its CLI and have it call register_agent.";
  }
  if (diagnosis.presence === "offline") {
    return diagnosis.has_wake_command
      ? "Agent is offline. Re-run the wake with max_tier:\"process\" (and VIBEBUS_ALLOW_SPAWN=1) to relaunch it headlessly."
      : "Agent is offline and has no wake_command registered. Start its CLI, or register a wake_command so the bus can relaunch it.";
  }
  if (!diagnosis.supports?.sampling) {
    return "Agent's MCP client does not support sampling, so the bus cannot make its model run. It will only see this when a human or its own loop reads the bus.";
  }
  return "Agent is registered but did not answer in time. Check that its CLI session is still open and not blocked on a prompt.";
}
