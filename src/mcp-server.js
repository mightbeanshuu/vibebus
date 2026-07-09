import { createStore } from "./store.js";
import { callTool, TOOL_DEFINITIONS } from "./tools.js";

const SERVER_INFO = {
  name: "vibebus",
  version: "1.0.0",
};

export async function runMcpServer(io) {
  const store = createStore({ env: io.env });
  let buffer = "";

  for await (const chunk of io.stdin) {
    buffer += chunk.toString("utf8");
    buffer = await drainBuffer(buffer, async ({ request, framed }) => {
      const response = await handleRequest(store, request).catch((error) =>
        errorResponse(request?.id ?? null, -32603, error.message),
      );
      if (response) {
        write(io.stdout, response, framed);
      }
    }, io.stdout);
  }
}

export async function handleRequest(store, request) {
  if (!request || request.jsonrpc !== "2.0") {
    return errorResponse(request?.id ?? null, -32600, "Invalid JSON-RPC request");
  }

  if (request.method === "notifications/initialized") {
    return null;
  }

  if (request.method === "initialize") {
    return resultResponse(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
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
    const output = await callTool(store, name, args);
    return resultResponse(request.id, {
      content: [
        {
          type: "text",
          text: JSON.stringify(output, null, 2),
        },
      ],
    });
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
