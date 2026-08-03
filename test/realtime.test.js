import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startPump } from "../src/pump.js";
import { createSession } from "../src/session.js";
import { createMemoryStore, createStore } from "../src/store.js";
import { callTool } from "../src/tools.js";

function tempBus() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibebus-test-"));
  const env = { VIBEBUS_STATE: path.join(dir, "state.json") };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a sleeping agent wakes the moment another process rings it", async () => {
  const bus = tempBus();
  // Two independent stores over one state file stand in for two CLI processes.
  const sleeperStore = createStore({ env: bus.env });
  const wakerStore = createStore({ env: bus.env });

  try {
    await callTool(sleeperStore, "register_agent", { agent_id: "sleeper", cli: "claude", role: "worker" });
    await callTool(wakerStore, "register_agent", { agent_id: "waker", cli: "codex", role: "lead" });

    const startedAt = Date.now();
    const parked = callTool(sleeperStore, "sleep_agent", { agent_id: "sleeper", block_ms: 10_000 });

    // Let the sleeper actually park before ringing it.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await callTool(wakerStore, "wake_agent", { from: "waker", to: "sleeper", reason: "tests are red", urgency: "high" });

    const result = await parked;
    const elapsed = Date.now() - startedAt;

    assert.equal(result.outcome, "woken");
    assert.equal(result.woken_by, "waker");
    assert.equal(result.wake_reason, "tests are red");
    assert.equal(result.unread_messages.length, 1, "the woken agent should be handed the reason it was woken");
    assert.ok(elapsed < 4000, `wake should propagate quickly, took ${elapsed}ms`);
  } finally {
    sleeperStore.close();
    wakerStore.close();
    bus.cleanup();
  }
});

test("wake escalation is planned from presence and reachability", async () => {
  const store = createMemoryStore();

  await callTool(store, "register_agent", { agent_id: "lead", cli: "codex", role: "lead" });
  await callTool(store, "register_agent", { agent_id: "worker", cli: "claude", role: "worker" });

  // Force the worker to look long gone.
  store.update((state) => {
    state.agents.worker.last_seen_at = new Date(Date.now() - 60 * 60_000).toISOString();
    return true;
  });

  const wake = await callTool(store, "wake_agent", { from: "lead", to: "worker", reason: "come back", urgency: "urgent" });

  assert.equal(wake.presence, "offline");
  assert.ok(wake.plan.includes("bus"), "bus tier is always attempted");
  assert.ok(wake.plan.includes("process"), "an offline agent with a wake_command should escalate to process respawn");
  assert.equal(wake.wake.status, "pending");
});

test("ask_agent raises a diagnosable no_reply instead of pretending silence is agreement", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "asker", cli: "codex", role: "lead" });
  await callTool(store, "register_agent", { agent_id: "mute", cli: "gemini", role: "worker" });

  await assert.rejects(
    () => callTool(store, "ask_agent", { from: "asker", to: "mute", question: "ship it?", timeout_ms: 1200 }),
    (error) => {
      assert.equal(error.code, "no_reply");
      assert.equal(error.status, 504);
      assert.ok(error.hint, "a failure must say what to do next");
      assert.equal(error.details.target.agent_id, "mute");
      assert.ok(error.details.recovery.length > 0);
      return true;
    },
  );
});

test("ask_agent resolves as soon as the other side answers", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "asker", cli: "codex", role: "lead" });
  await callTool(store, "register_agent", { agent_id: "answerer", cli: "claude", role: "worker" });

  const pending = callTool(store, "ask_agent", { from: "asker", to: "answerer", question: "which db?", timeout_ms: 8000 });

  await new Promise((resolve) => setTimeout(resolve, 80));
  const open = await callTool(store, "list_asks", { agent_id: "answerer", status: "pending" });
  assert.equal(open.asks.length, 1);

  await callTool(store, "reply_to_ask", { agent_id: "answerer", ask_id: open.asks[0].id, answer: "sqlite" });

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.answer, "sqlite");
  assert.equal(result.answered_by, "answerer");
});

test("ping_agent reports unreachable rather than hanging", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "prober", cli: "codex", role: "lead" });
  await callTool(store, "register_agent", { agent_id: "ghost", cli: "claude", role: "worker" });

  await assert.rejects(
    () => callTool(store, "ping_agent", { from: "prober", to: "ghost", timeout_ms: 800 }),
    (error) => {
      assert.equal(error.code, "agent_unreachable");
      assert.match(error.details.meaning, /bus itself is fine/i);
      return true;
    },
  );

  const soft = await callTool(store, "ping_agent", { from: "prober", to: "ghost", timeout_ms: 600, soft_fail: true });
  assert.equal(soft.alive, false);
});

test("a live session answers pings by itself, proving reachability without a model call", async () => {
  const store = createMemoryStore();
  const sent = [];
  const session = createSession({ send: (message) => sent.push(message) });
  session.initialize({ capabilities: {}, clientInfo: { name: "test-client", version: "1" } });

  await callTool(store, "register_agent", { agent_id: "prober", cli: "codex", role: "lead" });
  await callTool(store, "register_agent", { agent_id: "live", cli: "claude", role: "worker" }, { session });

  const pump = startPump({ store, session, env: {} });

  try {
    const result = await callTool(store, "ping_agent", { from: "prober", to: "live", timeout_ms: 5000 });
    assert.equal(result.alive, true);
    assert.equal(result.answered_by, "live");
    assert.ok(result.latency_ms < 5000);
  } finally {
    pump.stop();
  }
});

test("subscribed clients get pushed resource updates and log lines", async () => {
  const store = createMemoryStore();
  const sent = [];
  const session = createSession({ send: (message) => sent.push(message) });
  session.initialize({ capabilities: {}, clientInfo: { name: "test-client", version: "1" } });
  session.subscribe("vibebus://status");

  await callTool(store, "register_agent", { agent_id: "watcher", cli: "claude", role: "worker" }, { session });
  await callTool(store, "register_agent", { agent_id: "other", cli: "codex", role: "lead" });

  const pump = startPump({ store, session, env: {} });

  try {
    await callTool(store, "send_message", { from: "other", to: "watcher", message: "look alive" });
    await pump.tick();

    const updates = sent.filter((message) => message.method === "notifications/resources/updated");
    const logs = sent.filter((message) => message.method === "notifications/message");

    assert.ok(updates.some((message) => message.params.uri === "vibebus://status"), "status resource should be pushed");
    assert.ok(logs.length > 0, "bus activity should stream to the client as log notifications");
  } finally {
    pump.stop();
  }
});

test("leases stop two agents editing the same paths", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "a", cli: "codex", role: "impl" });
  await callTool(store, "register_agent", { agent_id: "b", cli: "claude", role: "impl" });

  await callTool(store, "lease", { action: "acquire", agent_id: "a", paths: ["src/core"], reason: "refactor" });

  await assert.rejects(
    () => callTool(store, "lease", { action: "acquire", agent_id: "b", paths: ["src/core/store.js"] }),
    (error) => {
      assert.equal(error.code, "lease_conflict");
      assert.equal(error.details.conflicts[0].agent_id, "a");
      return true;
    },
  );

  await callTool(store, "lease", { action: "release", agent_id: "a" });
  const after = await callTool(store, "lease", { action: "acquire", agent_id: "b", paths: ["src/core/store.js"] });
  assert.equal(after.ok, true);
});

test("shared context refuses to clobber a concurrent write", async () => {
  const store = createMemoryStore();
  await callTool(store, "context", { action: "set", agent_id: "a", key: "db", value: { engine: "sqlite" } });

  await assert.rejects(
    () => callTool(store, "context", { action: "set", agent_id: "b", key: "db", value: { engine: "postgres" }, if_version: 5 }),
    (error) => {
      assert.equal(error.code, "context_conflict");
      assert.equal(error.details.current.value.engine, "sqlite");
      return true;
    },
  );

  const ok = await callTool(store, "context", { action: "set", agent_id: "b", key: "db", value: { engine: "postgres" }, if_version: 1 });
  assert.equal(ok.entry.version, 2);
});

test("finishing a task unblocks and wakes whatever depended on it", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "a", cli: "codex", role: "impl" });
  await callTool(store, "register_agent", { agent_id: "b", cli: "claude", role: "review" });

  const first = await callTool(store, "create_task", { from: "a", title: "write it", assignee: "a" });
  const second = await callTool(store, "create_task", {
    from: "a",
    title: "review it",
    assignee: "b",
    depends_on: [first.task.id],
  });
  assert.equal(second.task.status, "blocked");

  const done = await callTool(store, "update_task", { agent_id: "a", task_id: first.task.id, status: "done" });
  assert.deepEqual(done.unblocked, [second.task.id]);

  const tasks = await callTool(store, "list_tasks", { assignee: "b" });
  assert.equal(tasks.tasks[0].status, "claimed");
});

test("unacknowledged handoffs surface as dead letters instead of vanishing", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "a", cli: "codex", role: "lead" });
  await callTool(store, "register_agent", { agent_id: "b", cli: "claude", role: "impl" });

  const handoff = await callTool(store, "handoff_task", { from: "a", to: "b", title: "take this over" });

  // Age the message past the acknowledgement deadline.
  store.update((state) => {
    const message = state.messages.find((item) => item.id === handoff.message.id);
    message.created_at = new Date(Date.now() - 30 * 60_000).toISOString();
    return true;
  });
  store.update(() => true);

  const status = await callTool(store, "team_status", {});
  assert.equal(status.dead_letters.length, 1);
  assert.deepEqual(status.dead_letters[0].pending, ["b"]);

  await callTool(store, "ack_message", { agent_id: "b", message_id: handoff.message.id });
  const cleared = await callTool(store, "team_status", {});
  assert.equal(cleared.dead_letters.length, 0);
});

test("wait_for_messages returns on real traffic rather than a fixed poll tick", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "listener", cli: "claude", role: "worker" });
  await callTool(store, "register_agent", { agent_id: "talker", cli: "codex", role: "lead" });

  const waiting = callTool(store, "wait_for_messages", { agent_id: "listener", unread_only: true, timeout_ms: 8000 });
  setTimeout(() => {
    callTool(store, "send_message", { from: "talker", to: "listener", message: "go" });
  }, 100);

  const result = await waiting;
  assert.equal(result.timed_out, false);
  assert.equal(result.messages[0].message, "go");
});

test("state survives a corrupt file instead of taking every agent down", async () => {
  const bus = tempBus();
  const store = createStore({ env: bus.env });

  try {
    await callTool(store, "register_agent", { agent_id: "a", cli: "codex", role: "lead" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(bus.env.VIBEBUS_STATE, "{ this is not json");

    const recovered = store.read();
    assert.equal(typeof recovered.seq, "number");
    assert.deepEqual(recovered.agents, {});

    const again = await callTool(store, "register_agent", { agent_id: "b", cli: "claude", role: "impl" });
    assert.equal(again.ok, true);
  } finally {
    store.close();
    bus.cleanup();
  }
});
