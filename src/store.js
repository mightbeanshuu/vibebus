import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emit } from "./events.js";
import { createFileWatcher, createMemoryWatcher } from "./watcher.js";

export const STATE_VERSION = 2;

const DEFAULT_STATE = {
  version: STATE_VERSION,
  nextId: 1,
  seq: 0,
  agents: {},
  messages: [],
  tasks: [],
  decisions: [],
  reads: {},
  events: [],
  leases: [],
  asks: [],
  approvals: [],
  wakes: [],
  flows: {},
  flow_runs: [],
  lease_queue: [],
  artifacts: {},
  channels: {},
  context: {},
  swept_at: null,
};

const DEFAULT_LIMITS = {
  messages: 800,
  events: 3000,
  decisions: 400,
  tasks: 600,
  asks: 200,
  wakes: 200,
  flow_runs: 150,
};

export function createStore(options = {}) {
  const env = options.env ?? process.env;
  const root = env.VIBEBUS_HOME || env.CLI_TEAM_MCP_HOME || path.join(os.homedir(), ".vibebus");
  const statePath = env.VIBEBUS_STATE || env.CLI_TEAM_MCP_STATE || path.join(root, "state.json");
  const seqPath = `${statePath}.seq`;
  const lockPath = `${statePath}.lock`;
  const limits = resolveLimits(env);

  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  const watcher = createFileWatcher({
    statePath,
    seqPath,
    pollMs: intOr(env.VIBEBUS_POLL_MS, 500),
  });

  return {
    path: statePath,
    seqPath,
    limits,
    read() {
      return readState(statePath);
    },
    update(mutator) {
      return withLock(lockPath, () => {
        const state = readState(statePath);
        const result = mutator(state);
        sweep(state, limits);
        writeState(statePath, seqPath, state);
        watcher.touch(state.seq ?? 0);
        return result;
      });
    },
    seq() {
      return watcher.current();
    },
    onChange(listener) {
      return watcher.onChange(listener);
    },
    waitForChange(sinceSeq, timeoutMs) {
      return watcher.waitForChange(sinceSeq, timeoutMs);
    },
    close() {
      watcher.close();
    },
  };
}

export function createMemoryStore(initial = {}) {
  let state = normalizeState({ ...structuredClone(DEFAULT_STATE), ...initial });
  const watcher = createMemoryWatcher();
  const limits = { ...DEFAULT_LIMITS };

  return {
    path: "memory",
    seqPath: "memory",
    limits,
    read() {
      return structuredClone(state);
    },
    update(mutator) {
      const next = structuredClone(state);
      const result = mutator(next);
      sweep(next, limits);
      state = normalizeState(next);
      watcher.touch(state.seq ?? 0);
      return result;
    },
    seq() {
      return state.seq ?? 0;
    },
    onChange(listener) {
      return watcher.onChange(listener);
    },
    waitForChange(sinceSeq, timeoutMs) {
      return watcher.waitForChange(sinceSeq, timeoutMs);
    },
    close() {
      watcher.close();
    },
  };
}

export function nextId(state, prefix) {
  const value = state.nextId++;
  return `${prefix}_${String(value).padStart(6, "0")}`;
}

/**
 * Housekeeping that runs inside every write, while the lock is held:
 * expire leases, time out stale asks/approvals, and cap unbounded collections.
 */
export function sweep(state, limits = DEFAULT_LIMITS) {
  const now = Date.now();
  state.swept_at = new Date(now).toISOString();

  expireLeases(state, now);
  expireAsks(state, now);
  expireApprovals(state, now);
  expireWakes(state, now);
  expireFlowClaims(state, now);
  deadLetter(state, now);
  trim(state, limits);
}

/**
 * A flow step whose claimant died must return to the pool, or the run stalls
 * forever waiting on a process that is never coming back.
 */
function expireFlowClaims(state, now) {
  for (const run of state.flow_runs ?? []) {
    if (["done", "failed", "cancelled"].includes(run.status)) {
      continue;
    }
    for (const step of Object.values(run.steps ?? {})) {
      if (step.status !== "claimed" || !step.claim?.lease_expires_at) {
        continue;
      }
      if (Date.parse(step.claim.lease_expires_at) > now) {
        continue;
      }

      const attempts = (step.retry_count ?? 0) + 1;
      const maxAttempts = step.spec?.retry?.max_attempts ?? 3;
      step.retry_count = attempts;
      step.status = attempts >= maxAttempts ? "failed" : "pending";
      step.error = step.status === "failed" ? "claimant died and retries were exhausted" : null;
      const owner = step.claim.agent_id;
      step.claim = null;

      emit(state, "flow.step.reclaimed", {
        actor: "vibebus",
        ref: run.id,
        data: { step_id: step.id, was: owner, attempt: attempts, status: step.status },
      });
    }
  }
}

const ACK_DEADLINE_MS = 10 * 60_000;

/**
 * A required-ack message nobody ever acknowledged is the quietest way for
 * coordination to fail, so unacknowledged messages are promoted to visible
 * dead letters instead of aging out silently.
 */
function deadLetter(state, now) {
  for (const message of state.messages ?? []) {
    if (!message.requires_ack || message.dead_lettered) {
      continue;
    }
    if (now - Date.parse(message.created_at ?? 0) < ACK_DEADLINE_MS) {
      continue;
    }

    const pending = (message.recipients ?? []).filter((agentId) => !message.acks?.[agentId]);
    if (pending.length === 0) {
      continue;
    }

    message.dead_lettered = true;
    message.dead_lettered_at = new Date(now).toISOString();
    emit(state, "message.dead_letter", {
      actor: message.from,
      audience: [message.from, ...pending],
      ref: message.id,
      data: { pending, topic: message.topic ?? null, preview: String(message.message ?? "").slice(0, 160) },
    });
  }
}

function expireWakes(state, now) {
  for (const wake of state.wakes ?? []) {
    if (wake.status === "acknowledged" || wake.status === "expired") {
      continue;
    }
    if (!wake.expires_at || Date.parse(wake.expires_at) > now) {
      continue;
    }
    wake.status = "expired";
    wake.resolved_at = new Date(now).toISOString();
  }
}

function expireLeases(state, now) {
  const live = [];
  for (const lease of state.leases ?? []) {
    if (Date.parse(lease.expires_at) > now) {
      live.push(lease);
      continue;
    }
    emit(state, "lease.expired", {
      actor: lease.agent_id,
      ref: lease.id,
      data: { paths: lease.paths, reason: lease.reason ?? null },
    });
  }
  state.leases = live;
}

function expireAsks(state, now) {
  for (const ask of state.asks ?? []) {
    if (ask.status !== "pending" && ask.status !== "servicing") {
      continue;
    }
    if (!ask.expires_at || Date.parse(ask.expires_at) > now) {
      continue;
    }
    ask.status = "expired";
    ask.resolved_at = new Date(now).toISOString();
    emit(state, "ask.expired", {
      actor: ask.to,
      audience: [ask.from, ask.to],
      ref: ask.id,
      data: { question: ask.question },
    });
  }
}

function expireApprovals(state, now) {
  for (const approval of state.approvals ?? []) {
    if (approval.status !== "pending") {
      continue;
    }
    if (!approval.expires_at || Date.parse(approval.expires_at) > now) {
      continue;
    }
    approval.status = "expired";
    approval.resolved_at = new Date(now).toISOString();
    emit(state, "approval.resolved", {
      actor: approval.to,
      audience: [approval.from, approval.to],
      ref: approval.id,
      data: { action: "expired" },
    });
  }
}

function trim(state, limits) {
  let dropped = 0;

  if (state.messages.length > limits.messages) {
    dropped += state.messages.length - limits.messages;
    state.messages = state.messages.slice(-limits.messages);
  }
  if (state.decisions.length > limits.decisions) {
    dropped += state.decisions.length - limits.decisions;
    state.decisions = state.decisions.slice(-limits.decisions);
  }
  if (state.asks.length > limits.asks) {
    const open = state.asks.filter((ask) => ask.status === "pending" || ask.status === "servicing");
    const closed = state.asks.filter((ask) => ask.status !== "pending" && ask.status !== "servicing");
    const keepClosed = closed.slice(-Math.max(0, limits.asks - open.length));
    dropped += closed.length - keepClosed.length;
    state.asks = [...keepClosed, ...open].sort((left, right) => compareIdSuffix(left.id, right.id));
  }
  if (state.wakes.length > limits.wakes) {
    const open = state.wakes.filter((wake) => wake.status === "pending" || wake.status === "delivered");
    const closed = state.wakes.filter((wake) => wake.status !== "pending" && wake.status !== "delivered");
    const keepClosed = closed.slice(-Math.max(0, limits.wakes - open.length));
    dropped += closed.length - keepClosed.length;
    state.wakes = [...keepClosed, ...open].sort((left, right) => compareIdSuffix(left.id, right.id));
  }
  if (state.flow_runs.length > limits.flow_runs) {
    const live = state.flow_runs.filter((run) => !["done", "failed", "cancelled"].includes(run.status));
    const finished = state.flow_runs.filter((run) => ["done", "failed", "cancelled"].includes(run.status));
    const keep = finished.slice(-Math.max(0, limits.flow_runs - live.length));
    dropped += finished.length - keep.length;
    state.flow_runs = [...keep, ...live].sort((left, right) => compareIdSuffix(left.id, right.id));
  }
  if (state.tasks.length > limits.tasks) {
    const live = state.tasks.filter((task) => ["open", "claimed", "blocked"].includes(task.status));
    const finished = state.tasks.filter((task) => !["open", "claimed", "blocked"].includes(task.status));
    const keepFinished = finished.slice(-Math.max(0, limits.tasks - live.length));
    dropped += finished.length - keepFinished.length;
    state.tasks = [...keepFinished, ...live].sort((left, right) => compareIdSuffix(left.id, right.id));
  }

  // Events last, so a compaction notice survives its own trim.
  if (state.events.length > limits.events) {
    dropped += state.events.length - limits.events;
    state.events = state.events.slice(-limits.events);
  }

  if (dropped > 0) {
    emit(state, "bus.compacted", { data: { dropped } });
    if (state.events.length > limits.events) {
      state.events = state.events.slice(-limits.events);
    }
  }
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) {
    return structuredClone(DEFAULT_STATE);
  }

  const raw = fs.readFileSync(statePath, "utf8");
  if (!raw.trim()) {
    return structuredClone(DEFAULT_STATE);
  }

  try {
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    // A half-written or hand-edited state file should degrade, not crash every
    // agent on the machine. Keep the corrupt copy for forensics.
    const quarantine = `${statePath}.corrupt.${Date.now()}`;
    try {
      fs.copyFileSync(statePath, quarantine);
    } catch {
      // best effort
    }
    const fresh = structuredClone(DEFAULT_STATE);
    emit(fresh, "bus.compacted", {
      data: { recovered_from: quarantine, error: error.message },
    });
    return fresh;
  }
}

function writeState(statePath, seqPath, state) {
  const normalized = normalizeState(state);
  const temp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.renameSync(temp, statePath);

  // Sidecar so watchers can answer "anything new?" without parsing the document.
  try {
    fs.writeFileSync(seqPath, `${normalized.seq ?? 0}\n`);
  } catch {
    // watchers fall back to reading state.json
  }
}

function normalizeState(state) {
  const base = structuredClone(DEFAULT_STATE);
  const merged = {
    ...base,
    ...state,
    version: STATE_VERSION,
    seq: Number.isFinite(state.seq) ? state.seq : 0,
    agents: state.agents ?? {},
    messages: state.messages ?? [],
    tasks: state.tasks ?? [],
    decisions: state.decisions ?? [],
    reads: state.reads ?? {},
    events: state.events ?? [],
    leases: state.leases ?? [],
    asks: state.asks ?? [],
    approvals: state.approvals ?? [],
    wakes: state.wakes ?? [],
    flows: state.flows ?? {},
    flow_runs: state.flow_runs ?? [],
    lease_queue: state.lease_queue ?? [],
    artifacts: state.artifacts ?? {},
    channels: state.channels ?? {},
    context: state.context ?? {},
  };

  // v1 rows predate several fields; fill them in so callers can rely on shape.
  for (const task of merged.tasks) {
    task.notes ??= [];
    task.files ??= [];
    task.depends_on ??= [];
  }

  return merged;
}

function resolveLimits(env) {
  return {
    messages: intOr(env.VIBEBUS_MAX_MESSAGES, DEFAULT_LIMITS.messages),
    events: intOr(env.VIBEBUS_MAX_EVENTS, DEFAULT_LIMITS.events),
    decisions: intOr(env.VIBEBUS_MAX_DECISIONS, DEFAULT_LIMITS.decisions),
    tasks: intOr(env.VIBEBUS_MAX_TASKS, DEFAULT_LIMITS.tasks),
    asks: intOr(env.VIBEBUS_MAX_ASKS, DEFAULT_LIMITS.asks),
    wakes: intOr(env.VIBEBUS_MAX_WAKES, DEFAULT_LIMITS.wakes),
    flow_runs: intOr(env.VIBEBUS_MAX_FLOW_RUNS, DEFAULT_LIMITS.flow_runs),
  };
}

function intOr(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function compareIdSuffix(left, right) {
  return Number(String(left).split("_").at(-1)) - Number(String(right).split("_").at(-1));
}

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10000;

function withLock(lockPath, fn) {
  const start = Date.now();
  const ownerPath = path.join(lockPath, "owner.json");

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      if (isStaleLock(lockPath, ownerPath)) {
        // A crashed agent must not wedge every other agent on the machine.
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function isStaleLock(lockPath, ownerPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.pid && owner.pid !== process.pid && !isProcessAlive(owner.pid)) {
      return true;
    }
    return Date.now() - owner.at > LOCK_STALE_MS;
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
