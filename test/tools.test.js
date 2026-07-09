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
    requires_ack: true,
  });

  const inbox = await callTool(store, "read_inbox", {
    agent_id: "claude-review",
    unread_only: true,
    mark_read: true,
  });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].message, "Ready for review.");

  const acked = await callTool(store, "ack_message", {
    agent_id: "claude-review",
    message_id: inbox.messages[0].id,
    note: "Review accepted.",
  });
  assert.deepEqual(acked.pending_ack, ["lead"]);

  const reply = await callTool(store, "send_message", {
    from: "claude-review",
    to: "codex-main",
    message: "Review complete.",
    reply_to: inbox.messages[0].id,
  });
  assert.equal(reply.message.thread_id, inbox.messages[0].thread_id);

  const thread = await callTool(store, "read_thread", {
    agent_id: "codex-main",
    thread_id: reply.message.thread_id,
  });
  assert.equal(thread.messages.length, 2);
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
  assert.deepEqual(called.result.structuredContent, output);
  assert.equal(output.agent.provider, "xai");
});

test("supports role routing, handoff tasks, resources, and prompts", async () => {
  const store = createMemoryStore();

  await callTool(store, "register_agent", {
    agent_id: "claude-review",
    cli: "claude",
    role: "reviewer",
  });

  const routed = await callTool(store, "send_to_role", {
    from: "lead",
    role: "reviewer",
    message: "Please review the latest patch.",
    requires_ack: true,
  });
  assert.deepEqual(routed.recipients, ["claude-review"]);

  const waited = await callTool(store, "wait_for_messages", {
    agent_id: "claude-review",
    unread_only: true,
    timeout_ms: 50,
  });
  assert.equal(waited.messages.length, 1);
  assert.equal(waited.timed_out, false);

  const handoff = await callTool(store, "handoff_task", {
    from: "lead",
    to: "claude-review",
    title: "Review docs",
    description: "Check README clarity.",
  });
  assert.equal(handoff.task.assignee, "claude-review");
  assert.equal(handoff.message.requires_ack, true);

  const resources = await handleRequest(store, {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/list",
  });
  assert.ok(resources.result.resources.some((resource) => resource.uri === "vibebus://status"));

  const prompt = await handleRequest(store, {
    jsonrpc: "2.0",
    id: 4,
    method: "prompts/get",
    params: { name: "vibebus-start", arguments: { agent_id: "codex-main", cli: "codex" } },
  });
  assert.match(prompt.result.messages[0].content.text, /Register as codex-main/);
});
