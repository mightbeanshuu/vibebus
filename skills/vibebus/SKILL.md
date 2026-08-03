---
name: vibebus
description: Coordinate multiple MCP-capable CLI/IDE coding agents through Vibe Bus in real time. Use when an agent needs to delegate, review, synchronize, monitor, hand off, wake a sleeping teammate, ask another agent a question and wait for the answer, get a second opinion from a different model vendor, or run a shared multi-agent flow across Claude Code, Codex CLI, Gemini CLI, Antigravity, Grok, Cursor, Continue, VS Code, LM Studio, Aider, Goose, OpenCode, or any custom agent on the shared Vibe Bus MCP server.
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

## Waiting And Waking

Never poll in a loop. The bus is push-based.

- `wait_for_messages` / `wait_for_events` block on a file watcher and return within milliseconds of real activity. Long timeouts are safe and cost nothing while idle.
- `sleep_agent` parks you when you have nothing to do. It returns the moment a teammate wakes you, carrying the reason and your unread messages.
- `wake_agent` rouses a teammate. It escalates bus -> session -> its model -> its tmux pane -> its human -> relaunching it, stopping at the first tier that reaches them. Sending high or urgent work to an idle agent wakes it automatically.
- `ping_agent` proves someone is alive without spending a model call. Use it before assuming a silent agent is thinking.

## Getting A Real Answer

Silence is not agreement.

- `ask_agent` blocks until the other agent answers and raises `no_reply` — with presence diagnostics and what to do next — if nobody does. Prefer it over `send_message` whenever you cannot proceed without the answer.
- `ask_quorum` puts one question to agents on different model providers and returns the verdict, an agreement score, and every dissenting answer verbatim. Use it for decisions you would regret getting wrong, and read the dissent rather than only the verdict.
- `debate` has two agents from different vendors argue and a third judge. Use it when the tradeoff is genuinely contested.
- `request_approval` asks the human behind another agent's CLI.

If a call returns an error with a `code` and `hint`, act on the hint. `agent_unreachable` means nobody is home, not that the bus is broken — `vibebus doctor` distinguishes the two.

## Not Colliding

- `lease` the files you are about to edit, before you edit them. A conflict names the holder so you can message them.
- Read `context` before assuming a shared fact; write it with `if_version` so you cannot clobber a concurrent write.
- Use `depends_on` on tasks instead of waiting manually. Finishing a task unblocks and wakes whatever was waiting.

## Flows

For repeatable multi-agent work, define a flow once and let it run on whoever is alive.

- Steps target **roles**, not agent ids, so the flow does not care which CLIs are running.
- `exclude_provider: ["${steps.implement.claim.provider}"]` guarantees the reviewer is on a different model vendor than the implementer.
- Loop `advance_flow`: engine steps (ask, quorum, debate, approve, exec, wait_for, decide) execute immediately; a `task` step comes back as an assignment for you to do and `report_step`.
- There is no scheduler process. Whichever agent calls `advance_flow` next moves the flow forward.

## Message Rules

- Keep messages actionable: include the requested action, expected output, and relevant files.
- Use `priority: "urgent"` only for blockers.
- Use `topic` for threads like `tests`, `review`, `deploy`, `research`, or `handoff`.
- Prefer direct messages for ownership and `broadcast` for team-wide decisions.
- Use `requires_ack: true` for handoffs that must not be dropped.
- Use `reply_to` when continuing a message thread.
- Use `ask_agent` instead of `send_message` when you need an answer before continuing.

## Task Rules

- One task should have one clear owner and one completion condition.
- Use `files` to point agents at specific paths.
- Use `blocked` with a note when waiting on another agent or user input.
- Use `record_decision` for permanent context, not ordinary progress chatter.

## Client Configs

Read `references/client-configs.md` when installing or fixing MCP config for a specific CLI/IDE.
