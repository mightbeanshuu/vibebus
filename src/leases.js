import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { busError } from "./errors.js";
import { emit } from "./events.js";
import { nextId } from "./store.js";
import { clampMs, requireString, timestamp, touchAgent } from "./shared.js";

/**
 * Conflict control for many agents on one repository.
 *
 * v2.0 leases were a single exclusive mode that failed immediately on overlap,
 * which does not survive real workloads: readers blocked readers, a busy path
 * meant a hard error instead of a queue, and nothing noticed when an agent
 * edited a file it never claimed.
 *
 * This module adds the three things that make that workable at scale — shared
 * reads, fair queueing with deadlock detection, and content hashes that catch
 * the edits leases cannot prevent.
 */
const MODES = ["read", "write"];

export async function lease(store, input, ctx = {}) {
  requireString(input, "action");

  switch (input.action) {
    case "list":
      return listLeases(store, input);
    case "acquire":
      return acquireLease(store, input, ctx);
    case "release":
      return releaseLease(store, input, ctx);
    case "renew":
      return renewLease(store, input);
    case "verify":
      return verifyLease(store, input, ctx);
    default:
      throw busError("invalid_request", `Unknown lease action: ${input.action}`, {
        hint: "Use acquire, release, renew, verify, or list.",
      });
  }
}

function listLeases(store, input) {
  const state = store.read();
  return {
    ok: true,
    leases: state.leases.filter((item) => !input.agent_id || item.agent_id === input.agent_id),
    queue: state.lease_queue ?? [],
    bus_seq: state.seq,
  };
}

async function acquireLease(store, input, ctx) {
  requireString(input, "agent_id");
  const paths = normalizePaths(input.paths);
  if (paths.length === 0) {
    throw busError("invalid_request", "paths is required to acquire a lease.");
  }

  const mode = input.mode ?? "write";
  if (!MODES.includes(mode)) {
    throw busError("invalid_request", `Unknown lease mode: ${mode}`, { hint: "Use read or write." });
  }

  const ttlMs = clampMs(input.ttl_ms, 15 * 60_000, 10_000, 4 * 60 * 60_000);
  const waitMs = clampMs(input.wait_ms, 0, 0, 300_000);
  const root = input.root ?? ctx.env?.PWD ?? process.cwd();

  const first = store.update((state) => tryGrant(state, { input, paths, mode, ttlMs, root, waitMs }));

  if (first.granted) {
    return { ok: true, lease: first.lease, waited_ms: 0, bus_seq: first.bus_seq };
  }
  // A deadlock never resolves by waiting, so it must not enter the queue.
  if (first.deadlock || waitMs === 0) {
    throw conflictError(first, paths, mode);
  }

  // Queued: park until the holders release, rather than making every caller
  // implement its own retry loop.
  const startedAt = Date.now();
  const deadline = startedAt + waitMs;
  let cursor = store.seq();

  while (Date.now() < deadline) {
    ctx.session?.progress?.(`waiting on ${first.conflicts.map((item) => item.agent_id).join(", ")} to release`);
    await store.waitForChange(cursor, Math.min(deadline - Date.now(), 5000));
    cursor = store.seq();

    const attempt = store.update((state) => tryGrant(state, { input, paths, mode, ttlMs, root, waitMs, ticketId: first.ticket?.id }));
    if (attempt.granted) {
      return { ok: true, lease: attempt.lease, waited_ms: Date.now() - startedAt, bus_seq: attempt.bus_seq };
    }
    if (attempt.deadlock) {
      throw conflictError(attempt, paths, mode, Date.now() - startedAt);
    }
  }

  const final = store.update((state) => {
    dropTicket(state, first.ticket?.id);
    return { conflicts: conflictsFor(state, paths, mode, input.agent_id), bus_seq: state.seq };
  });

  throw conflictError({ conflicts: final.conflicts }, paths, mode, Date.now() - startedAt);
}

function tryGrant(state, { input, paths, mode, ttlMs, root, waitMs, ticketId }) {
  const conflicts = conflictsFor(state, paths, mode, input.agent_id);

  if (conflicts.length > 0) {
    // Detect a wait-for cycle before parking, so two agents cannot deadlock
    // each other into their full timeouts.
    const cycle = findDeadlock(state, input.agent_id, conflicts.map((item) => item.agent_id));
    if (cycle) {
      dropTicket(state, ticketId);
      return { granted: false, conflicts, deadlock: cycle, bus_seq: state.seq };
    }

    if (waitMs > 0) {
      const ticket = upsertTicket(state, { ticketId, agent_id: input.agent_id, paths, mode });
      return { granted: false, conflicts, ticket, bus_seq: state.seq };
    }
    return { granted: false, conflicts, bus_seq: state.seq };
  }

  // Fairness: an earlier waiter for overlapping paths goes first.
  const ahead = (state.lease_queue ?? []).find(
    (ticket) =>
      ticket.id !== ticketId &&
      ticket.agent_id !== input.agent_id &&
      ticket.paths.some((held) => paths.some((wanted) => pathsOverlap(wanted, held))) &&
      conflictingModes(ticket.mode, mode),
  );
  if (ahead && waitMs > 0) {
    const ticket = upsertTicket(state, { ticketId, agent_id: input.agent_id, paths, mode });
    return { granted: false, conflicts: [{ agent_id: ahead.agent_id, queued: true, paths: ahead.paths }], ticket, bus_seq: state.seq };
  }

  const record = {
    id: nextId(state, "lease"),
    agent_id: input.agent_id,
    paths,
    mode,
    reason: input.reason ?? null,
    task_id: input.task_id ?? null,
    root,
    guards: input.guard ? hashPaths(paths, root) : null,
    acquired_at: timestamp(),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    ttl_ms: ttlMs,
  };

  state.leases.push(record);
  dropTicket(state, ticketId);

  emit(state, "lease.acquired", {
    actor: input.agent_id,
    ref: record.id,
    data: { paths, mode, reason: record.reason, expires_at: record.expires_at },
  });

  return { granted: true, lease: record, bus_seq: state.seq };
}

function releaseLease(store, input, ctx) {
  requireString(input, "agent_id");

  return store.update((state) => {
    const released = state.leases.filter(
      (item) =>
        item.agent_id === input.agent_id &&
        (!input.lease_id || item.id === input.lease_id) &&
        (!input.task_id || item.task_id === input.task_id),
    );
    state.leases = state.leases.filter((item) => !released.includes(item));

    const drift = [];
    for (const item of released) {
      const changed = item.guards ? driftFor(item) : [];
      if (changed.length > 0) {
        drift.push({ lease_id: item.id, changed });
      }
      emit(state, "lease.released", {
        actor: input.agent_id,
        ref: item.id,
        data: { paths: item.paths, mode: item.mode, changed: changed.map((entry) => entry.path) },
      });
    }

    dropTicketsFor(state, input.agent_id);
    touchAgent(state, input.agent_id);

    return { ok: true, released: released.map((item) => item.id), drift, remaining: state.leases.length, bus_seq: state.seq };
  });
}

function renewLease(store, input) {
  requireString(input, "agent_id");

  return store.update((state) => {
    const mine = state.leases.filter((item) => item.agent_id === input.agent_id && (!input.lease_id || item.id === input.lease_id));
    if (mine.length === 0) {
      throw busError("not_found", `No lease to renew for ${input.agent_id}.`, {
        hint: "It may have already expired and been reclaimed. Acquire it again.",
      });
    }
    for (const item of mine) {
      item.expires_at = new Date(Date.now() + (item.ttl_ms ?? 15 * 60_000)).toISOString();
      item.renewed_at = timestamp();
    }
    touchAgent(state, input.agent_id);
    return { ok: true, renewed: mine.map((item) => item.id), bus_seq: state.seq };
  });
}

/**
 * Leases are advisory: nothing stops an agent editing a file it never claimed.
 * Hash guards turn that from an invisible corruption into a named error.
 */
function verifyLease(store, input) {
  const state = store.read();
  const mine = state.leases.filter((item) => item.agent_id === input.agent_id && (!input.lease_id || item.id === input.lease_id));
  const guarded = mine.filter((item) => item.guards);

  const drift = guarded.flatMap((item) =>
    driftFor(item).map((entry) => ({ lease_id: item.id, ...entry })),
  );

  if (drift.length > 0 && !input.soft_fail) {
    throw busError("stale_read", `${drift.length} file(s) changed underneath your lease.`, {
      hint: "Someone edited paths you hold. Re-read them before writing, or your change will silently clobber theirs.",
      details: { drift, holder: input.agent_id },
    });
  }

  return { ok: true, verified: guarded.map((item) => item.id), drift, unguarded: mine.length - guarded.length, bus_seq: state.seq };
}

// ---------------------------------------------------------------------------
// Conflict rules
// ---------------------------------------------------------------------------

/** Readers coexist; anything involving a writer does not. */
export function conflictingModes(left, right) {
  return left === "write" || right === "write";
}

export function conflictsFor(state, paths, mode, agentId) {
  const conflicts = [];

  for (const held of state.leases) {
    if (held.agent_id === agentId) {
      continue;
    }
    if (!conflictingModes(held.mode ?? "write", mode)) {
      continue;
    }
    const overlap = held.paths.filter((heldPath) => paths.some((wanted) => pathsOverlap(wanted, heldPath)));
    if (overlap.length > 0) {
      conflicts.push({
        lease_id: held.id,
        agent_id: held.agent_id,
        mode: held.mode ?? "write",
        paths: overlap,
        expires_at: held.expires_at,
      });
    }
  }

  return conflicts;
}

/**
 * Wait-for cycle detection. Without this, two agents that each hold what the
 * other wants both sit in their queues until timeout and then both fail.
 */
function findDeadlock(state, agentId, blockedBy) {
  const waitingOn = new Map();
  for (const ticket of state.lease_queue ?? []) {
    const holders = conflictsFor(state, ticket.paths, ticket.mode, ticket.agent_id).map((item) => item.agent_id);
    waitingOn.set(ticket.agent_id, [...new Set([...(waitingOn.get(ticket.agent_id) ?? []), ...holders])]);
  }
  waitingOn.set(agentId, [...new Set(blockedBy)]);

  const seen = new Set();
  const trail = [];

  const walk = (current) => {
    if (trail.includes(current)) {
      return [...trail.slice(trail.indexOf(current)), current];
    }
    if (seen.has(current)) {
      return null;
    }
    seen.add(current);
    trail.push(current);
    for (const next of waitingOn.get(current) ?? []) {
      const cycle = walk(next);
      if (cycle) {
        return cycle;
      }
    }
    trail.pop();
    return null;
  };

  return walk(agentId);
}

function conflictError(result, paths, mode, waitedMs = 0) {
  if (result.deadlock) {
    return busError("deadlock", `Deadlock: ${result.deadlock.join(" -> ")} are each waiting on files the next one holds.`, {
      hint: "Release what you hold, then re-acquire every path you need in one call. Acquiring all paths at once cannot deadlock.",
      details: { cycle: result.deadlock, requested: paths },
    });
  }

  return busError("lease_conflict", `${describeMode(mode)} on ${paths.join(", ")} is blocked by ${result.conflicts.map((item) => item.agent_id).join(", ")}.`, {
    hint:
      waitedMs > 0
        ? "The holders did not release in time. Retry with a longer wait_ms, or work on different paths."
        : "Pass wait_ms to queue for it instead of failing, or take mode:\"read\" if you only need to read.",
    details: { requested: paths, mode, conflicts: result.conflicts, waited_ms: waitedMs },
  });
}

function describeMode(mode) {
  return mode === "read" ? "A read lease" : "A write lease";
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function upsertTicket(state, { ticketId, agent_id, paths, mode }) {
  state.lease_queue ??= [];
  const existing = ticketId ? state.lease_queue.find((ticket) => ticket.id === ticketId) : null;
  if (existing) {
    existing.last_seen_at = timestamp();
    return existing;
  }

  const ticket = {
    id: nextId(state, "wait"),
    agent_id,
    paths,
    mode,
    queued_at: timestamp(),
    last_seen_at: timestamp(),
  };
  state.lease_queue.push(ticket);
  return ticket;
}

function dropTicket(state, ticketId) {
  if (!ticketId) {
    return;
  }
  state.lease_queue = (state.lease_queue ?? []).filter((ticket) => ticket.id !== ticketId);
}

function dropTicketsFor(state, agentId) {
  state.lease_queue = (state.lease_queue ?? []).filter((ticket) => ticket.agent_id !== agentId);
}

/** Called when a task finishes, so its leases never outlive the work. */
export function releaseLeasesForTask(state, taskId, agentId) {
  const released = state.leases.filter((item) => item.task_id === taskId);
  if (released.length === 0) {
    return [];
  }
  state.leases = state.leases.filter((item) => !released.includes(item));
  for (const item of released) {
    emit(state, "lease.released", {
      actor: agentId ?? item.agent_id,
      ref: item.id,
      data: { paths: item.paths, reason: `task ${taskId} finished` },
    });
  }
  return released.map((item) => item.id);
}

// ---------------------------------------------------------------------------
// Paths and hashes
// ---------------------------------------------------------------------------

export function normalizePaths(paths) {
  const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
  return [...new Set(list.map((item) => String(item).trim().replace(/\/+$/, "")).filter(Boolean))];
}

export function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function hashPaths(paths, root) {
  const guards = {};
  for (const target of paths) {
    guards[target] = hashOf(path.isAbsolute(target) ? target : path.join(root, target));
  }
  return guards;
}

function hashOf(absolute) {
  try {
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      // Directory guards track the shape of the tree, not every byte in it.
      const entries = fs.readdirSync(absolute).sort().join("\n");
      return `dir:${createHash("sha256").update(entries).digest("hex").slice(0, 16)}`;
    }
    return `file:${createHash("sha256").update(fs.readFileSync(absolute)).digest("hex").slice(0, 16)}`;
  } catch {
    return "absent";
  }
}

function driftFor(item) {
  const changed = [];
  for (const [target, expected] of Object.entries(item.guards ?? {})) {
    const absolute = path.isAbsolute(target) ? target : path.join(item.root ?? process.cwd(), target);
    const actual = hashOf(absolute);
    if (actual !== expected) {
      changed.push({ path: target, expected, actual });
    }
  }
  return changed;
}
