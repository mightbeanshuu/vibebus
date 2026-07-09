---
name: vibebus
description: Coordinate multiple MCP-capable CLI/IDE coding agents through Vibe Bus. Use when Codex needs to delegate, review, synchronize, monitor, or hand off work across Claude Code, Codex CLI, Gemini CLI, Antigravity, Grok, Cursor, Continue, VS Code, LM Studio, Aider, Goose, OpenCode, or any custom agent connected to the shared Vibe Bus MCP server.
---

# Vibe Bus

Use Vibe Bus as the shared workbench for CLI agents: identity, inbox, task board, threads, acknowledgements, status, and decision log. Assume each client has the same `vibebus-mcp` server configured and shares `~/.vibebus/state.json` unless the environment overrides `VIBEBUS_HOME` or `VIBEBUS_STATE`.

## Startup

1. Call `known_clients` to confirm normalized client ids.
2. Call `register_agent` with a stable `agent_id`, `cli`, `role`, `workspace`, and known capabilities.
3. Call `team_status` to inspect current agents, tasks, recent messages, and decisions.
4. Call `read_inbox` with `unread_only: true` and `mark_read: true`.

Use stable ids like `codex-main`, `claude-review`, `gemini-research`, `antigravity-ui`, `grok-scout`, or `cursor-impl`.

## Orchestration Loop

For multi-agent work:

1. Convert the user goal into small `create_task` items.
2. Assign or let agents `claim_task`.
3. Send explicit handoffs with `send_message`.
4. Publish broad changes with `broadcast`.
5. Post progress using `heartbeat` at major state changes.
6. Use `ack_message` when a message asks for acknowledgement.
7. Use `read_thread` before replying to an active handoff.
8. Capture constraints and architecture choices with `record_decision`.
9. Mark completion with `update_task` using `status: "done"`.

Do not use Vibe Bus as a substitute for source control or tests. Treat it as a coordination layer.

## Message Rules

- Keep messages actionable: include the requested action, expected output, and relevant files.
- Use `priority: "urgent"` only for blockers.
- Use `topic` for threads like `tests`, `review`, `deploy`, `research`, or `handoff`.
- Prefer direct messages for ownership and `broadcast` for team-wide decisions.
- Use `requires_ack: true` for handoffs that must not be dropped.
- Use `reply_to` when continuing a message thread.
- Use `wait_for_messages` only with short timeouts; do not block indefinitely.

## Task Rules

- One task should have one clear owner and one completion condition.
- Use `files` to point agents at specific paths.
- Use `blocked` with a note when waiting on another agent or user input.
- Use `record_decision` for permanent context, not ordinary progress chatter.

## Client Configs

Read `references/client-configs.md` when installing or fixing MCP config for a specific CLI/IDE.
