import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/mcp-server.js";
import { createMemoryStore } from "../src/store.js";
import { callTool } from "../src/tools.js";

test("registers agents, creates tasks, claims work, and sends messages", async () => {
  const store = createMemoryStore();

  const clients = await callTool(store, "known_clients", {});
  assert.equal(clients.ok, true);
  assert.ok(clients.clients.some((client) => client.id === "codex"));
  assert.ok(clients.clients.some((client) => client.id === "grok"));

  const codex = await callTool(store, "register_agent", {
    agent_id: "codex-main",
    cli: "codex",
    role: "implementer",
    model: "gpt-5.5",
  });
  assert.equal(codex.agent.provider, "openai");
  assert.equal(codex.agent.model, "gpt-5.5");

  await callTool(store, "register_agent", {
    agent_id: "claude-review",
    cli: "claude",
    role: "reviewer",
  });

  const taskResult = await callTool(store, "create_task", {
    from: "lead",
    title: "Add tests",
    description: "Cover message visibility.",
  });

  const claimed = await callTool(store, "claim_task", {
    agent_id: "codex-main",
    task_id: taskResult.task.id,
  });
  assert.equal(claimed.task.assignee, "codex-main");
  assert.equal(claimed.task.status, "claimed");

  await callTool(store, "send_message", {
    from: "codex-main",
    to: ["claude-review", "lead"],
    message: "Ready for review.",
    topic: "review",
  });

  const inbox = await callTool(store, "read_inbox", {
    agent_id: "claude-review",
    unread_only: true,
    mark_read: true,
  });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].message, "Ready for review.");
});

test("handles MCP initialize and tool calls", async () => {
  const store = createMemoryStore();

  const init = await handleRequest(store, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(init.result.serverInfo.name, "vibebus");

  const called = await handleRequest(store, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "register_agent",
      arguments: { agent_id: "grok-scout", cli: "grok", role: "researcher" },
    },
  });

  const output = JSON.parse(called.result.content[0].text);
  assert.equal(output.agent.provider, "xai");
});
