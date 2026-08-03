/**
 * Presence and the wake ladder.
 *
 * "Is that agent alive?" is answered from heartbeat age plus any sleep window
 * the agent declared for itself. The answer decides how hard we have to knock
 * to get its attention.
 */
export const PRESENCE_TTL = {
  online: 60_000,
  idle: 5 * 60_000,
  stale: 30 * 60_000,
};

/**
 * Escalation order, cheapest and least intrusive first.
 *
 * `model` runs a side-channel completion in the target's client; `tmux` types
 * into the target's real interactive session, which is the only tier that makes
 * an idle CLI agent actually resume its own work. In practice tmux and process
 * are the tiers that work everywhere, because MCP sampling and elicitation are
 * still unevenly supported across clients.
 */
export const WAKE_TIERS = ["bus", "session", "model", "tmux", "human", "process"];

export function presenceOf(agent, now = Date.now()) {
  if (!agent) {
    return "unknown";
  }

  if (agent.sleep_until && Date.parse(agent.sleep_until) > now) {
    return "asleep";
  }

  const age = now - Date.parse(agent.last_seen_at ?? agent.registered_at ?? 0);
  if (!Number.isFinite(age)) {
    return "offline";
  }
  if (age <= PRESENCE_TTL.online) {
    return "online";
  }
  if (age <= PRESENCE_TTL.idle) {
    return "idle";
  }
  if (age <= PRESENCE_TTL.stale) {
    return "stale";
  }
  return "offline";
}

/**
 * "The model is idle" and "the process is gone" are different problems with
 * different fixes, so they are tracked separately: `presence` follows agent
 * activity, `session_live` follows the MCP process that can be pushed to.
 */
export const SESSION_TTL = 90_000;

export function sessionLive(agent, now = Date.now()) {
  const at = Date.parse(agent?.session_alive_at ?? 0);
  return Number.isFinite(at) && now - at <= SESSION_TTL;
}

export function describeAgent(agent, now = Date.now()) {
  const presence = presenceOf(agent, now);
  const lastSeen = Date.parse(agent.last_seen_at ?? 0);

  return {
    ...agent,
    presence,
    session_live: sessionLive(agent, now),
    reachable: reachabilityOf(agent, presence, now),
    seconds_since_seen: Number.isFinite(lastSeen) ? Math.round((now - lastSeen) / 1000) : null,
  };
}

function reachabilityOf(agent, presence, now = Date.now()) {
  const supports = agent.supports ?? {};
  const live = sessionLive(agent, now) || presence === "online" || presence === "asleep";

  return {
    bus: true,
    session: live,
    model: Boolean(supports.sampling) && live,
    tmux: Boolean(agent.tmux_target),
    human: Boolean(supports.elicitation) && live,
    process: Boolean(agent.wake_command),
  };
}

/**
 * Pick the escalation ladder for a wake request. Every wake starts at the bus
 * tier (free, instant, wakes anything blocked in a wait_* call) and climbs
 * until it reaches a tier the target can actually answer on.
 */
export function planWake(agent, { urgency = "normal", max_tier = "process" } = {}, now = Date.now()) {
  const presence = presenceOf(agent, now);
  const reach = reachabilityOf(agent ?? {}, presence, now);
  // The plan reports what the bus *would* try. Actually spawning a process is
  // separately gated by VIBEBUS_ALLOW_SPAWN, so the ceiling stays honest here
  // rather than hiding the tier an offline agent needs.
  const ceiling = WAKE_TIERS.indexOf(max_tier) === -1 ? WAKE_TIERS.length - 1 : WAKE_TIERS.indexOf(max_tier);

  const wanted = ["bus"];

  // An online agent is already looping on the bus; a nudge is enough unless the
  // caller says otherwise.
  if (presence !== "offline") {
    wanted.push("session");
  }

  const dormant = presence === "asleep" || presence === "idle" || presence === "stale";
  const pressing = urgency === "urgent" || urgency === "high";

  if (dormant || pressing) {
    wanted.push("model");
    // Typing into the target's own session is what actually makes an idle
    // interactive agent pick the work back up.
    wanted.push("tmux");
  }

  if (urgency === "urgent" || presence === "stale" || presence === "offline") {
    wanted.push("human");
  }

  if (presence === "offline" || presence === "stale") {
    wanted.push("process");
  }

  const plan = [...new Set(wanted)]
    .filter((tier) => WAKE_TIERS.indexOf(tier) <= ceiling)
    .filter((tier) => reach[tier]);

  return { presence, plan, reachable: reach };
}
