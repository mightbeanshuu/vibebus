import { busError } from "./errors.js";

const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];

/**
 * One live MCP connection.
 *
 * v1 only ever answered questions. A session can also *start* a conversation:
 * push notifications, ask the connected client's model to generate
 * (sampling/createMessage), and put a prompt in front of its human
 * (elicitation/create). That outbound direction is what makes the bus
 * bidirectional rather than a shared file with extra steps.
 */
export function createSession({ send, log } = {}) {
  const pending = new Map();
  const subscriptions = new Set();

  let requestCounter = 0;
  let clientCapabilities = {};
  let clientInfo = {};
  let boundAgentId = null;
  let logLevel = "info";
  let progressToken = null;

  const write = (message) => {
    if (typeof send === "function") {
      send(message);
    }
  };

  const session = {
    get agentId() {
      return boundAgentId;
    },
    get capabilities() {
      return clientCapabilities;
    },
    get client() {
      return clientInfo;
    },

    bind(agentId) {
      boundAgentId = agentId;
    },

    initialize(params = {}) {
      clientCapabilities = params.capabilities ?? {};
      clientInfo = params.clientInfo ?? {};
    },

    clientCapabilitySummary() {
      return {
        sampling: Boolean(clientCapabilities.sampling),
        elicitation: Boolean(clientCapabilities.elicitation),
        roots: Boolean(clientCapabilities.roots),
        client_name: clientInfo.name ?? null,
        client_version: clientInfo.version ?? null,
      };
    },

    pushSummary() {
      return {
        available: true,
        notifications: true,
        resource_subscriptions: true,
        can_wake_model: Boolean(clientCapabilities.sampling),
        can_ask_human: Boolean(clientCapabilities.elicitation),
        note: clientCapabilities.sampling
          ? "This client supports MCP sampling, so other agents can wake this one's model directly."
          : "This client does not support MCP sampling. Wakes will reach the inbox and, where supported, the human — but cannot start a model turn on their own.",
      };
    },

    setLogLevel(level) {
      if (LOG_LEVELS.includes(level)) {
        logLevel = level;
      }
      return logLevel;
    },

    subscribe(uri) {
      subscriptions.add(uri);
    },
    unsubscribe(uri) {
      subscriptions.delete(uri);
    },
    isSubscribed(uri) {
      return subscriptions.has(uri);
    },
    get subscriptionCount() {
      return subscriptions.size;
    },

    beginCall(request) {
      progressToken = request?.params?._meta?.progressToken ?? null;
    },
    endCall() {
      progressToken = null;
    },

    /** Streamed status while a tool blocks, so long waits are not silent. */
    progress(message, { progress, total } = {}) {
      if (progressToken === null || progressToken === undefined) {
        return;
      }
      write({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken, message, progress: progress ?? 0, ...(total ? { total } : {}) },
      });
    },

    notifyResourceUpdated(uri) {
      if (!subscriptions.has(uri)) {
        return false;
      }
      write({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
      return true;
    },

    notifyResourceListChanged() {
      write({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: {} });
    },

    /** Server-initiated log line. Most clients surface these live in the UI. */
    notifyLog(level, data) {
      if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(logLevel)) {
        return false;
      }
      write({ jsonrpc: "2.0", method: "notifications/message", params: { level, logger: "vibebus", data } });
      return true;
    },

    /** Server -> client request with correlation and a hard timeout. */
    request(method, params, timeoutMs = 120_000) {
      if (typeof send !== "function") {
        return Promise.reject(busError("no_session", "No live MCP session is attached to this process."));
      }

      const id = `vb_${++requestCounter}`;
      write({ jsonrpc: "2.0", id, method, params });

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(busError("timeout", `Client did not answer ${method} within ${timeoutMs}ms.`));
        }, timeoutMs);

        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            pending.delete(id);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          },
        });
      });
    },

    /** Route a JSON-RPC response from the client back to its waiting request. */
    handleResponse(message) {
      const entry = pending.get(message.id);
      if (!entry) {
        return false;
      }
      if (message.error) {
        entry.reject(
          busError("unsupported", message.error.message ?? "Client rejected the request.", {
            details: { code: message.error.code },
          }),
        );
      } else {
        entry.resolve(message.result);
      }
      return true;
    },

    isPendingResponse(message) {
      return pending.has(message?.id);
    },

    /**
     * Make this client's model run. The heart of the model wake tier.
     */
    async sample({ prompt, system, maxTokens = 900, timeoutMs = 120_000, hints = [] }) {
      if (!clientCapabilities.sampling) {
        throw busError("unsupported", `${clientInfo.name ?? "This client"} does not support MCP sampling.`, {
          hint: "The wake will fall back to the inbox and, if available, the human tier.",
        });
      }

      const result = await session.request(
        "sampling/createMessage",
        {
          messages: [{ role: "user", content: { type: "text", text: prompt } }],
          ...(system ? { systemPrompt: system } : {}),
          maxTokens,
          ...(hints.length ? { modelPreferences: { hints: hints.map((name) => ({ name })) } } : {}),
        },
        timeoutMs,
      );

      const content = result?.content;
      const text = Array.isArray(content)
        ? content.map((part) => part.text ?? "").join("\n").trim()
        : (content?.text ?? "").trim();

      return { text, model: result?.model ?? null, stopReason: result?.stopReason ?? null };
    },

    /** Put a decision in front of this client's human. */
    async elicit({ message, schema, timeoutMs = 180_000 }) {
      if (!clientCapabilities.elicitation) {
        throw busError("unsupported", `${clientInfo.name ?? "This client"} does not support MCP elicitation.`, {
          hint: "A human must read the inbox and call resolve_approval manually.",
        });
      }

      const result = await session.request(
        "elicitation/create",
        {
          message,
          requestedSchema: schema ?? { type: "object", properties: {}, required: [] },
        },
        timeoutMs,
      );

      return { action: result?.action ?? "cancel", content: result?.content ?? null };
    },

    debug(message) {
      log?.(message);
    },
  };

  return session;
}

/** Used by tests and the CLI, where nothing is listening on the other end. */
export function createNullSession() {
  return createSession({});
}
