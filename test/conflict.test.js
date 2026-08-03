import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { guardWake } from "../src/agents.js";
import { createMemoryStore } from "../src/store.js";
import { buildWakePrompt } from "../src/terminal.js";
import { callTool } from "../src/tools.js";

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibebus-conflict-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function twoAgents(store) {
  await callTool(store, "register_agent", { agent_id: "a", cli: "codex", role: "impl" });
  await callTool(store, "register_agent", { agent_id: "b", cli: "claude", role: "impl" });
}

test("read leases share, write leases are exclusive", async () => {
  const store = createMemoryStore();
  await twoAgents(store);

  await callTool(store, "lease", { action: "acquire", agent_id: "a", paths: ["src/core"], mode: "read" });
  const second = await callTool(store, "lease", { action: "acquire", agent_id: "b", paths: ["src/core"], mode: "read" });
  assert.equal(second.ok, true, "two readers must be able to hold the same path");

  await assert.rejects(
    () => callTool(store, "lease", { action: "acquire", agent_id: "b", paths: ["src/core/store.js"], mode: "write" }),
    (error) => {
      assert.equal(error.code, "lease_conflict");
      assert.equal(error.details.conflicts[0].agent_id, "a");
      return true;
    },
  );
});

test("a queued lease is granted the moment the holder releases", async () => {
  const store = createMemoryStore();
  await twoAgents(store);

  await callTool(store, "lease", { action: "acquire", agent_id: "a", paths: ["src/api"] });

  const queued = callTool(store, "lease", { action: "acquire", agent_id: "b", paths: ["src/api"], wait_ms: 5000 });
  setTimeout(() => callTool(store, "lease", { action: "release", agent_id: "a" }), 80);

  const granted = await queued;
  assert.equal(granted.ok, true);
  assert.equal(granted.lease.agent_id, "b");
  assert.ok(granted.waited_ms > 0, "it should report that it actually waited");
});

test("a wait-for cycle is reported as a deadlock instead of two timeouts", async () => {
  const store = createMemoryStore();
  await twoAgents(store);

  await callTool(store, "lease", { action: "acquire", agent_id: "a", paths: ["src/one"] });
  await callTool(store, "lease", { action: "acquire", agent_id: "b", paths: ["src/two"] });

  // b queues for what a holds...
  const bWaits = callTool(store, "lease", { action: "acquire", agent_id: "b", paths: ["src/one"], wait_ms: 3000 }).catch(
    (error) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 60));

  // ...and now a asks for what b holds, closing the cycle.
  const aResult = await callTool(store, "lease", { action: "acquire", agent_id: "a", paths: ["src/two"], wait_ms: 3000 }).catch(
    (error) => error,
  );

  assert.equal(aResult.code, "deadlock", `expected a deadlock, got ${aResult.code ?? aResult.ok}`);
  assert.ok(aResult.details.cycle.length >= 2);
  assert.match(aResult.hint, /re-acquire every path you need in one call/);

  await callTool(store, "lease", { action: "release", agent_id: "a" });
  await bWaits;
});

test("guarded leases detect an edit made behind your back", async () => {
  const bus = scratch();
  const store = createMemoryStore();
  await twoAgents(store);

  const target = path.join(bus.dir, "app.js");
  writeFileSync(target, "original");

  try {
    await callTool(store, "lease", { action: "acquire", agent_id: "a", paths: [target], guard: true });

    const clean = await callTool(store, "lease", { action: "verify", agent_id: "a" });
    assert.equal(clean.drift.length, 0);

    // Someone edits it without holding the lease.
    writeFileSync(target, "clobbered");

    await assert.rejects(
      () => callTool(store, "lease", { action: "verify", agent_id: "a" }),
      (error) => {
        assert.equal(error.code, "stale_read");
        assert.equal(error.details.drift[0].path, target);
        return true;
      },
    );
  } finally {
    bus.cleanup();
  }
});

test("finishing a task releases the leases it was holding", async () => {
  const store = createMemoryStore();
  await twoAgents(store);

  const task = await callTool(store, "create_task", { from: "a", title: "refactor", assignee: "a" });
  await callTool(store, "lease", { action: "acquire", agent_id: "a", paths: ["src/thing"], task_id: task.task.id });

  const done = await callTool(store, "update_task", { agent_id: "a", task_id: task.task.id, status: "done" });
  assert.equal(done.released_leases.length, 1);

  const after = await callTool(store, "lease", { action: "acquire", agent_id: "b", paths: ["src/thing"] });
  assert.equal(after.ok, true, "the path must be free once the task that held it finished");
});

test("the shared cache lets one agent read what another produced", async () => {
  const bus = scratch();
  const store = createMemoryStore();
  await twoAgents(store);
  const ctx = { env: { VIBEBUS_CACHE: bus.dir } };

  try {
    await callTool(
      store,
      "artifact",
      {
        action: "put",
        agent_id: "a",
        key: "task_000001/dashboard-research",
        kind: "research",
        summary: "12 regulator consoles, with citations",
        task_id: "task_000001",
        content: "# Findings\n\nReal consoles reviewed: ...",
      },
      ctx,
    );

    const index = await callTool(store, "artifact", { action: "list", task_id: "task_000001" }, ctx);
    assert.equal(index.artifacts.length, 1);
    assert.equal(index.artifacts[0].summary, "12 regulator consoles, with citations");
    assert.equal(index.artifacts[0].content, undefined, "listing must stay cheap and not inline content");

    const fetched = await callTool(store, "artifact", { action: "get", key: "task_000001/dashboard-research" }, ctx);
    assert.match(fetched.content, /Real consoles reviewed/);
    assert.equal(fetched.artifact.created_by, "a");

    // Content lives on disk, not in the state document every write rewrites.
    assert.match(readFileSync(fetched.artifact.path, "utf8"), /Findings/);

    await assert.rejects(
      () => callTool(store, "artifact", { action: "get", key: "task_000001/nope" }, ctx),
      (error) => error.code === "not_found" && Array.isArray(error.details.known_keys),
    );
  } finally {
    bus.cleanup();
  }
});

test("the wake guard refuses to bounce automatic wakes back and forth", () => {
  const now = new Date().toISOString();
  const state = { wakes: [{ from: "b", to: "a", created_at: now }] };

  const auto = guardWake(state, { from: "a", to: "b", trigger: "message", env: {} });
  assert.equal(auto.allowed, false);
  assert.equal(auto.reason, "loop");

  // A human asking for a wake explicitly is still allowed.
  const manual = guardWake(state, { from: "a", to: "b", trigger: "wake_agent", env: {} });
  assert.equal(manual.allowed, true);
});

test("the wake guard caps how many wakes an hour can contain", () => {
  const now = Date.now();
  const state = { wakes: Array.from({ length: 5 }, () => ({ from: "x", to: "y", created_at: new Date(now).toISOString() })) };

  const blocked = guardWake(state, { from: "a", to: "b", trigger: "wake_agent", env: { VIBEBUS_MAX_WAKES_PER_HOUR: "5" } });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "budget");
});

test("a task wake arrives as a full brief, not a notification", () => {
  const prompt = buildWakePrompt({
    agentId: "codex-main",
    from: "claude-regos",
    urgency: "urgent",
    kind: "task",
    payload: { task: { id: "task_000015", title: "Cited dashboard research", description: "Find real regulator consoles.", files: ["a.js"] } },
  });

  assert.match(prompt, /task_000015: Cited dashboard research/);
  assert.match(prompt, /Find real regulator consoles/);
  assert.match(prompt, /claim_task\(agent_id:"codex-main", task_id:"task_000015"\)/);
  assert.match(prompt, /artifact\(action:"put"/, "the brief should tell it where to save reusable work");
  assert.match(prompt, /Do not wait for me to prompt you/);
});

test("a question wake tells the agent exactly how to unblock the asker", () => {
  const prompt = buildWakePrompt({
    agentId: "codex-main",
    from: "claude-regos",
    urgency: "high",
    kind: "ask",
    askId: "ask_000004",
    reason: "Is the migration reversible?",
  });

  assert.match(prompt, /BLOCKED waiting on your answer/);
  assert.match(prompt, /reply_to_ask\(agent_id:"codex-main", ask_id:"ask_000004"/);
});
