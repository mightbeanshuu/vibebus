import assert from "node:assert/strict";
import test from "node:test";

import { compileFlow, evaluateCondition, resolveTemplates } from "../src/flow-compile.js";
import { createMemoryStore } from "../src/store.js";
import { callTool } from "../src/tools.js";

const SHIP_IT = {
  id: "root",
  type: "sequence",
  steps: [
    {
      id: "implement",
      type: "task",
      role: "implementer",
      input: { instructions: "Implement ${inputs.feature}" },
      output_schema: ["verdict", "diff"],
    },
    {
      id: "tests",
      type: "exec",
      input: { command: "echo passing" },
    },
    {
      id: "gate",
      type: "decide",
      branches: [
        {
          when: '${steps.implement.output.verdict} == "ok"',
          then: { id: "review", type: "task", role: "reviewer", input: { diff: "${steps.implement.output.diff}" } },
        },
      ],
      else: { id: "rework", type: "task", role: "implementer", input: {} },
    },
  ],
};

test("compiling rejects cycles, duplicate ids, and unknown step types", () => {
  assert.throws(
    () => compileFlow({ id: "a", type: "sequence", steps: [{ id: "a", type: "task" }] }),
    (error) => error.code === "invalid_flow" && /Duplicate step id/.test(error.message),
  );

  assert.throws(
    () => compileFlow({ id: "root", type: "sequence", steps: [{ id: "x", type: "teleport" }] }),
    (error) => error.code === "invalid_flow" && /Unknown step type/.test(error.message),
  );

  const steps = compileFlow(SHIP_IT);
  assert.equal(steps.implement.depends_on.length, 1);
  assert.deepEqual(steps.tests.depends_on, ["implement"]);
  assert.equal(steps.review.branch_of, "gate");
});

test("templates resolve by path only and never execute code", () => {
  const scope = { inputs: { feature: "csv export" }, steps: { a: { output: { list: [1, 2] } } } };

  assert.equal(resolveTemplates("build ${inputs.feature}", scope), "build csv export");
  assert.deepEqual(resolveTemplates("${steps.a.output.list}", scope), [1, 2]);
  assert.equal(evaluateCondition('${inputs.feature} == "csv export"', scope), true);
  assert.equal(evaluateCondition('${inputs.feature} contains "csv"', scope), true);

  assert.throws(
    () => resolveTemplates("${steps.missing.output.x}", scope, { stepId: "s" }),
    (error) => error.code === "template_error",
  );
});

test("a flow runs across agents, executes engine steps, and branches", async () => {
  const store = createMemoryStore();
  const ctx = { env: { VIBEBUS_ALLOW_EXEC: "1" } };

  await callTool(store, "register_agent", { agent_id: "codex-main", cli: "codex", role: "implementer" });
  await callTool(store, "register_agent", { agent_id: "claude-review", cli: "claude", role: "reviewer" });

  const defined = await callTool(store, "define_flow", { from: "codex-main", name: "ship it", root: SHIP_IT });
  const run = await callTool(store, "start_flow", {
    from: "codex-main",
    flow_id: defined.flow.id,
    inputs: { feature: "csv export" },
  });

  // The implementer picks up the first step.
  const assignment = await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "codex-main" }, ctx);
  assert.equal(assignment.assignment.step_id, "implement");
  assert.equal(assignment.assignment.input.instructions, "Implement csv export");

  // A reviewer cannot steal a step scoped to another role.
  const blocked = await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "claude-review" }, ctx);
  assert.equal(blocked.claimed_nothing, true);

  await callTool(store, "report_step", {
    run_id: run.run.id,
    step_id: "implement",
    agent_id: "codex-main",
    status: "done",
    output: { verdict: "ok", diff: "+++ csv" },
  });

  // exec is engine-driven: whoever advances next runs it.
  const executed = await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "claude-review" }, ctx);
  assert.equal(executed.executed.step_id, "tests");
  assert.equal(executed.executed.output.exit_code, 0);
  assert.match(executed.executed.output.stdout_tail, /passing/);

  // decide is engine-driven too, and picks the matching branch.
  const decided = await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "claude-review" }, ctx);
  assert.equal(decided.executed.step_id, "gate");
  assert.equal(decided.executed.output.chosen, "review");

  const reviewWork = await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "claude-review" }, ctx);
  assert.equal(reviewWork.assignment.step_id, "review");
  assert.equal(reviewWork.assignment.input.diff, "+++ csv");

  const finished = await callTool(store, "report_step", {
    run_id: run.run.id,
    step_id: "review",
    agent_id: "claude-review",
    status: "done",
    output: { verdict: "approve" },
  });

  assert.equal(finished.run.status, "done");

  const status = await callTool(store, "flow_status", { run_id: run.run.id });
  assert.equal(status.health, "done");
  assert.equal(status.steps.find((step) => step.id === "rework").status, "skipped");
});

test("a completed step keeps its claim so later steps can route around that vendor", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "anthropic-impl", cli: "claude", role: "implementer" });
  await callTool(store, "register_agent", { agent_id: "openai-review", cli: "codex", role: "reviewer" });
  await callTool(store, "register_agent", { agent_id: "anthropic-review", cli: "claude", role: "reviewer" });

  const run = await callTool(store, "start_flow", {
    from: "anthropic-impl",
    root: {
      id: "root",
      type: "sequence",
      steps: [
        { id: "build", type: "task", role: "implementer", input: {} },
        {
          id: "review",
          type: "task",
          role: "reviewer",
          exclude_provider: ["${steps.build.claim.provider}"],
          input: {},
        },
      ],
    },
  });

  await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "anthropic-impl" });
  await callTool(store, "report_step", {
    run_id: run.run.id,
    step_id: "build",
    agent_id: "anthropic-impl",
    status: "done",
    output: { verdict: "ok" },
  });

  // The reviewer on the same provider as the implementer must be turned away...
  const sameVendor = await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "anthropic-review" });
  assert.equal(sameVendor.claimed_nothing, true, "a same-vendor reviewer must not be able to claim the review");

  // ...while a different vendor gets it.
  const otherVendor = await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "openai-review" });
  assert.equal(otherVendor.assignment.step_id, "review");
});

test("exec steps stay off unless explicitly enabled", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "a", cli: "codex", role: "impl" });

  const run = await callTool(store, "start_flow", {
    from: "a",
    root: { id: "root", type: "sequence", steps: [{ id: "danger", type: "exec", input: { command: "echo nope" } }] },
  });

  const result = await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "a" }, { env: {} });
  assert.equal(result.executed.ok, false);
  assert.match(result.executed.error, /VIBEBUS_ALLOW_EXEC/);
});

test("a step cannot be reported by an agent that does not hold the claim", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "a", cli: "codex", role: "impl" });
  await callTool(store, "register_agent", { agent_id: "b", cli: "claude", role: "impl" });

  const run = await callTool(store, "start_flow", {
    from: "a",
    root: { id: "root", type: "sequence", steps: [{ id: "work", type: "task", role: "impl", input: {} }] },
  });

  await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "a" });

  await assert.rejects(
    () => callTool(store, "report_step", { run_id: run.run.id, step_id: "work", agent_id: "b", status: "done" }),
    (error) => error.code === "step_conflict",
  );
});

test("a dead claimant's step returns to the pool instead of stalling the run", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "a", cli: "codex", role: "impl" });

  const run = await callTool(store, "start_flow", {
    from: "a",
    root: { id: "root", type: "sequence", steps: [{ id: "work", type: "task", role: "impl", input: {} }] },
  });

  await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "a" });

  // Simulate the claiming process dying: its lease goes unrenewed.
  store.update((state) => {
    const target = state.flow_runs.find((item) => item.id === run.run.id);
    target.steps.work.claim.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    return true;
  });
  store.update(() => true);

  const status = await callTool(store, "flow_status", { run_id: run.run.id });
  const step = status.steps.find((item) => item.id === "work");
  assert.equal(step.status, "pending", "an expired claim must be reclaimable");
  assert.equal(step.claim, null);

  const reclaimed = await callTool(store, "advance_flow", { run_id: run.run.id, agent_id: "a" });
  assert.equal(reclaimed.assignment.step_id, "work");
});

test("a quorum refuses to call single-vendor sampling a consensus", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "lead", cli: "codex", role: "lead" });
  await callTool(store, "register_agent", { agent_id: "c1", cli: "claude", role: "panel" });
  await callTool(store, "register_agent", { agent_id: "c2", cli: "claude", role: "panel" });

  await assert.rejects(
    () => callTool(store, "ask_quorum", { from: "lead", question: "ship?", role: "panel", min_providers: 2 }),
    (error) => {
      assert.equal(error.code, "quorum_no_quorum");
      assert.match(error.hint, /single-vendor quorum/i);
      return true;
    },
  );
});

test("a cross-vendor quorum reports the verdict and preserves dissent", async () => {
  const store = createMemoryStore();
  await callTool(store, "register_agent", { agent_id: "lead", cli: "codex", role: "lead" });
  await callTool(store, "register_agent", { agent_id: "anthropic-1", cli: "claude", role: "panel" });
  await callTool(store, "register_agent", { agent_id: "google-1", cli: "gemini", role: "panel" });
  await callTool(store, "register_agent", { agent_id: "xai-1", cli: "grok", role: "panel" });

  const answers = {
    "anthropic-1": "Use row-level locking.",
    "google-1": "use row level locking",
    "xai-1": "Use optimistic concurrency instead.",
  };

  // Stand in for three CLIs answering through their own sessions.
  const responder = setInterval(() => {
    const pending = store.read().asks.filter((ask) => ask.status === "pending" && ask.mode !== "ping");
    for (const ask of pending) {
      callTool(store, "reply_to_ask", { agent_id: ask.to, ask_id: ask.id, answer: answers[ask.to] });
    }
  }, 20);

  try {
    const result = await callTool(store, "ask_quorum", {
      from: "lead",
      question: "How do we handle concurrent writes?",
      role: "panel",
      n: 3,
      timeout_ms: 5000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.providers.length, 3, "the panel should span three providers");
    assert.match(result.verdict, /row-level locking/i);
    assert.ok(result.agreement > 0.5 && result.agreement < 1, "two of three agreeing is partial agreement");
    assert.equal(result.dissent.length, 1);
    assert.match(result.dissent[0].answer, /optimistic/i, "the dissenting position is preserved verbatim");
  } finally {
    clearInterval(responder);
  }
});
