import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_STATE = {
  version: 1,
  nextId: 1,
  agents: {},
  messages: [],
  tasks: [],
  decisions: [],
  reads: {},
};

export function createStore(options = {}) {
  const env = options.env ?? process.env;
  const root = env.VIBEBUS_HOME || env.CLI_TEAM_MCP_HOME || path.join(os.homedir(), ".vibebus");
  const statePath = env.VIBEBUS_STATE || env.CLI_TEAM_MCP_STATE || path.join(root, "state.json");
  const lockPath = `${statePath}.lock`;

  fs.mkdirSync(path.dirname(statePath), { recursive: true });

  return {
    path: statePath,
    read() {
      return readState(statePath);
    },
    update(mutator) {
      return withLock(lockPath, () => {
        const state = readState(statePath);
        const result = mutator(state);
        writeState(statePath, state);
        return result;
      });
    },
  };
}

export function createMemoryStore(initial = {}) {
  let state = normalizeState({ ...DEFAULT_STATE, ...initial });

  return {
    path: "memory",
    read() {
      return structuredClone(state);
    },
    update(mutator) {
      const next = structuredClone(state);
      const result = mutator(next);
      state = normalizeState(next);
      return result;
    },
  };
}

export function nextId(state, prefix) {
  const value = state.nextId++;
  return `${prefix}_${String(value).padStart(6, "0")}`;
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) {
    return structuredClone(DEFAULT_STATE);
  }

  const raw = fs.readFileSync(statePath, "utf8");
  if (!raw.trim()) {
    return structuredClone(DEFAULT_STATE);
  }

  return normalizeState(JSON.parse(raw));
}

function writeState(statePath, state) {
  const temp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
  fs.renameSync(temp, statePath);
}

function normalizeState(state) {
  return {
    ...structuredClone(DEFAULT_STATE),
    ...state,
    agents: state.agents ?? {},
    messages: state.messages ?? [],
    tasks: state.tasks ?? [],
    decisions: state.decisions ?? [],
    reads: state.reads ?? {},
  };
}

function withLock(lockPath, fn) {
  const start = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      if (Date.now() - start > 5000) {
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
