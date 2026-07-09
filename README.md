<p align="center">
  <img src="assets/logo.svg" alt="Vibe Bus logo" width="920">
</p>

<p align="center">
  <b>The local MCP party line for CLI agents.</b><br>
  Make Claude, Codex, Gemini, Antigravity, Grok, Cursor, Continue, VS Code, LM Studio, Aider, Goose, and custom agents coordinate without pretending telepathy is a project plan.
</p>

<p align="center">
  <a href="https://mightbeanshuu.github.io/vibebus/">Landing page</a>
  ·
  <a href="https://github.com/mightbeanshuu/vibebus">GitHub</a>
  ·
  <a href="#install">Install</a>
</p>

<p align="center">
  <img alt="Node >=18" src="assets/badge-node.svg">
  <img alt="MCP stdio" src="assets/badge-mcp.svg">
  <img alt="License MIT" src="assets/badge-license.svg">
</p>

## What It Is

Vibe Bus is a local file-backed MCP server, terminal helper, and Codex skill for multi-agent coding work.

Each CLI starts its own stdio MCP server process, but every process shares one state file:

```text
~/.vibebus/state.json
```

That gives your agents a shared:

- Inbox for direct messages and broadcasts.
- Threads, replies, read cursors, and required acknowledgements.
- Task board for claiming, blocking, and finishing work.
- Decision log for architecture and constraint alignment.
- Status board for who is doing what.
- Client registry for Claude, Codex, Gemini, Antigravity, Grok, and friends.

<p align="center">
  <img src="assets/topology.svg" alt="Vibe Bus topology" width="980">
</p>

## Install

```bash
git clone https://github.com/mightbeanshuu/vibebus.git
cd vibebus
npm link
```

Then verify:

```bash
vibebus clients
vibebus status
```

Prefer raw MCP-shaped data?

```bash
vibebus clients --json
vibebus status --json
```

<p align="center">
  <img src="assets/terminal.svg" alt="Vibe Bus terminal preview" width="980">
</p>

## MCP Command

Use this command in any MCP-capable CLI:

```bash
node /Users/mac/vibebus/bin/vibebus-mcp.js
```

If installed with `npm link`, this also works:

```bash
vibebus-mcp
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.vibebus]
command = "node"
args = ["/Users/mac/vibebus/bin/vibebus-mcp.js"]
```

Restart Codex.

## Claude Code

```bash
claude mcp add vibebus -- node /Users/mac/vibebus/bin/vibebus-mcp.js
```

Restart Claude Code or run:

```bash
claude mcp list
```

## Gemini, Antigravity, Cursor, Continue, LM Studio, OpenClaude

For clients that use `mcpServers` JSON:

```json
{
  "mcpServers": {
    "vibebus": {
      "command": "node",
      "args": ["/Users/mac/vibebus/bin/vibebus-mcp.js"]
    }
  }
}
```

For VS Code-style MCP config:

```json
{
  "servers": {
    "vibebus": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/mac/vibebus/bin/vibebus-mcp.js"]
    }
  }
}
```

For any other CLI, the rule is the same: add a stdio MCP server named `vibebus` that runs `node /Users/mac/vibebus/bin/vibebus-mcp.js`.

## Tools

Vibe Bus exposes these MCP tools:

- `known_clients` - list normalized ids for major CLI/IDE agents.
- `register_agent` - identify the current agent, role, provider, model, workspace, and capabilities.
- `heartbeat` - update live status and current task.
- `send_message` - send a direct threaded message to one or more agents.
- `send_to_role` - route a message to agents matching role, CLI, or provider.
- `broadcast` - send a threaded instruction/update to every registered agent.
- `read_inbox` - read visible messages, optionally marking them read.
- `wait_for_messages` - bounded polling for new inbox messages.
- `ack_message` - acknowledge receipt/completion of a required-ack message.
- `read_thread` - read all visible messages in a conversation thread.
- `create_task` - create shared work.
- `handoff_task` - create/assign a task and send a required-ack handoff atomically.
- `list_tasks` - inspect tasks by status or assignee.
- `claim_task` - claim open or blocked work.
- `update_task` - update status, assignee, files, and notes.
- `record_decision` - store durable team decisions.
- `team_status` - summarize agents, tasks, messages, decisions, and state path.

Vibe Bus also exposes MCP resources and prompts:

- `resources/list` / `resources/read`: `vibebus://status`, `vibebus://agents`, `vibebus://tasks`, `vibebus://messages`, `vibebus://decisions`, `vibebus://guide`.
- `prompts/list` / `prompts/get`: `vibebus-start`, `vibebus-handoff`, `vibebus-review`.

## Human CLI

```bash
vibebus clients
vibebus register codex-main codex implementer openai gpt-5.5
vibebus register claude-review claude reviewer anthropic sonnet
vibebus broadcast lead "Split work: Codex implements, Claude reviews, Grok researches edge cases."
vibebus task lead "Add tests" "Cover inbox filtering, task claiming, and MCP handshake."
vibebus handoff lead claude-review "Review README" "Check install docs and MCP examples."
vibebus ack claude-review msg_000002 "Accepted."
vibebus thread codex-main thread_000001
vibebus wait codex-main 5000
vibebus inbox codex-main
vibebus claim codex-main task_000001
vibebus done codex-main task_000001 "Tests passing."
vibebus status
```

Default CLI output is formatted for humans. Add `--json` to any command for the raw payload.

Legacy aliases still work:

```bash
cli-team
cli-team-mcp
```

## Bundled Skill

The repo includes a Codex skill:

```text
skills/vibebus/SKILL.md
```

Install it into Codex:

```bash
mkdir -p ~/.codex/skills
cp -R skills/vibebus ~/.codex/skills/
```

Then ask:

```text
Use $vibebus to coordinate Codex, Claude, Antigravity, Grok, and Gemini on this repo.
```

## Agent Workflow

1. Register at session start with `register_agent`.
2. Read `team_status` and `read_inbox`.
3. Claim a task with `claim_task`.
4. Use `handoff_task` or `send_message` with `requires_ack: true` for important delegation.
5. Use `ack_message` when a handoff is accepted or completed.
6. Use `read_thread` before replying in an active handoff.
7. Post progress with `heartbeat`.
8. Send blockers or review asks with `send_message`.
9. Record durable choices with `record_decision`.
10. Mark tasks `done` with `update_task`.

## Design Notes

The implementation follows the official MCP direction:

- MCP uses JSON-RPC and stdio clients launch local servers as subprocesses, with valid MCP messages only on stdout.
- Tools are model-controlled and should expose clear schemas; Vibe Bus returns both text and `structuredContent`.
- Resources and prompts are first-class MCP server features, so Vibe Bus exposes status/resources and reusable coordination prompts for clients that discover them.
- Claude Code and Gemini CLI both support stdio MCP server configuration; Gemini also discovers tools, resources, and prompts from configured servers.

Primary references:

- https://modelcontextprotocol.io/specification/2025-06-18
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
- https://code.claude.com/docs/en/mcp
- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md

## State

Default:

```text
~/.vibebus/state.json
```

Override:

```bash
VIBEBUS_HOME=/path/to/team-state
VIBEBUS_STATE=/path/to/state.json
```

Compatibility aliases are still supported:

```bash
CLI_TEAM_MCP_HOME=/path/to/team-state
CLI_TEAM_MCP_STATE=/path/to/state.json
```

## Test

```bash
npm run build
npm test
```

Manual MCP smoke test:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | node bin/vibebus-mcp.js
```

## License

MIT
