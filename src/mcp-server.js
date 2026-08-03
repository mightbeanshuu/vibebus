import { BusError } from "./errors.js";
import { getPrompt, listResources, PROMPTS, readResource } from "./mcp-features.js";
import { startPump } from "./pump.js";
import { createNullSession, createSession } from "./session.js";
import { createStore } from "./store.js";
import { callTool, TOOL_DEFINITIONS } from "./tools.js";

const SERVER_INFO = {
  name: "vibebus",
  version: "2.0.0",
};

const INSTRUCTIONS = [
  "Vibe Bus is a shared, real-time coordination bus for every AI coding agent running on this machine.",
  "",
  "Start every session with register_agent — that binds this MCP connection to your agent id and is what lets",
  "other agents wake, ask, and ping you. Then read team_status and read_inbox.",
  "",
  "Key habits:",
  "- Before editing files, take a lease on them so no other agent edits the same paths.",
  "- Use ask_agent when you need an answer from another agent; it blocks and raises no_reply if nobody answers.",
  "- Use wake_agent to rouse an idle, sleeping, or exited agent; it escalates until something reaches it.",
  "- Use sleep_agent instead of polling when you have nothing to do; you will be woken within milliseconds.",
  "- Record durable choices with record_decision and shared facts with context.",
].join("\n");

export async function runMcpServer(io) {
  const store = createStore({ env: io.env });
  const session = createSession({
    send: (message) => write(io.stdout, message, framing.enabled),
    log: (text) => io.stderr?.write?.(`[vibebus] ${text}\n`),
  });

  const framing = { enabled: false };
  let pump = null;
  let buffer = "";

  const onError = (error) => io.stderr?.write?.(`[vibebus] ${error.stack ?? error.message}\n`);

  try {
    for await (const chunk of io.stdin) {
      buffer += chunk.toString("utf8");
      buffer = await drainBuffer(
        buffer,
        async ({ request, framed }) => {
          framing.enabled = framed;

          // Responses to our own outbound sampling/elicitation requests.
          if (request && request.method === undefined && request.id !== undefined) {
            session.handleResponse(request);
            return;
          }

          const response = await handleRequest(store, request, session, io.env).catch((error) =>
            errorResponse(request?.id ?? null, -32603, error.message),
          );

          if (request?.method === "initialize" && !pump) {
            pump = startPump({ store, session, env: io.env, onError });
          }

          if (response) {
            write(io.stdout, response, framed);
          }
        },
        io.stdout,
      );
    }
  } finally {
    pump?.stop();
    store.close();
  }
}

export async function handleRequest(store, request, session = createNullSession(), env = process.env) {
  if (!request || request.jsonrpc !== "2.0") {
    return errorResponse(request?.id ?? null, -32600, "Invalid JSON-RPC request");
  }

  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
    return null;
  }

  if (request.method === "initialize") {
    session.initialize(request.params ?? {});

    return resultResponse(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: {
        tools: { listChanged: false },
        // subscribe:true is what turns this server from pull-only into push.
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: false },
        logging: {},
      },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }

  if (request.method === "ping") {
    return resultResponse(request.id, {});
  }

  if (request.method === "tools/list") {
    return resultResponse(request.id, { tools: TOOL_DEFINITIONS });
  }

  if (request.method === "tools/call") {
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};

    session.beginCall(request);
    try {
      const output = await callTool(store, name, args, { session, env });
      return resultResponse(request.id, {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
        isError: false,
      });
    } catch (error) {
      // A coordination bus that swallows failures is worse than no bus, so
      // failures come back as structured, actionable tool errors.
      const payload =
        error instanceof BusError
          ? error.toJSON()
          : { ok: false, error: { code: "internal", status: 500, message: error.message, hint: null, details: {} } };

      return resultResponse(request.id, {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: true,
      });
    } finally {
      session.endCall();
    }
  }

  if (request.method === "resources/list") {
    return resultResponse(request.id, { resources: listResources() });
  }

  if (request.method === "resources/read") {
    return resultResponse(request.id, readResource(store, request.params?.uri));
  }

  if (request.method === "resources/subscribe") {
    session.subscribe(request.params?.uri);
    return resultResponse(request.id, {});
  }

  if (request.method === "resources/unsubscribe") {
    session.unsubscribe(request.params?.uri);
    return resultResponse(request.id, {});
  }

  if (request.method === "logging/setLevel") {
    return resultResponse(request.id, { level: session.setLogLevel(request.params?.level) });
  }

  if (request.method === "prompts/list") {
    return resultResponse(request.id, { prompts: PROMPTS });
  }

  if (request.method === "prompts/get") {
    return resultResponse(request.id, getPrompt(request.params?.name, request.params?.arguments ?? {}));
  }

  return errorResponse(request.id, -32601, `Method not found: ${request.method}`);
}

async function drainBuffer(buffer, onRequest, stdout) {
  while (buffer.length > 0) {
    if (/^\s*$/.test(buffer)) {
      return "";
    }

    if (buffer.startsWith("Content-Length:")) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return buffer;
      }

      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        write(stdout, errorResponse(null, -32700, "Parse error: missing Content-Length"), true);
        return "";
      }

      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) {
        return buffer;
      }

      const body = buffer.slice(bodyStart, bodyEnd);
      buffer = buffer.slice(bodyEnd);
      await parseAndHandle(body, true, onRequest, stdout);
      continue;
    }

    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      return buffer;
    }

    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      await parseAndHandle(line, false, onRequest, stdout);
    }
  }

  return buffer;
}

async function parseAndHandle(raw, framed, onRequest, stdout) {
  try {
    await onRequest({ request: JSON.parse(raw), framed });
  } catch (error) {
    write(stdout, errorResponse(null, -32700, `Parse error: ${error.message}`), framed);
  }
}

function write(stdout, message, framed = false) {
  const body = JSON.stringify(message);
  if (framed) {
    stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    return;
  }
  stdout.write(`${body}\n`);
}

function resultResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
