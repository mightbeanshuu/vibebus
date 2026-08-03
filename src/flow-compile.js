import { busError } from "./errors.js";

export const CONTAINER_TYPES = ["sequence", "parallel"];
export const LEAF_TYPES = ["task", "ask", "quorum", "debate", "approve", "exec", "wait_for", "decide"];
export const STEP_TYPES = [...CONTAINER_TYPES, ...LEAF_TYPES];

/**
 * Flow definitions are authored as a readable tree, but the scheduler only ever
 * asks one question — "what is runnable right now?" — so the tree is flattened
 * once, at start, into a map of steps with explicit dependencies.
 */
export function compileFlow(root, { maxSteps = 500 } = {}) {
  if (!root || typeof root !== "object") {
    throw busError("invalid_flow", "A flow needs a root step.");
  }

  const steps = {};
  const seen = new Set();

  const visit = (node, { parent, dependsOn, branchOf = null }) => {
    if (!node || typeof node !== "object") {
      throw busError("invalid_flow", `Step under ${parent ?? "root"} is not an object.`);
    }
    if (!node.id) {
      throw busError("invalid_flow", `Every step needs an id (missing under ${parent ?? "root"}).`);
    }
    if (seen.has(node.id)) {
      throw busError("invalid_flow", `Duplicate step id: ${node.id}`, {
        hint: "Step ids must be unique across the whole flow.",
      });
    }
    if (!STEP_TYPES.includes(node.type)) {
      throw busError("invalid_flow", `Unknown step type "${node.type}" on step ${node.id}.`, {
        hint: `Valid types: ${STEP_TYPES.join(", ")}`,
      });
    }
    seen.add(node.id);

    if (Object.keys(steps).length >= maxSteps) {
      throw busError("invalid_flow", `Flow exceeds max_steps (${maxSteps}).`);
    }

    const record = {
      id: node.id,
      type: node.type,
      status: "pending",
      parent,
      depends_on: [...dependsOn],
      children: [],
      branch_of: branchOf,
      when: node.when ?? null,
      spec: leafSpec(node),
      claim: null,
      output: null,
      error: null,
      retry_count: 0,
    };
    steps[node.id] = record;

    if (node.type === "sequence") {
      let previous = [];
      for (const child of node.steps ?? []) {
        visit(child, { parent: node.id, dependsOn: previous.length ? previous : [node.id] });
        previous = [child.id];
        record.children.push(child.id);
      }
      return;
    }

    if (node.type === "parallel") {
      for (const child of node.steps ?? []) {
        visit(child, { parent: node.id, dependsOn: [node.id] });
        record.children.push(child.id);
      }
      return;
    }

    if (node.type === "decide") {
      for (const branch of node.branches ?? []) {
        if (!branch.then) {
          throw busError("invalid_flow", `decide step ${node.id} has a branch with no "then" step.`);
        }
        visit(branch.then, { parent: node.id, dependsOn: [node.id], branchOf: node.id });
        record.children.push(branch.then.id);
        steps[branch.then.id].when = branch.when ?? null;
      }
      if (node.else) {
        visit(node.else, { parent: node.id, dependsOn: [node.id], branchOf: node.id });
        record.children.push(node.else.id);
        steps[node.else.id].when = null;
      }
    }
  };

  visit(root, { parent: null, dependsOn: [] });
  assertAcyclic(steps);

  return steps;
}

function leafSpec(node) {
  const {
    id: _id,
    type: _type,
    steps: _steps,
    branches: _branches,
    else: _else,
    when: _when,
    ...rest
  } = node;
  return rest;
}

function assertAcyclic(steps) {
  const state = new Map();

  const walk = (id, trail) => {
    const mark = state.get(id);
    if (mark === "done") {
      return;
    }
    if (mark === "open") {
      throw busError("invalid_flow", `Dependency cycle: ${[...trail, id].join(" -> ")}`);
    }
    state.set(id, "open");
    for (const dependency of steps[id]?.depends_on ?? []) {
      if (!steps[dependency]) {
        throw busError("invalid_flow", `Step ${id} depends on unknown step ${dependency}.`);
      }
      walk(dependency, [...trail, id]);
    }
    state.set(id, "done");
  };

  for (const id of Object.keys(steps)) {
    walk(id, []);
  }
}

/**
 * Deliberately not eval. Templates are resolved by dotted-path lookup only, so
 * a flow definition sitting in a world-readable state file can never become
 * code execution.
 */
export function resolveTemplates(value, scope, { stepId } = {}) {
  if (typeof value === "string") {
    return resolveString(value, scope, stepId);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, scope, { stepId }));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, scope, { stepId })]));
  }
  return value;
}

const TEMPLATE = /\$\{([^}]+)\}/g;

function resolveString(text, scope, stepId) {
  // A lone template resolves to the real value, keeping objects and arrays intact.
  const whole = text.match(/^\$\{([^}]+)\}$/);
  if (whole) {
    return lookup(whole[1].trim(), scope, stepId);
  }

  return text.replace(TEMPLATE, (_match, path) => {
    const found = lookup(path.trim(), scope, stepId);
    return typeof found === "string" ? found : JSON.stringify(found);
  });
}

function lookup(path, scope, stepId) {
  let cursor = scope;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) {
      throw busError("template_error", `Step ${stepId ?? "?"} references \${${path}}, which does not resolve.`, {
        hint: "Check the step id and that the step it depends on has produced that output field.",
        details: { step_id: stepId, expression: path, failed_at: segment },
      });
    }
    cursor = cursor[segment];
  }
  if (cursor === undefined) {
    throw busError("template_error", `Step ${stepId ?? "?"} references \${${path}}, which is undefined.`, {
      details: { step_id: stepId, expression: path },
    });
  }
  return cursor;
}

const COMPARATORS = {
  "==": (left, right) => String(left) === String(right),
  "!=": (left, right) => String(left) !== String(right),
  ">": (left, right) => Number(left) > Number(right),
  "<": (left, right) => Number(left) < Number(right),
  ">=": (left, right) => Number(left) >= Number(right),
  "<=": (left, right) => Number(left) <= Number(right),
  contains: (left, right) => String(left).toLowerCase().includes(String(right).toLowerCase()),
  in: (left, right) => (Array.isArray(right) ? right : String(right).split(",")).map(String).includes(String(left)),
};

/** Safe condition evaluation: `<template> <op> <literal>`, nothing more. */
export function evaluateCondition(condition, scope, { stepId } = {}) {
  if (!condition) {
    return true;
  }

  // Word boundaries matter: without them the `in` operator matches inside
  // "contains" and silently mis-parses the whole condition.
  const match = String(condition).match(/^\s*(.+?)\s+(==|!=|>=|<=|>|<|\bcontains\b|\bin\b)\s+(.+?)\s*$/);
  if (!match) {
    throw busError("invalid_flow", `Condition on ${stepId ?? "?"} is not understood: ${condition}`, {
      hint: 'Conditions look like: ${steps.review.output.verdict} == "approve"',
    });
  }

  const [, rawLeft, operator, rawRight] = match;
  const left = resolveTemplates(rawLeft, scope, { stepId });
  const right = literal(rawRight, scope, stepId);
  return COMPARATORS[operator](left, right);
}

function literal(raw, scope, stepId) {
  const text = raw.trim();
  if (text.startsWith("${")) {
    return resolveTemplates(text, scope, { stepId });
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text !== "" && !Number.isNaN(Number(text))) return Number(text);
  return text;
}
