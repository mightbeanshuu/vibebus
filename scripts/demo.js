#!/usr/bin/env node

/**
 * A self-contained tour of what the bus does, on a throwaway state file.
 *
 * Everything here is the real implementation — the same store, the same lock,
 * the same event journal, the same tools an MCP client calls. The only thing
 * simulated is the agents themselves: instead of four CLIs, a small responder
 * answers on their behalf so the demo runs anywhere in a few seconds without
 * API keys. Every number printed is measured during the run, not baked in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../src/store.js";
import { callTool } from "../src/tools.js";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `[${code}m${text}[0m` : text);
const dim = (t) => paint("2", t);
const bold = (t) => paint("1", t);
const cyan = (t) => paint("36", t);
const green = (t) => paint("32", t);
const yellow = (t) => paint("33", t);
const red = (t) => paint("31", t);

const dir = mkdtempSync(path.join(os.tmpdir(), "vibebus-demo-"));
const store = createStore({ env: { VIBEBUS_STATE: path.join(dir, "state.json"), VIBEBUS_CACHE: path.join(dir, "cache") } });
const ctx = { env: { VIBEBUS_ALLOW_EXEC: "1", VIBEBUS_CACHE: path.join(dir, "cache") } };

const call = (name, input) => callTool(store, name, input, ctx);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let step = 0;
function scene(title, why) {
  step += 1;
  process.stdout.write(`\n${bold(`${step}. ${title}`)}\n${dim(`   ${why}`)}\n\n`);
}
const line = (text) => process.stdout.write(`   ${text}\n`);

async function main() {
  process.stdout.write(`\n${bold("Vibe Bus")} ${dim("— live demo on a throwaway bus")}\n`);
  process.stdout.write(dim(`   state: ${store.path}\n`));
  process.stdout.write(dim("   Agents are simulated; the bus, lock, journal, and tools are the real thing.\n"));

  // ---------------------------------------------------------------- agents
  scene("Four agents from four vendors join", "Each CLI runs its own MCP server process against one shared state file.");

  const roster = [
    ["claude-impl", "claude", "anthropic", "implementer"],
    ["codex-review", "codex", "openai", "reviewer"],
    ["gemini-scout", "gemini", "google", "reviewer"],
    ["grok-qa", "grok", "xai", "reviewer"],
  ];
  for (const [agent_id, cli, provider, role] of roster) {
    await call("register_agent", { agent_id, cli, provider, role, capabilities: ["can_edit_files"] });
  }
  const board = await call("who", {});
  for (const agent of board.agents) {
    line(`${cyan(agent.agent_id.padEnd(14))} ${agent.provider.padEnd(10)} ${agent.role.padEnd(12)} ${green(agent.presence)}`);
  }

  // ------------------------------------------------------------------ wake
  scene("An idle agent is woken", "The bus is push-based: a parked agent resumes on the next write, not on a poll tick.");

  const parked = call("sleep_agent", { agent_id: "codex-review", reason: "nothing to do", block_ms: 15_000 });
  await wait(120);

  const wokeAt = Date.now();
  await call("wake_agent", { from: "claude-impl", to: "codex-review", reason: "auth patch needs review", urgency: "high" });
  const resumed = await parked;
  const latency = Date.now() - wokeAt;

  line(`${green("woken")} by ${resumed.woken_by} in ${bold(`${latency}ms`)} — ${dim(resumed.wake_reason)}`);
  line(dim(`it resumed holding ${resumed.unread_messages.length} unread message(s), so it knows why it woke`));

  // ------------------------------------------------------------------- ask
  scene("Silence is never mistaken for agreement", "A question that nobody answers fails loudly, with diagnostics.");

  try {
    await call("ask_agent", { from: "claude-impl", to: "grok-qa", question: "Is the migration reversible?", timeout_ms: 1200 });
    line(red("BUG: that should not have succeeded"));
  } catch (error) {
    line(`${red(error.code)} (${error.status}) — ${error.message}`);
    line(dim(`hint: ${error.hint}`));
  }

  const answering = call("ask_agent", { from: "claude-impl", to: "codex-review", question: "Is the migration reversible?", timeout_ms: 8000 });
  await respondOnce("codex-review", "Yes — the down migration is tested.");
  const answered = await answering;
  line(`${green("answered")} by ${answered.answered_by} in ${answered.latency_ms}ms: ${answered.answer}`);

  // ---------------------------------------------------------------- quorum
  scene("Three vendors are asked the same question", "Disagreement is reported, not averaged away.");

  const quorum = call("ask_quorum", {
    from: "claude-impl",
    question: "How should we handle concurrent writes?",
    role: "reviewer",
    n: 3,
    timeout_ms: 8000,
  });
  await respondAll({
    "codex-review": "Use row-level locking.",
    "gemini-scout": "use row level locking",
    "grok-qa": "Use optimistic concurrency instead.",
  });
  const verdict = await quorum;

  line(`verdict: ${bold(verdict.verdict)}`);
  line(`agreement: ${Math.round(verdict.agreement * 100)}% across providers ${verdict.providers.join(", ")}`);
  for (const d of verdict.dissent) {
    line(`${yellow("dissent")} ${d.agent_id} (${d.provider}): ${d.answer}`);
  }

  // --------------------------------------------------------------- leases
  scene("Two agents cannot edit the same file", "Read leases share; write leases are exclusive; cycles are caught.");

  await call("lease", { action: "acquire", agent_id: "claude-impl", paths: ["src/auth"], mode: "write", reason: "refactor" });
  line(`${green("held")} claude-impl holds src/auth (write)`);

  try {
    await call("lease", { action: "acquire", agent_id: "codex-review", paths: ["src/auth/session.js"], mode: "write" });
  } catch (error) {
    line(`${red(error.code)} — ${error.message}`);
  }

  const shared = await call("lease", { action: "acquire", agent_id: "gemini-scout", paths: ["docs"], mode: "read" });
  const alsoShared = await call("lease", { action: "acquire", agent_id: "grok-qa", paths: ["docs"], mode: "read" });
  line(`${green("shared")} two readers both hold docs (${shared.lease.id}, ${alsoShared.lease.id})`);

  await call("lease", { action: "acquire", agent_id: "codex-review", paths: ["src/api"], mode: "write" });
  const queued = call("lease", { action: "acquire", agent_id: "gemini-scout", paths: ["src/api"], wait_ms: 4000 }).catch((e) => e);
  await wait(80);
  try {
    await call("lease", { action: "acquire", agent_id: "codex-review", paths: ["docs"], mode: "write", wait_ms: 4000 });
  } catch (error) {
    line(`${red(error.code)} — ${error.message}`);
    line(dim(`hint: ${error.hint}`));
  }
  await call("lease", { action: "release", agent_id: "codex-review" });
  await queued;

  // -------------------------------------------------------------- artifacts
  scene("Work is cached so nobody redoes it", "Research lands in a shared cache other CLIs read instead of repeating.");

  await call("artifact", {
    action: "put",
    agent_id: "gemini-scout",
    key: "auth/locking-research",
    kind: "research",
    summary: "6 approaches compared, with benchmarks",
    content: "# Concurrent write strategies\n\nRow-level locking wins for our access pattern because ...",
  });
  const index = await call("artifact", { action: "list", kind: "research" });
  for (const entry of index.artifacts) {
    line(`${cyan(entry.key)} ${dim(`${entry.kind}, ${entry.bytes}B by ${entry.created_by}`)} — ${entry.summary}`);
  }
  line(dim("another agent now reads this instead of re-running the research"));

  // ------------------------------------------------------------------ flow
  scene("A flow runs on whoever is alive", "Steps target roles, not agents. The reviewer must be a different vendor.");

  const run = await call("start_flow", {
    from: "claude-impl",
    inputs: { feature: "OAuth device flow" },
    root: {
      id: "root",
      type: "sequence",
      steps: [
        { id: "build", type: "task", role: "implementer", input: { instructions: "Implement ${inputs.feature}" } },
        { id: "tests", type: "exec", input: { command: "echo '3 passed'" } },
        {
          id: "gate",
          type: "decide",
          branches: [
            {
              when: '${steps.build.output.verdict} == "ok"',
              then: {
                id: "review",
                type: "task",
                role: "reviewer",
                // Resolved against whoever actually claimed `build`.
                exclude_provider: ["${steps.build.claim.provider}"],
                input: { diff: "${steps.build.output.diff}" },
              },
            },
          ],
          else: { id: "rework", type: "task", role: "implementer", input: {} },
        },
      ],
    },
  });

  const assignment = await call("advance_flow", { run_id: run.run.id, agent_id: "claude-impl" });
  line(`${cyan("claude-impl")} claimed ${bold(assignment.assignment.step_id)}: ${assignment.assignment.input.instructions}`);
  await call("report_step", {
    run_id: run.run.id,
    step_id: "build",
    agent_id: "claude-impl",
    status: "done",
    output: { verdict: "ok", diff: "+++ oauth.js" },
  });

  const tests = await call("advance_flow", { run_id: run.run.id, agent_id: "codex-review" }, ctx);
  line(`${dim("engine ran")} ${bold("tests")} → exit ${tests.executed.output.exit_code}, ${tests.executed.output.stdout_tail.trim()}`);

  const decided = await call("advance_flow", { run_id: run.run.id, agent_id: "codex-review" }, ctx);
  line(`${dim("engine ran")} ${bold("gate")} → chose ${green(decided.executed.output.chosen)}`);

  const blocked = await call("advance_flow", { run_id: run.run.id, agent_id: "claude-impl" }, ctx);
  line(`${yellow("claude-impl refused the review")} — ${dim("same vendor as the implementer")}`);
  void blocked;

  const review = await call("advance_flow", { run_id: run.run.id, agent_id: "codex-review" }, ctx);
  line(`${cyan("codex-review")} (openai) claimed ${bold(review.assignment.step_id)} — a different vendor than the implementer`);
  const finished = await call("report_step", {
    run_id: run.run.id,
    step_id: "review",
    agent_id: "codex-review",
    status: "done",
    output: { verdict: "approve" },
  });
  line(`run ${green(finished.run.status)} — ${finished.run.progress.done}/${finished.run.progress.total} steps`);

  // ----------------------------------------------------------------- journal
  scene("Everything above is one ordered journal", "Cursor-based, so any process can replay exactly what it missed.");

  const events = await call("tail_events", { since_seq: 0, limit: 500 });
  const counts = events.events.reduce((acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }), {});
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  line(`${events.events.length} events at seq ${events.bus_seq}`);
  line(top.map(([type, n]) => `${type}×${n}`).join("  "));

  process.stdout.write(`\n${bold("Try it for real")}\n`);
  process.stdout.write(dim("   claude mcp add vibebus -- node " + path.resolve("bin/vibebus-mcp.js") + "\n"));
  process.stdout.write(dim("   vibebus watch     # live journal    vibebus doctor    # is it working?\n\n"));
}

/** Stand-in for a CLI answering through its own session. */
async function respondOnce(agentId, answer) {
  for (let i = 0; i < 60; i++) {
    const open = await call("list_asks", { agent_id: agentId, status: "pending" });
    const ask = open.asks.find((item) => item.to === agentId && item.mode !== "ping");
    if (ask) {
      await call("reply_to_ask", { agent_id: agentId, ask_id: ask.id, answer });
      return;
    }
    await wait(25);
  }
}

async function respondAll(answers) {
  const pending = new Set(Object.keys(answers));
  for (let i = 0; i < 120 && pending.size > 0; i++) {
    const open = await call("list_asks", { status: "pending" });
    for (const ask of open.asks) {
      if (pending.has(ask.to) && ask.mode !== "ping") {
        await call("reply_to_ask", { agent_id: ask.to, ask_id: ask.id, answer: answers[ask.to] });
        pending.delete(ask.to);
      }
    }
    await wait(25);
  }
}

main()
  .catch((error) => {
    process.stderr.write(`\n${red("demo failed")}: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
