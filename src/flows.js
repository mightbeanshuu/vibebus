import { spawn } from "node:child_process";

import { createWake } from "./agents.js";
import { askAgent, requestApproval } from "./asks.js";
import { busError } from "./errors.js";
import { emit } from "./events.js";
import { CONTAINER_TYPES, compileFlow, evaluateCondition, resolveTemplates } from "./flow-compile.js";
import { planWake, presenceOf } from "./presence.js";
import { nextId } from "./store.js";
import { clampMs, normalizeLimit, requireString, timestamp } from "./shared.js";

const SETTLED = ["done", "skipped"];
const TERMINAL_RUN = ["done", "failed", "cancelled"];
const CLAIM_LEASE_MS = 90_000;
const ENGINE_TYPES = ["ask", "quorum", "debate", "approve", "exec", "wait_for", "decide"];

export function defineFlow(store, input) {
  requireString(input, "name");
  if (!input.root) {
    throw busError("invalid_flow", "define_flow needs a root step.");
  }

  // Compiling here is the validation: cycles and bad step types are rejected
  // now rather than halfway through a run.
  compileFlow(input.root, { maxSteps: input.max_steps ?? 500 });

  return store.update((state) => {
    const id = input.flow_id ?? nextId(state, "flow");
    const existing = state.flows[id];

    state.flows[id] = {
      id,
      name: input.name,
      version: (existing?.version ?? 0) + 1,
      root: input.root,
      input_schema: input.input_schema ?? [],
      max_steps: input.max_steps ?? 500,
      max_run_ms: input.max_run_ms ?? 6 * 60 * 60_000,
      created_by: input.from ?? "unknown",
      created_at: existing?.created_at ?? timestamp(),
    };

    emit(state, "flow.defined", {
      actor: input.from,
      ref: id,
      data: { name: input.name, version: state.flows[id].version },
    });

    return { ok: true, flow: state.flows[id], bus_seq: state.seq };
  });
}

export function startFlow(store, input) {
  requireString(input, "from");

  return store.update((state) => {
    const definition = input.flow_id ? state.flows[input.flow_id] : null;
    if (input.flow_id && !definition) {
      throw busError("flow_not_found", `Unknown flow: ${input.flow_id}`, {
        hint: "Call flow_status with no run_id to list defined flows.",
        details: { known: Object.keys(state.flows) },
      });
    }

    const root = definition?.root ?? input.root;
    if (!root) {
      throw busError("invalid_flow", "start_flow needs either flow_id or an inline root step.");
    }

    const maxSteps = definition?.max_steps ?? input.max_steps ?? 500;
    const steps = compileFlow(root, { maxSteps });

    const run = {
      id: nextId(state, "run"),
      flow_id: definition?.id ?? null,
      flow_name: definition?.name ?? input.name ?? "inline flow",
      flow_version: definition?.version ?? null,
      status: "running",
      blocked_on: null,
      blocked_reason: null,
      created_by: input.from,
      created_at: timestamp(),
      updated_at: timestamp(),
      inputs: input.inputs ?? {},
      max_steps: maxSteps,
      max_wake_tier: input.max_wake_tier ?? "process",
      steps,
      root_id: root.id,
    };

    state.flow_runs.push(run);
    settle(state, run);

    emit(state, "flow.run.started", {
      actor: input.from,
      ref: run.id,
      data: { flow: run.flow_name, steps: Object.keys(steps).length },
    });

    return { ok: true, run: summarize(run), bus_seq: state.seq };
  });
}

/**
 * The scheduler.
 *
 * There is no scheduler process — this function *is* the scheduler, and it runs
 * inside whichever agent happens to call it. It claims one runnable step, then
 * either executes it directly (for step types the bus can drive itself) or
 * hands it to the calling agent as an assignment.
 */
export async function advanceFlow(store, input, ctx = {}) {
  requireString(input, "run_id");
  requireString(input, "agent_id");

  const claimed = store.update((state) => {
    const run = findRun(state, input.run_id);
    if (TERMINAL_RUN.includes(run.status)) {
      return { finished: true, run };
    }

    settle(state, run);
    if (TERMINAL_RUN.includes(run.status)) {
      return { finished: true, run };
    }

    const runnable = runnableSteps(run);
    if (runnable.length === 0) {
      return { idle: true, run };
    }

    // Engine-driven steps are claimed by whoever gets here first; role-bearing
    // work goes to an agent that actually matches.
    const forEngine = runnable.find((step) => ENGINE_TYPES.includes(step.type));
    const forCaller = runnable.find((step) => step.type === "task" && agentMatches(state, input, step));

    const step = forEngine ?? forCaller;
    if (!step) {
      return { idle: true, run, unmatched: runnable.map((item) => item.id) };
    }

    step.status = "claimed";
    step.claim = {
      agent_id: input.agent_id,
      provider: state.agents[input.agent_id]?.provider ?? null,
      attempt: (step.retry_count ?? 0) + 1,
      leased_at: timestamp(),
      lease_expires_at: new Date(Date.now() + CLAIM_LEASE_MS).toISOString(),
      pid: process.pid,
    };
    run.updated_at = timestamp();

    emit(state, "flow.step.claimed", {
      actor: input.agent_id,
      ref: run.id,
      data: { step_id: step.id, type: step.type },
    });

    return { run, step, engine: ENGINE_TYPES.includes(step.type) };
  });

  if (claimed.finished) {
    return { ok: true, run: summarize(claimed.run), status: claimed.run.status, done: true };
  }

  if (claimed.idle) {
    return idleReport(store, claimed.run, claimed.unmatched);
  }

  if (!claimed.engine) {
    // A task step: the calling agent does the work and calls report_step.
    const scope = buildScope(store.read(), claimed.run);
    return {
      ok: true,
      assignment: {
        run_id: claimed.run.id,
        step_id: claimed.step.id,
        type: claimed.step.type,
        input: resolveTemplates(claimed.step.spec.input ?? {}, scope, { stepId: claimed.step.id }),
        output_schema: claimed.step.spec.output_schema ?? [],
        deadline_ms: claimed.step.spec.timeout_ms ?? null,
      },
      next: `Do the work, then call report_step(run_id:"${claimed.run.id}", step_id:"${claimed.step.id}", status:"done", output:{…}).`,
    };
  }

  // Engine-executed step: run it here, outside the lock, then record the result.
  const outcome = await executeStep(store, claimed.run, claimed.step, input, ctx);
  const reported = reportStep(store, {
    run_id: claimed.run.id,
    step_id: claimed.step.id,
    agent_id: input.agent_id,
    status: outcome.ok ? "done" : "failed",
    output: outcome.output ?? null,
    error: outcome.error ?? null,
  });

  return {
    ok: true,
    executed: { step_id: claimed.step.id, type: claimed.step.type, ...outcome },
    run: reported.run,
    status: reported.run.status,
  };
}

export function reportStep(store, input) {
  requireString(input, "run_id");
  requireString(input, "step_id");
  requireString(input, "agent_id");

  return store.update((state) => {
    const run = findRun(state, input.run_id);
    const step = run.steps[input.step_id];
    if (!step) {
      throw busError("not_found", `Run ${run.id} has no step ${input.step_id}.`);
    }
    if (step.status !== "claimed") {
      throw busError("step_conflict", `Step ${step.id} is ${step.status}, not claimed — nothing to report.`, {
        hint: "Your lease may have expired and been reclaimed. Call flow_status before reporting.",
        details: { status: step.status, claim: step.claim },
      });
    }
    if (step.claim?.agent_id !== input.agent_id) {
      throw busError("step_conflict", `Step ${step.id} is claimed by ${step.claim?.agent_id}, not ${input.agent_id}.`);
    }

    if (input.status === "failed") {
      step.retry_count = (step.retry_count ?? 0) + 1;
      const maxAttempts = step.spec.retry?.max_attempts ?? 1;
      step.error = input.error ?? "step failed";

      if (step.retry_count < maxAttempts) {
        step.status = "pending";
        step.claim = null;
      } else {
        step.status = "failed";
        step.claim = null;
      }
      emit(state, "flow.step.failed", {
        actor: input.agent_id,
        ref: run.id,
        data: { step_id: step.id, error: step.error, attempt: step.retry_count, will_retry: step.status === "pending" },
      });
    } else {
      step.status = "done";
      step.output = input.output ?? {};
      // The claim is kept, not cleared: later steps reference
      // ${steps.<id>.claim.provider} to route work away from the vendor that
      // did the previous step, and that has to survive completion.
      step.claim = { ...step.claim, completed_at: timestamp() };
      emit(state, "flow.step.done", {
        actor: input.agent_id,
        ref: run.id,
        data: { step_id: step.id, type: step.type },
      });
    }

    run.updated_at = timestamp();
    settle(state, run);

    return { ok: true, run: summarize(run), step, bus_seq: state.seq };
  });
}

export function flowStatus(store, input = {}) {
  const state = store.read();

  if (!input.run_id) {
    return {
      ok: true,
      flows: Object.values(state.flows).map((flow) => ({
        id: flow.id,
        name: flow.name,
        version: flow.version,
        steps: Object.keys(compileSafe(flow.root)).length,
      })),
      runs: state.flow_runs
        .filter((run) => !input.status_filter || run.status === input.status_filter)
        .slice(-normalizeLimit(input.limit, 20))
        .map(summarize),
      bus_seq: state.seq,
    };
  }

  const run = findRun(state, input.run_id);
  return {
    ok: true,
    run: summarize(run),
    health: healthOf(run),
    steps: Object.values(run.steps).map((step) => ({
      id: step.id,
      type: step.type,
      status: step.status,
      depends_on: step.depends_on,
      claim: step.claim,
      retry_count: step.retry_count,
      error: step.error,
      ...(input.verbose ? { output: step.output, spec: step.spec } : {}),
    })),
    bus_seq: state.seq,
  };
}

export function cancelFlow(store, input) {
  requireString(input, "run_id");
  requireString(input, "agent_id");

  return store.update((state) => {
    const run = findRun(state, input.run_id);
    run.status = "cancelled";
    run.blocked_reason = input.reason ?? "cancelled";
    run.updated_at = timestamp();

    for (const step of Object.values(run.steps)) {
      if (step.status === "claimed" || step.status === "pending") {
        step.status = "skipped";
        step.claim = null;
      }
    }

    emit(state, "flow.run.cancelled", {
      actor: input.agent_id,
      ref: run.id,
      data: { reason: run.blocked_reason },
    });

    return { ok: true, run: summarize(run), bus_seq: state.seq };
  });
}

/**
 * Cross-vendor quorum as a standalone call.
 *
 * One command makes agents on different model vendors answer the same question
 * and reconciles them, without any of them sharing credentials or a runtime —
 * each CLI spends its own model call through its own session.
 */
export async function askQuorum(store, input, ctx = {}) {
  requireString(input, "from");
  requireString(input, "question");

  const spec = {
    role: input.role,
    n: input.n ?? 3,
    min_providers: input.min_providers ?? 2,
    adjudicate: input.strategy ?? "majority",
    timeout_ms: input.timeout_ms,
    exclude_agent: [input.from],
    input: { question: input.question, context: input.context },
  };

  const result = await runQuorum(store, null, { id: "quorum" }, spec, { agent_id: input.from }, ctx);

  if (!result.ok) {
    if (input.soft_fail) {
      return { ok: false, reason: result.code ?? "no_reply", error: result.error, ...(result.output ?? {}) };
    }
    throw busError(result.code === "quorum_no_quorum" ? "quorum_no_quorum" : "no_reply", result.error, {
      hint:
        result.code === "quorum_no_quorum"
          ? "Register agents on more providers, or lower min_providers. A single-vendor quorum is repeated sampling, not consensus."
          : "Nobody on the panel answered. Check who and ping_agent.",
      details: result.output ?? {},
    });
  }

  return { ok: true, ...result.output };
}

/** Two agents from different vendors argue; a third adjudicates. */
export async function runDebate2(store, input, ctx = {}) {
  requireString(input, "from");
  requireString(input, "topic");

  const spec = {
    a_role: input.a_role,
    b_role: input.b_role,
    judge_role: input.judge_role,
    a_provider: input.a_provider,
    b_provider: input.b_provider,
    rounds: input.rounds ?? 2,
    timeout_ms: input.timeout_ms,
    input: { question: input.topic },
  };

  const result = await runDebate(store, null, { id: "debate" }, spec, { agent_id: input.from }, ctx);
  if (!result.ok) {
    if (input.soft_fail) {
      return { ok: false, error: result.error };
    }
    throw busError(result.code ?? "no_reply", result.error, {
      hint: "Debate needs two distinct reachable agents; call who to see who is online.",
    });
  }
  return { ok: true, ...result.output };
}

// ---------------------------------------------------------------------------
// Scheduling core
// ---------------------------------------------------------------------------

/** Drive containers, branches, and run completion to a fixpoint. */
function settle(state, run) {
  let changed = true;
  let guard = 0;

  while (changed && guard++ < 200) {
    changed = false;

    for (const step of Object.values(run.steps)) {
      if (!CONTAINER_TYPES.includes(step.type)) {
        continue;
      }

      if (step.status === "pending" && depsSatisfied(run, step) && branchAllowed(run, step)) {
        step.status = "open";
        changed = true;
      }

      if (step.status === "open") {
        const children = step.children.map((id) => run.steps[id]);
        if (children.some((child) => child.status === "failed")) {
          step.status = "failed";
          changed = true;
        } else if (children.length === 0 || children.every((child) => deepSettled(run, child))) {
          step.status = "done";
          const last = children.filter((child) => child.status === "done").at(-1);
          step.output = last?.output ?? null;
          changed = true;
        }
      }
    }

    // Branches the decide step did not choose never run.
    for (const step of Object.values(run.steps)) {
      if (step.branch_of && step.status === "pending") {
        const decider = run.steps[step.branch_of];
        if (decider?.status === "done" && decider.output?.chosen !== step.id) {
          step.status = "skipped";
          changed = true;
        }
      }
    }
  }

  const root = run.steps[run.root_id];
  if (!TERMINAL_RUN.includes(run.status)) {
    if (Object.values(run.steps).some((step) => step.status === "failed")) {
      run.status = "failed";
      run.blocked_reason = "a step failed after exhausting its retries";
      emit(state, "flow.run.finished", { ref: run.id, data: { status: "failed" } });
    } else if (root && deepSettled(run, root)) {
      run.status = "done";
      emit(state, "flow.run.finished", { ref: run.id, data: { status: "done" } });
    }
  }
}

/**
 * A decide step is "done" as soon as it has picked a branch, which is what lets
 * that branch start — but the work is not finished until the chosen branch is.
 * Container and run completion use this deeper notion so a flow can never
 * report success while the branch it selected is still pending.
 */
function deepSettled(run, step) {
  if (!step) {
    return true;
  }
  if (step.status === "skipped") {
    return true;
  }
  if (step.type === "decide") {
    if (step.status !== "done") {
      return false;
    }
    const chosen = step.output?.chosen ? run.steps[step.output.chosen] : null;
    return chosen ? deepSettled(run, chosen) : true;
  }
  return SETTLED.includes(step.status);
}

function runnableSteps(run) {
  return Object.values(run.steps).filter(
    (step) =>
      step.status === "pending" &&
      !CONTAINER_TYPES.includes(step.type) &&
      depsSatisfied(run, step) &&
      branchAllowed(run, step),
  );
}

function depsSatisfied(run, step) {
  return step.depends_on.every((id) => {
    const dependency = run.steps[id];
    if (!dependency) {
      return true;
    }
    if (CONTAINER_TYPES.includes(dependency.type)) {
      return dependency.status === "open" || dependency.status === "done";
    }
    return SETTLED.includes(dependency.status);
  });
}

function branchAllowed(run, step) {
  if (!step.branch_of) {
    return true;
  }
  const decider = run.steps[step.branch_of];
  return decider?.status === "done" && decider.output?.chosen === step.id;
}

function agentMatches(state, input, step) {
  const agent = state.agents[input.agent_id];
  if (!agent) {
    return false;
  }

  const spec = step.spec;
  const offered = [agent.role, ...(input.roles_offered ?? [])];
  if (spec.role && !offered.includes(spec.role)) {
    return false;
  }
  if (spec.requires?.length && !spec.requires.every((capability) => (agent.capabilities ?? []).includes(capability))) {
    return false;
  }
  if (spec.exclude_agent?.length && spec.exclude_agent.includes(agent.agent_id)) {
    return false;
  }

  const scope = buildScope(state, findRunByStep(state, step.id));
  const excluded = (spec.exclude_provider ?? []).map((value) => String(resolveTemplates(value, scope, { stepId: step.id })));
  return !excluded.includes(agent.provider);
}

function findRunByStep(state, stepId) {
  return state.flow_runs.find((run) => run.steps[stepId]);
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

async function executeStep(store, run, step, input, ctx) {
  const scope = buildScope(store.read(), run);
  const spec = resolveTemplates(step.spec, scope, { stepId: step.id });

  try {
    switch (step.type) {
      case "decide":
        return decideBranch(store, run, step, scope);
      case "ask":
        return await runAsk(store, run, step, spec, input, ctx);
      case "quorum":
        return await runQuorum(store, run, step, spec, input, ctx);
      case "debate":
        return await runDebate(store, run, step, spec, input, ctx);
      case "approve":
        return await runApprove(store, run, step, spec, input, ctx);
      case "exec":
        return await runExec(spec, ctx);
      case "wait_for":
        return await runWaitFor(store, run, step, spec);
      default:
        return { ok: false, error: `Step type ${step.type} is not engine-executable.` };
    }
  } catch (error) {
    return { ok: false, error: error.message, code: error.code ?? "internal" };
  }
}

function decideBranch(store, run, step, scope) {
  const branches = step.children.map((id) => ({ id, when: run.steps[id].when }));
  const chosen =
    branches.find((branch) => branch.when && evaluateCondition(branch.when, scope, { stepId: step.id })) ??
    branches.find((branch) => !branch.when);

  if (!chosen) {
    return { ok: false, error: "No branch matched and no else branch was defined." };
  }
  return { ok: true, output: { chosen: chosen.id } };
}

async function runAsk(store, run, step, spec, input, ctx) {
  const target = pickAgent(store.read(), spec, { exclude: [] });
  if (!target) {
    return unreachableRole(store, run, step, spec);
  }

  const result = await askAgent(
    store,
    {
      from: input.agent_id,
      to: target.agent_id,
      question: spec.input?.question ?? spec.question ?? "(no question provided)",
      context: spec.input?.context,
      timeout_ms: spec.timeout_ms ?? 120_000,
      soft_fail: true,
    },
    ctx,
  );

  return result.ok
    ? { ok: true, output: { answer: result.answer, by: target.agent_id, provider: target.provider } }
    : { ok: false, error: `no reply from ${target.agent_id}`, output: { target: result.target } };
}

/**
 * Cross-vendor deliberation.
 *
 * The point is not N answers — it is N answers from *different model vendors*,
 * with the disagreement preserved rather than averaged away.
 */
async function runQuorum(store, run, step, spec, input, ctx) {
  const state = store.read();
  const question = spec.input?.question ?? spec.question;
  const minProviders = spec.min_providers ?? 2;
  const panel = pickPanel(state, spec, spec.n ?? 3);

  const providers = new Set(panel.map((agent) => agent.provider).filter(Boolean));
  if (panel.length === 0 || providers.size < minProviders) {
    return {
      ok: false,
      code: "quorum_no_quorum",
      error: `Needed ${minProviders} distinct providers, found ${providers.size} (${[...providers].join(", ") || "none"}).`,
      output: { panel: panel.map((agent) => agent.agent_id) },
    };
  }

  const answers = await Promise.all(
    panel.map(async (agent) => {
      const result = await askAgent(
        store,
        {
          from: input.agent_id,
          to: agent.agent_id,
          question,
          context: spec.input?.context,
          timeout_ms: spec.timeout_ms ?? 120_000,
          soft_fail: true,
        },
        ctx,
      );
      return {
        agent_id: agent.agent_id,
        provider: agent.provider,
        model: agent.model ?? null,
        answered: Boolean(result.ok),
        answer: result.ok ? result.answer : null,
      };
    }),
  );

  const responded = answers.filter((entry) => entry.answered);
  if (responded.length === 0) {
    return { ok: false, error: "Nobody on the panel answered.", output: { responses: answers } };
  }

  const { verdict, agreement, dissent } = adjudicate(responded, spec.adjudicate ?? "majority");

  return {
    ok: true,
    output: {
      question,
      verdict,
      agreement,
      // Dissent is preserved verbatim: a quorum that hides disagreement is
      // worse than no quorum.
      dissent,
      responses: responded,
      unanswered: answers.filter((entry) => !entry.answered).map((entry) => entry.agent_id),
      providers: [...providers],
    },
  };
}

function adjudicate(responses, strategy) {
  if (strategy === "first_answer") {
    return { verdict: responses[0].answer, agreement: 1 / responses.length, dissent: responses.slice(1) };
  }

  // Free-text answers rarely match character for character, so agreement is
  // measured by token overlap. Deliberately lexical, not semantic: two correct
  // answers phrased very differently will read as disagreement, which is why
  // dissent is always returned verbatim for a human to judge.
  const clusters = [];
  for (const response of responses) {
    const tokens = tokenize(response.answer);
    const home = clusters.find((cluster) => jaccard(cluster.tokens, tokens) >= 0.5);
    if (home) {
      home.members.push(response);
    } else {
      clusters.push({ tokens, members: [response] });
    }
  }

  clusters.sort((left, right) => right.members.length - left.members.length);
  const winners = clusters[0].members;

  return {
    verdict: winners[0].answer,
    agreement: winners.length / responses.length,
    dissent: responses.filter((response) => !winners.includes(response)),
  };
}

const STOPWORDS = new Set(["a", "an", "the", "is", "are", "should", "use", "using", "we", "you", "to", "of", "for", "and", "or", "this", "that", "it"]);

function tokenize(answer) {
  return new Set(
    String(answer ?? "")
      .toLowerCase()
      // Punctuation becomes a separator, so "row-level" and "row level" agree.
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token && !STOPWORDS.has(token))
      .map((token) => (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token)),
  );
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}

async function runDebate(store, run, step, spec, input, ctx) {
  const state = store.read();
  const rounds = Math.min(spec.rounds ?? 2, 5);
  const a = pickAgent(state, { role: spec.a_role, prefer_provider: spec.a_provider }, { exclude: [] });
  const b = pickAgent(state, { role: spec.b_role, prefer_provider: spec.b_provider }, { exclude: a ? [a.agent_id] : [] });

  if (!a || !b) {
    return { ok: false, code: "role_unreachable", error: "Debate needs two distinct reachable agents." };
  }

  const transcript = [];
  let last = null;

  for (let round = 0; round < rounds; round++) {
    for (const speaker of [a, b]) {
      const prompt = [
        spec.input?.question ?? spec.question,
        last ? `\nYour opponent (${last.by}) argued:\n${last.text}\n\nRebut or refine. Be specific.` : "\nOpen with your position. Be specific.",
      ].join("\n");

      const result = await askAgent(
        store,
        { from: input.agent_id, to: speaker.agent_id, question: prompt, timeout_ms: spec.timeout_ms ?? 120_000, soft_fail: true },
        ctx,
      );
      if (!result.ok) {
        continue;
      }
      last = { by: speaker.agent_id, text: result.answer };
      transcript.push({ round: round + 1, by: speaker.agent_id, provider: speaker.provider, text: result.answer });
    }
  }

  if (transcript.length === 0) {
    return { ok: false, error: "Neither debater answered." };
  }

  let verdict = null;
  const judge = spec.judge_role ? pickAgent(state, { role: spec.judge_role }, { exclude: [a.agent_id, b.agent_id] }) : null;
  if (judge) {
    const judgement = await askAgent(
      store,
      {
        from: input.agent_id,
        to: judge.agent_id,
        question:
          `Two agents debated this question:\n${spec.input?.question ?? spec.question}\n\n` +
          `${transcript.map((entry) => `[round ${entry.round}] ${entry.by}: ${entry.text}`).join("\n\n")}\n\n` +
          "Which position is better supported, and why? Answer in a few sentences.",
        timeout_ms: spec.timeout_ms ?? 120_000,
        soft_fail: true,
      },
      ctx,
    );
    verdict = judgement.ok ? { by: judge.agent_id, provider: judge.provider, text: judgement.answer } : null;
  }

  return { ok: true, output: { transcript, verdict, debaters: [a.agent_id, b.agent_id] } };
}

async function runApprove(store, run, step, spec, input, ctx) {
  const target = spec.to ?? pickAgent(store.read(), spec, { exclude: [] })?.agent_id;
  if (!target) {
    return unreachableRole(store, run, step, spec);
  }

  const result = await requestApproval(
    store,
    {
      from: input.agent_id,
      to: target,
      question: spec.input?.message ?? spec.message ?? "Approve?",
      options: spec.options,
      detail: spec.input?.detail,
      timeout_ms: spec.timeout_ms ?? 180_000,
      soft_fail: true,
    },
    ctx,
  );

  if (!result.ok) {
    if (spec.on_timeout === "default" && spec.default_decision) {
      return { ok: true, output: { decision: spec.default_decision, by: "default", timed_out: true } };
    }
    return { ok: false, error: `no approval decision from ${target}` };
  }

  return { ok: true, output: { decision: result.action, by: result.resolved_by, content: result.content } };
}

function runExec(spec, ctx) {
  const env = ctx.env ?? process.env;
  if (env.VIBEBUS_ALLOW_EXEC !== "1") {
    return Promise.resolve({
      ok: false,
      code: "unsupported",
      error: "exec steps are disabled. Set VIBEBUS_ALLOW_EXEC=1 to let flows run shell commands.",
    });
  }

  const command = spec.input?.command ?? spec.command;
  if (!command) {
    return Promise.resolve({ ok: false, error: "exec step has no command." });
  }

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: spec.input?.cwd ?? spec.cwd ?? process.cwd(),
      env: { ...env, ...(spec.env ?? {}) },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-4000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), clampMs(spec.timeout_ms, 600_000, 1000, 3_600_000));

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // A nonzero exit is data the flow can branch on, not a bus failure.
      resolve({ ok: true, output: { exit_code: code, stdout_tail: stdout, stderr_tail: stderr } });
    });
  });
}

async function runWaitFor(store, run, step, spec) {
  const timeoutMs = clampMs(spec.timeout_ms, 60_000, 1000, 600_000);
  const deadline = Date.now() + timeoutMs;
  let cursor = store.seq();

  while (Date.now() < deadline) {
    const state = store.read();
    const current = state.flow_runs.find((item) => item.id === run.id);
    const scope = buildScope(state, current ?? run);

    if (spec.condition && evaluateCondition(spec.condition, scope, { stepId: step.id })) {
      return { ok: true, output: { satisfied: true, by: "condition" } };
    }
    if (spec.event) {
      const match = state.events.find((event) => event.seq > cursor && event.type === spec.event.type);
      if (match) {
        return { ok: true, output: { satisfied: true, by: "event", event: match } };
      }
    }

    await store.waitForChange(cursor, Math.min(deadline - Date.now(), 5000));
    cursor = store.seq();
  }

  return { ok: false, code: "timeout", error: `wait_for on ${step.id} timed out after ${timeoutMs}ms.` };
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

function candidates(state, spec, { exclude = [] } = {}) {
  return Object.values(state.agents)
    .filter((agent) => !exclude.includes(agent.agent_id))
    .filter((agent) => !spec.role || agent.role === spec.role)
    .filter((agent) => !spec.requires?.length || spec.requires.every((capability) => (agent.capabilities ?? []).includes(capability)))
    .filter((agent) => !spec.exclude_agent?.length || !spec.exclude_agent.includes(agent.agent_id))
    .filter((agent) => !spec.exclude_provider?.length || !spec.exclude_provider.includes(agent.provider))
    .filter((agent) => !spec.prefer_provider || true);
}

function pickAgent(state, spec, options) {
  const pool = candidates(state, spec, options);
  if (pool.length === 0) {
    return null;
  }

  const rank = (agent) => {
    const presence = presenceOf(agent);
    const presenceScore = { online: 0, idle: 1, asleep: 2, stale: 3, offline: 4 }[presence] ?? 5;
    const preferred = spec.prefer_provider && agent.provider === spec.prefer_provider ? -1 : 0;
    return presenceScore + preferred;
  };

  return [...pool].sort((left, right) => rank(left) - rank(right))[0];
}

/** Prefer one agent per provider, so a quorum is genuinely cross-vendor. */
function pickPanel(state, spec, size) {
  const pool = candidates(state, spec, {});
  const byProvider = new Map();

  for (const agent of pool) {
    const key = agent.provider ?? agent.agent_id;
    const held = byProvider.get(key);
    if (!held || presenceRank(agent) < presenceRank(held)) {
      byProvider.set(key, agent);
    }
  }

  const spread = [...byProvider.values()].sort((left, right) => presenceRank(left) - presenceRank(right));
  if (spread.length >= size) {
    return spread.slice(0, size);
  }

  const rest = pool.filter((agent) => !spread.includes(agent)).sort((left, right) => presenceRank(left) - presenceRank(right));
  return [...spread, ...rest].slice(0, size);
}

function presenceRank(agent) {
  return { online: 0, idle: 1, asleep: 2, stale: 3, offline: 4 }[presenceOf(agent)] ?? 5;
}

/** No agent can fill this role — try to wake one, and say so loudly. */
function unreachableRole(store, run, step, spec) {
  const state = store.read();
  const dormant = candidates(state, { ...spec }, {});

  if (dormant.length > 0) {
    store.update((draft) => {
      for (const agent of dormant.slice(0, 2)) {
        const target = draft.agents[agent.agent_id];
        if (target) {
          createWake(draft, {
            from: "vibebus",
            to: agent.agent_id,
            reason: `flow ${run.id} needs role "${spec.role}" for step ${step.id}`,
            urgency: "high",
            plan: planWake(target, { urgency: "high", max_tier: run.max_wake_tier }).plan,
            trigger: "flow",
          });
        }
      }
      return true;
    });
  }

  return {
    ok: false,
    code: "role_unreachable",
    error: `No agent could fill role "${spec.role ?? "any"}" for step ${step.id}.`,
    output: { woke: dormant.slice(0, 2).map((agent) => agent.agent_id) },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildScope(state, run) {
  return {
    inputs: run?.inputs ?? {},
    run: { id: run?.id, status: run?.status },
    steps: Object.fromEntries(
      Object.entries(run?.steps ?? {}).map(([id, step]) => [
        id,
        { status: step.status, output: step.output ?? {}, claim: step.claim ?? {} },
      ]),
    ),
    agents: Object.fromEntries(Object.entries(state.agents).map(([id, agent]) => [id, { provider: agent.provider, role: agent.role }])),
  };
}

function idleReport(store, run, unmatched) {
  const state = store.read();
  const waiting = Object.values(run.steps).filter((step) => step.status === "claimed");

  return {
    ok: true,
    run: summarize(run),
    status: run.status,
    claimed_nothing: true,
    in_flight: waiting.map((step) => ({ step_id: step.id, by: step.claim?.agent_id })),
    unmatched_steps: unmatched ?? [],
    hint: unmatched?.length
      ? `Steps ${unmatched.join(", ")} need a role this agent does not have. Register an agent with that role, or pass roles_offered.`
      : waiting.length
        ? "Another agent is working the next step."
        : "Nothing runnable right now.",
    bus_seq: state.seq,
  };
}

function healthOf(run) {
  if (TERMINAL_RUN.includes(run.status)) {
    return run.status;
  }
  const idleMs = Date.now() - Date.parse(run.updated_at ?? run.created_at);
  if (run.blocked_on) {
    return "blocked";
  }
  return idleMs > 10 * 60_000 ? "stalled" : "on_track";
}

function summarize(run) {
  const steps = Object.values(run.steps);
  return {
    id: run.id,
    flow: run.flow_name,
    status: run.status,
    created_by: run.created_by,
    updated_at: run.updated_at,
    blocked_reason: run.blocked_reason ?? null,
    progress: {
      done: steps.filter((step) => step.status === "done").length,
      total: steps.length,
      failed: steps.filter((step) => step.status === "failed").length,
      in_flight: steps.filter((step) => step.status === "claimed").length,
    },
  };
}

function findRun(state, runId) {
  const run = state.flow_runs.find((item) => item.id === runId);
  if (!run) {
    throw busError("run_not_found", `Unknown flow run: ${runId}`, {
      hint: "Call flow_status with no run_id to list recent runs.",
    });
  }
  return run;
}

function compileSafe(root) {
  try {
    return compileFlow(root);
  } catch {
    return {};
  }
}
