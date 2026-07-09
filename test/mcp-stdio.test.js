import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("agents can talk after connecting through the MCP stdio server", async () => {
  const client = startMcpServer();

  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vibebus-test", version: "1.0.0" },
    });
    assert.equal(init.serverInfo.name, "vibebus");

    await client.request("tools/call", {
      name: "register_agent",
      arguments: {
        agent_id: "codex-main",
        cli: "codex",
        role: "implementer",
        workspace: "/tmp/project",
      },
    });

    await client.request("tools/call", {
      name: "register_agent",
      arguments: {
        agent_id: "claude-review",
        cli: "claude",
        role: "reviewer",
        workspace: "/tmp/project",
      },
    });

    const sent = await client.request("tools/call", {
      name: "send_message",
      arguments: {
        from: "codex-main",
        to: "claude-review",
        message: "MCP bridge is live. Please review the patch.",
        topic: "integration-test",
        requires_ack: true,
      },
    });
    const sentPayload = parseToolPayload(sent);
    assert.equal(sentPayload.message.from, "codex-main");
    assert.equal(sentPayload.message.to, "claude-review");
    assert.equal(sentPayload.message.requires_ack, true);

    const inbox = await client.request("tools/call", {
      name: "read_inbox",
      arguments: {
        agent_id: "claude-review",
        unread_only: true,
        mark_read: true,
      },
    });
    const inboxPayload = parseToolPayload(inbox);
    assert.equal(inboxPayload.messages.length, 1);
    assert.equal(inboxPayload.messages[0].message, "MCP bridge is live. Please review the patch.");

    const acked = await client.request("tools/call", {
      name: "ack_message",
      arguments: {
        agent_id: "claude-review",
        message_id: inboxPayload.messages[0].id,
        note: "Received over MCP stdio.",
      },
    });
    const ackPayload = parseToolPayload(acked);
    assert.deepEqual(ackPayload.pending_ack, []);

    const reply = await client.request("tools/call", {
      name: "send_message",
      arguments: {
        from: "claude-review",
        to: "codex-main",
        message: "Review received. Thread is working.",
        reply_to: inboxPayload.messages[0].id,
      },
    });
    const replyPayload = parseToolPayload(reply);
    assert.equal(replyPayload.message.thread_id, inboxPayload.messages[0].thread_id);
  } finally {
    await client.stop();
  }
});

function startMcpServer() {
  const stateHome = mkdtempSync(path.join(os.tmpdir(), "vibebus-mcp-test-"));
  const child = spawn(process.execPath, ["bin/vibebus-mcp.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      VIBEBUS_HOME: stateHome,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  let stdout = "";
  let stderr = "";
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline = stdout.indexOf("\n");

    while (newline !== -1) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);

      if (line) {
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) {
          clearTimeout(waiter.timeout);
          pending.delete(message.id);
          if (message.error) {
            waiter.reject(new Error(message.error.message));
          } else {
            waiter.resolve(message.result);
          }
        }
      }

      newline = stdout.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.on("exit", (code, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(`MCP server exited before response: code=${code} signal=${signal} stderr=${stderr}`));
    }
    pending.clear();
  });

  return {
    request(method, params = {}) {
      const id = nextId++;
      const payload = { jsonrpc: "2.0", id, method, params };
      const request = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}; stderr=${stderr}`));
        }, 5000);
        pending.set(id, { resolve, reject, timeout });
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return request;
    },

    async stop() {
      child.stdin.end();
      if (!child.killed) {
        child.kill();
      }
      rmSync(stateHome, { recursive: true, force: true });
    },
  };
}

function parseToolPayload(result) {
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, parsed);
  return parsed;
}
