import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { busError } from "./errors.js";
import { emit } from "./events.js";
import { normalizeLimit, requireString, timestamp, touchAgent } from "./shared.js";

/**
 * The shared work cache.
 *
 * Without it, every agent that joins a task starts cold: it re-reads the same
 * files, re-runs the same research, and re-derives conclusions a teammate
 * already reached an hour ago. An artifact is the durable output of work — a
 * research writeup, a plan, a findings table, a generated file — that any other
 * CLI can read instead of redoing.
 *
 * Content lives on disk, not in state.json. The bus state is rewritten in full
 * on every mutation, so putting a 40KB research document in it would tax every
 * single write on the machine. State keeps only a small index.
 */
const MAX_INLINE = 200_000;

export function artifact(store, input, ctx = {}) {
  requireString(input, "action");

  switch (input.action) {
    case "put":
      return putArtifact(store, input, ctx);
    case "get":
      return getArtifact(store, input, ctx);
    case "list":
      return listArtifacts(store, input);
    case "delete":
      return deleteArtifact(store, input, ctx);
    default:
      throw busError("invalid_request", `Unknown artifact action: ${input.action}`, {
        hint: "Use put, get, list, or delete.",
      });
  }
}

function putArtifact(store, input, ctx) {
  requireString(input, "agent_id");
  requireString(input, "key");

  if (typeof input.content !== "string" || input.content === "") {
    throw busError("invalid_request", "content is required to store an artifact.", {
      hint: "Pass the actual text you want other agents to be able to read.",
    });
  }
  if (input.content.length > MAX_INLINE) {
    throw busError("invalid_request", `Artifact is ${input.content.length} bytes, over the ${MAX_INLINE} limit.`, {
      hint: "Write the big file into the repo and store a short summary plus its path here instead.",
    });
  }

  const root = cacheRoot(ctx.env);
  const relative = safeKey(input.key);
  const absolute = path.join(root, relative);

  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, input.content);

  return store.update((state) => {
    const existing = state.artifacts?.[input.key];
    const entry = {
      key: input.key,
      path: absolute,
      kind: input.kind ?? existing?.kind ?? "note",
      summary: input.summary ?? existing?.summary ?? "",
      task_id: input.task_id ?? existing?.task_id ?? null,
      tags: input.tags ?? existing?.tags ?? [],
      bytes: input.content.length,
      sha: createHash("sha256").update(input.content).digest("hex").slice(0, 16),
      version: (existing?.version ?? 0) + 1,
      created_by: existing?.created_by ?? input.agent_id,
      updated_by: input.agent_id,
      updated_at: timestamp(),
    };

    state.artifacts ??= {};
    state.artifacts[input.key] = entry;

    emit(state, "artifact.put", {
      actor: input.agent_id,
      ref: input.key,
      data: { kind: entry.kind, summary: entry.summary, bytes: entry.bytes, task_id: entry.task_id, version: entry.version },
    });

    touchAgent(state, input.agent_id);
    return { ok: true, artifact: entry, bus_seq: state.seq };
  });
}

function getArtifact(store, input) {
  requireString(input, "key");
  const state = store.read();
  const entry = state.artifacts?.[input.key];

  if (!entry) {
    const near = Object.keys(state.artifacts ?? {}).filter((key) => key.includes(input.key) || input.key.includes(key));
    throw busError("not_found", `No artifact stored under: ${input.key}`, {
      hint: near.length
        ? `Close matches: ${near.slice(0, 5).join(", ")}`
        : 'Call artifact(action:"list") to see what the team has already produced.',
      details: { known_keys: Object.keys(state.artifacts ?? {}).slice(0, 40) },
    });
  }

  let content = null;
  try {
    content = fs.readFileSync(entry.path, "utf8");
  } catch (error) {
    throw busError("not_found", `Artifact ${input.key} is indexed but its file is gone (${entry.path}).`, {
      hint: "Whoever produced it needs to put it again.",
      details: { error: error.message },
    });
  }

  return { ok: true, artifact: entry, content, bus_seq: state.seq };
}

function listArtifacts(store, input) {
  const state = store.read();
  const limit = normalizeLimit(input.limit, 50);

  const entries = Object.values(state.artifacts ?? {})
    .filter((entry) => !input.task_id || entry.task_id === input.task_id)
    .filter((entry) => !input.kind || entry.kind === input.kind)
    .filter((entry) => !input.prefix || entry.key.startsWith(input.prefix))
    .filter((entry) => !input.tag || (entry.tags ?? []).includes(input.tag))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
    .slice(0, limit);

  // The index deliberately omits content: this is the "what already exists?"
  // call an agent should make before starting work.
  return { ok: true, artifacts: entries, count: entries.length, bus_seq: state.seq };
}

function deleteArtifact(store, input, ctx) {
  requireString(input, "agent_id");
  requireString(input, "key");

  return store.update((state) => {
    const entry = state.artifacts?.[input.key];
    if (!entry) {
      throw busError("not_found", `No artifact stored under: ${input.key}`);
    }
    try {
      fs.rmSync(entry.path, { force: true });
    } catch {
      // index removal still proceeds
    }
    delete state.artifacts[input.key];
    emit(state, "artifact.deleted", { actor: input.agent_id, ref: input.key, data: {} });
    touchAgent(state, input.agent_id);
    return { ok: true, deleted: input.key, bus_seq: state.seq };
  });
}

function cacheRoot(env = process.env) {
  const home = env.VIBEBUS_HOME || env.CLI_TEAM_MCP_HOME || path.join(os.homedir(), ".vibebus");
  return env.VIBEBUS_CACHE || path.join(home, "cache");
}

/** Keys are namespaced paths like "task_000015/research"; keep them inside the cache. */
function safeKey(key) {
  const cleaned = String(key)
    .split("/")
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+/, ""))
    .filter(Boolean)
    .join("/");

  if (!cleaned) {
    throw busError("invalid_request", `Artifact key is not usable as a path: ${key}`);
  }
  return cleaned.endsWith(".md") || cleaned.endsWith(".json") || cleaned.endsWith(".txt") ? cleaned : `${cleaned}.md`;
}
