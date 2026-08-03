import { maybeAutoWake } from "./agents.js";
import { busError, requireAgent } from "./errors.js";
import { emit } from "./events.js";
import { emitMessage, makeMessage } from "./messaging.js";
import { describeAgent } from "./presence.js";
import { nextId } from "./store.js";
import { clampMs, normalizeLimit, note, requireRecipient, requireString, timestamp, touchAgent } from "./shared.js";

const TERMINAL = ["done", "cancelled"];

export function createTask(store, input) {
  requireString(input, "from");
  requireString(input, "title");

  return store.update((state) => {
    const now = timestamp();
    const dependsOn = input.depends_on ?? [];
    const blocked = dependsOn.some((id) => !isFinished(state, id));

    const task = {
      id: nextId(state, "task"),
      title: input.title,
      description: input.description ?? "",
      status: blocked ? "blocked" : input.assignee ? "claimed" : "open",
      priority: input.priority ?? "normal",
      creator: input.from,
      assignee: input.assignee ?? null,
      files: input.files ?? [],
      depends_on: dependsOn,
      notes: blocked ? [note(input.from, `blocked on ${dependsOn.join(", ")}`)] : [],
      created_at: now,
      updated_at: now,
    };
    state.tasks.push(task);

    emit(state, "task.created", {
      actor: input.from,
      ref: task.id,
      data: { title: task.title, status: task.status, assignee: task.assignee, priority: task.priority },
    });

    touchAgent(state, input.from);
    const wakes = task.assignee
      ? maybeAutoWake(state, {
          from: input.from,
          to: task.assignee,
          priority: task.priority,
          reason: `assigned task ${task.id}: ${task.title}`,
          trigger: "create_task",
        })
      : [];

    return { ok: true, task, woke: wakes.map((wake) => wake.to), bus_seq: state.seq };
  });
}

export function handoffTask(store, input) {
  requireString(input, "from");
  requireRecipient(input, "to");
  requireString(input, "title");

  return store.update((state) => {
    const now = timestamp();
    const recipients = Array.isArray(input.to) ? input.to : [input.to];
    for (const recipient of recipients) {
      if (recipient !== "*") {
        requireAgent(state, recipient, "handoff target");
      }
    }

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
      depends_on: input.depends_on ?? [],
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

    emit(state, "task.created", {
      actor: input.from,
      audience: [input.from, ...recipients],
      ref: task.id,
      data: { title: task.title, handoff: true, assignee: firstAssignee },
    });
    emitMessage(state, message);

    touchAgent(state, input.from);
    const wakes = maybeAutoWake(state, {
      from: input.from,
      to: message.recipients,
      priority: task.priority === "normal" ? "high" : task.priority,
      reason: `handoff ${task.id}: ${task.title}`,
      trigger: "handoff_task",
    });

    return {
      ok: true,
      task,
      message,
      pending_ack: message.recipients.filter((id) => !message.acks?.[id]),
      woke: wakes.map((wake) => wake.to),
      bus_seq: state.seq,
    };
  });
}

export function listTasks(store, input = {}) {
  const state = store.read();
  const limit = normalizeLimit(input.limit);
  const tasks = state.tasks
    .filter((task) => !input.status || task.status === input.status)
    .filter((task) => !input.assignee || task.assignee === input.assignee)
    .slice(-limit);

  return { ok: true, tasks, bus_seq: state.seq };
}

export function claimTask(store, input) {
  requireString(input, "agent_id");
  requireString(input, "task_id");

  return store.update((state) => {
    const task = findTask(state, input.task_id);
    if (!["open", "blocked"].includes(task.status) && task.assignee && task.assignee !== input.agent_id) {
      throw busError("task_conflict", `Task ${input.task_id} is already ${task.status} by ${task.assignee}.`, {
        hint: "Pick another open task, or ask the current owner to hand it over with update_task(assignee:…).",
        details: { task_id: task.id, status: task.status, assignee: task.assignee },
      });
    }

    task.status = "claimed";
    task.assignee = input.agent_id;
    task.updated_at = timestamp();
    task.notes.push(note(input.agent_id, "claimed"));

    emit(state, "task.claimed", {
      actor: input.agent_id,
      ref: task.id,
      data: { title: task.title, creator: task.creator },
    });

    touchAgent(state, input.agent_id);
    return { ok: true, task, bus_seq: state.seq };
  });
}

export function updateTask(store, input) {
  requireString(input, "agent_id");
  requireString(input, "task_id");

  return store.update((state) => {
    const task = findTask(state, input.task_id);
    const before = task.status;

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

    emit(state, "task.updated", {
      actor: input.agent_id,
      ref: task.id,
      data: { from: before, to: task.status, note: input.note ?? null, assignee: task.assignee },
    });

    const unblocked = TERMINAL.includes(task.status) && !TERMINAL.includes(before) ? unblockDependents(state, task) : [];
    touchAgent(state, input.agent_id);

    const woke = [];
    if (input.assignee && input.assignee !== input.agent_id) {
      woke.push(
        ...maybeAutoWake(state, {
          from: input.agent_id,
          to: input.assignee,
          priority: task.priority,
          reason: `reassigned task ${task.id}: ${task.title}`,
          trigger: "update_task",
        }).map((wake) => wake.to),
      );
    }

    return { ok: true, task, unblocked, woke, bus_seq: state.seq };
  });
}

function unblockDependents(state, finished) {
  const unblocked = [];

  for (const task of state.tasks) {
    if (task.status !== "blocked" || !task.depends_on?.includes(finished.id)) {
      continue;
    }
    if (task.depends_on.some((id) => !isFinished(state, id))) {
      continue;
    }

    task.status = task.assignee ? "claimed" : "open";
    task.updated_at = timestamp();
    task.notes.push(note("vibebus", `unblocked by ${finished.id}`));
    unblocked.push(task.id);

    emit(state, "task.unblocked", {
      actor: "vibebus",
      audience: task.assignee ? [task.assignee, task.creator] : "*",
      ref: task.id,
      data: { by: finished.id, title: task.title, status: task.status },
    });

    if (task.assignee) {
      maybeAutoWake(state, {
        from: "vibebus",
        to: task.assignee,
        priority: task.priority === "low" ? "normal" : task.priority,
        reason: `task ${task.id} unblocked: ${task.title}`,
        trigger: "task.unblocked",
      });
    }
  }

  return unblocked;
}

export function recordDecision(store, input) {
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
      supersedes: input.supersedes ?? null,
      created_at: timestamp(),
    };
    state.decisions.push(decision);

    emit(state, "decision", {
      actor: input.from,
      ref: decision.id,
      data: { title: decision.title, decision: decision.decision },
    });

    touchAgent(state, input.from);
    return { ok: true, decision, bus_seq: state.seq };
  });
}

/**
 * Advisory file leases.
 *
 * Two agents editing the same file is the single most common way a multi-agent
 * session destroys its own work. A lease is a short, expiring claim other
 * agents can see before they start writing.
 */
export function lease(store, input) {
  requireString(input, "action");

  if (input.action === "list") {
    const state = store.read();
    return { ok: true, leases: state.leases, bus_seq: state.seq };
  }

  requireString(input, "agent_id");

  if (input.action === "acquire") {
    const paths = normalizePaths(input.paths);
    if (paths.length === 0) {
      throw busError("invalid_request", "paths is required to acquire a lease.");
    }
    const ttlMs = clampMs(input.ttl_ms, 15 * 60_000, 10_000, 4 * 60 * 60_000);

    return store.update((state) => {
      const conflicts = [];
      for (const held of state.leases) {
        if (held.agent_id === input.agent_id) {
          continue;
        }
        const overlap = held.paths.filter((heldPath) => paths.some((path) => pathsOverlap(path, heldPath)));
        if (overlap.length > 0) {
          conflicts.push({ lease_id: held.id, agent_id: held.agent_id, paths: overlap, expires_at: held.expires_at });
        }
      }

      if (conflicts.length > 0) {
        throw busError("lease_conflict", `Those paths are already leased by ${conflicts.map((c) => c.agent_id).join(", ")}.`, {
          hint: "Wait for the lease to expire, work on different files, or message the holder to release it.",
          details: { requested: paths, conflicts },
        });
      }

      const record = {
        id: nextId(state, "lease"),
        agent_id: input.agent_id,
        paths,
        reason: input.reason ?? null,
        task_id: input.task_id ?? null,
        acquired_at: timestamp(),
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
      };
      state.leases.push(record);

      emit(state, "lease.acquired", {
        actor: input.agent_id,
        ref: record.id,
        data: { paths, reason: record.reason, expires_at: record.expires_at },
      });

      touchAgent(state, input.agent_id);
      return { ok: true, lease: record, bus_seq: state.seq };
    });
  }

  if (input.action === "release") {
    return store.update((state) => {
      const before = state.leases.length;
      const released = state.leases.filter(
        (item) => item.agent_id === input.agent_id && (!input.lease_id || item.id === input.lease_id),
      );
      state.leases = state.leases.filter((item) => !released.includes(item));

      for (const item of released) {
        emit(state, "lease.released", { actor: input.agent_id, ref: item.id, data: { paths: item.paths } });
      }

      touchAgent(state, input.agent_id);
      return { ok: true, released: released.map((item) => item.id), remaining: state.leases.length, was: before, bus_seq: state.seq };
    });
  }

  throw busError("invalid_request", `Unknown lease action: ${input.action}`, {
    hint: "Use acquire, release, or list.",
  });
}

/**
 * Shared blackboard. Compare-and-set on `version` so two agents cannot silently
 * clobber each other's shared facts.
 */
export function context(store, input) {
  requireString(input, "action");
  const state0 = store.read();

  if (input.action === "get") {
    requireString(input, "key");
    const entry = state0.context[input.key];
    if (!entry) {
      throw busError("not_found", `No context entry for key: ${input.key}`, {
        hint: "Call context(action:\"list\") to see what the team has agreed on so far.",
        details: { known_keys: Object.keys(state0.context) },
      });
    }
    return { ok: true, entry, bus_seq: state0.seq };
  }

  if (input.action === "list") {
    return { ok: true, entries: Object.values(state0.context), bus_seq: state0.seq };
  }

  requireString(input, "agent_id");
  requireString(input, "key");

  if (input.action === "set") {
    return store.update((state) => {
      const existing = state.context[input.key];
      if (input.if_version !== undefined && existing && existing.version !== input.if_version) {
        throw busError("context_conflict", `Context key ${input.key} changed (expected v${input.if_version}, found v${existing.version}).`, {
          hint: "Re-read the key, merge your change, then set again with the new version.",
          details: { current: existing },
        });
      }

      const entry = {
        key: input.key,
        value: input.value ?? null,
        version: (existing?.version ?? 0) + 1,
        updated_by: input.agent_id,
        updated_at: timestamp(),
        note: input.note ?? existing?.note ?? null,
      };
      state.context[input.key] = entry;

      emit(state, "context.set", {
        actor: input.agent_id,
        ref: input.key,
        data: { version: entry.version, value: entry.value },
      });

      touchAgent(state, input.agent_id);
      return { ok: true, entry, bus_seq: state.seq };
    });
  }

  if (input.action === "delete") {
    return store.update((state) => {
      delete state.context[input.key];
      emit(state, "context.deleted", { actor: input.agent_id, ref: input.key, data: {} });
      touchAgent(state, input.agent_id);
      return { ok: true, deleted: input.key, bus_seq: state.seq };
    });
  }

  throw busError("invalid_request", `Unknown context action: ${input.action}`, {
    hint: "Use get, set, list, or delete.",
  });
}

export function teamStatus(store, input = {}) {
  const state = store.read();
  const limit = normalizeLimit(input.limit ?? 10);
  const now = Date.now();
  const agents = Object.values(state.agents).map((agent) => describeAgent(agent, now));

  return {
    ok: true,
    bus_seq: state.seq,
    state_path: store.path,
    agents,
    presence: agents.reduce((acc, agent) => {
      acc[agent.presence] = (acc[agent.presence] ?? 0) + 1;
      return acc;
    }, {}),
    open_tasks: state.tasks.filter((task) => ["open", "claimed", "blocked"].includes(task.status)),
    recent_messages: state.messages.slice(-limit),
    recent_decisions: state.decisions.slice(-limit),
    recent_events: state.events.slice(-limit),
    leases: state.leases,
    open_asks: state.asks.filter((ask) => ask.status === "pending" || ask.status === "servicing"),
    pending_wakes: state.wakes.filter((wake) => wake.status === "pending"),
    // Handoffs nobody ever acknowledged. These are the failures that would
    // otherwise look like success.
    dead_letters: state.messages
      .filter((message) => message.dead_lettered)
      .slice(-limit)
      .map((message) => ({
        id: message.id,
        from: message.from,
        pending: (message.recipients ?? []).filter((agentId) => !message.acks?.[agentId]),
        topic: message.topic,
        created_at: message.created_at,
        preview: String(message.message ?? "").slice(0, 120),
      })),
    context_keys: Object.keys(state.context),
  };
}

export function findTask(state, taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw busError("not_found", `Unknown task: ${taskId}`, {
      hint: "Call list_tasks to see current task ids.",
    });
  }
  return task;
}

function isFinished(state, taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  return !task || TERMINAL.includes(task.status);
}

function normalizePaths(paths) {
  const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
  return [...new Set(list.map((path) => String(path).trim().replace(/\/+$/, "")).filter(Boolean))];
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
