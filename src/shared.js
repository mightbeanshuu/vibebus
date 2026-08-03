// `headless` is the verified non-interactive invocation for each CLI, used by
// the process wake tier to relaunch an agent that has exited.
export const KNOWN_CLIENTS = [
  { id: "claude", label: "Claude Code", provider: "anthropic", mcp: "stdio", headless: 'claude -p "{prompt}"' },
  { id: "codex", label: "OpenAI Codex CLI", provider: "openai", mcp: "stdio", headless: 'codex exec --sandbox workspace-write "{prompt}"' },
  { id: "gemini", label: "Gemini CLI", provider: "google", mcp: "stdio", headless: 'gemini -p "{prompt}"' },
  { id: "antigravity", label: "Google Antigravity", provider: "google", mcp: "stdio", headless: null },
  { id: "antigravit", label: "Antigravity alias", provider: "google", mcp: "stdio", headless: null },
  { id: "grok", label: "Grok CLI", provider: "xai", mcp: "stdio", headless: null },
  { id: "cursor", label: "Cursor", provider: "cursor", mcp: "stdio", headless: null },
  { id: "windsurf", label: "Windsurf", provider: "codeium", mcp: "stdio", headless: null },
  { id: "continue", label: "Continue", provider: "continue", mcp: "stdio", headless: null },
  { id: "vscode", label: "VS Code MCP", provider: "microsoft", mcp: "stdio", headless: null },
  { id: "lmstudio", label: "LM Studio", provider: "lmstudio", mcp: "stdio", headless: null },
  { id: "opencode", label: "OpenCode", provider: "sst", mcp: "stdio", headless: null },
  { id: "aider", label: "Aider", provider: "aider", mcp: "stdio", headless: null },
  { id: "goose", label: "Goose", provider: "block", mcp: "stdio", headless: null },
  { id: "qwen", label: "Qwen Code", provider: "alibaba", mcp: "stdio", headless: null },
  { id: "crush", label: "Crush", provider: "charm", mcp: "stdio", headless: null },
  { id: "amp", label: "Amp", provider: "sourcegraph", mcp: "stdio", headless: null },
  { id: "openhands", label: "OpenHands", provider: "all-hands", mcp: "stdio", headless: null },
  { id: "openclaude", label: "OpenClaude", provider: "openclaude", mcp: "stdio", headless: null },
  { id: "shannon", label: "Shannon", provider: "shannon", mcp: "stdio", headless: null },
  { id: "zed", label: "Zed Agent", provider: "zed", mcp: "stdio", headless: null },
];

export function inferProvider(cli) {
  return KNOWN_CLIENTS.find((client) => client.id === cli)?.provider ?? null;
}

export function headlessCommandFor(cli) {
  return KNOWN_CLIENTS.find((client) => client.id === cli)?.headless ?? null;
}

export function timestamp() {
  return new Date().toISOString();
}

export function note(agentId, text) {
  return { agent_id: agentId, text, created_at: timestamp() };
}

export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function requireString(input, key) {
  if (typeof input?.[key] !== "string" || input[key].trim() === "") {
    throw new Error(`${key} is required`);
  }
}

export function requireRecipient(input, key) {
  const value = input?.[key];
  if (typeof value === "string" && value.trim() !== "") {
    return;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() !== "")) {
    return;
  }
  throw new Error(`${key} must be an agent id, '*', or an array of agent ids`);
}

export function normalizeLimit(value, fallback = 50, max = 200) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, parsed));
}

export function clampMs(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, base));
}

export function compareIds(left, right) {
  return Number(String(left).split("_").at(-1)) - Number(String(right).split("_").at(-1));
}

export function ensureAgent(state, agentId) {
  state.agents[agentId] ??= {
    agent_id: agentId,
    cli: "unknown",
    provider: null,
    model: null,
    session_id: null,
    role: "agent",
    status: "active",
    note: "",
    capabilities: [],
    supports: {},
    channels: [],
    workspace: null,
    sleep_until: null,
    wake_command: null,
    auto_wake: true,
    registered_at: timestamp(),
    last_seen_at: timestamp(),
  };
  return state.agents[agentId];
}

/**
 * Any bus activity from an agent proves it is awake, so touching it also clears
 * a declared sleep window.
 */
export function touchAgent(state, agentId, { keepAsleep = false } = {}) {
  if (!agentId) {
    return null;
  }
  const agent = ensureAgent(state, agentId);
  agent.last_seen_at = timestamp();
  if (!keepAsleep) {
    agent.sleep_until = null;
  }
  return agent;
}

export function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

export function stringProp(description, required = true) {
  return { type: "string", description, minLength: required ? 1 : 0 };
}

export function booleanProp(description) {
  return { type: "boolean", description };
}

export function numberProp(description) {
  return { type: "number", description };
}

export function arrayProp(description) {
  return { type: "array", description, items: { type: "string" } };
}

export function objectProp(description) {
  return { type: "object", description, additionalProperties: true };
}

export function enumProp(values, description) {
  return { type: "string", enum: values, description };
}

export function recipientProp(description) {
  return {
    oneOf: [
      { type: "string", minLength: 1 },
      { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    ],
    description,
  };
}
