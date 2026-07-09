export const PROMPTS = [
  {
    name: "vibebus-start",
    title: "Start Vibe Bus Session",
    description: "Register this agent, inspect team status, and read unread messages.",
    arguments: [
      { name: "agent_id", description: "Stable agent id for this CLI session.", required: true },
      { name: "cli", description: "Client id such as codex, claude, gemini, antigravity, or grok.", required: true },
      { name: "role", description: "Agent role such as implementer, reviewer, researcher, or lead.", required: false },
    ],
  },
  {
    name: "vibebus-handoff",
    title: "Create Agent Handoff",
    description: "Create a required-ack task handoff to another agent.",
    arguments: [
      { name: "from", description: "Sender agent id.", required: true },
      { name: "to", description: "Recipient agent id.", required: true },
      { name: "goal", description: "Work to hand off.", required: true },
    ],
  },
  {
    name: "vibebus-review",
    title: "Request Review",
    description: "Ask another agent to review files or a completed task.",
    arguments: [
      { name: "from", description: "Sender agent id.", required: true },
      { name: "to", description: "Reviewer agent id.", required: true },
      { name: "files", description: "Files to review.", required: false },
    ],
  },
];

export function listResources() {
  return [
    resource("vibebus://status", "Vibe Bus Status", "Current agents, open tasks, recent messages, and decisions."),
    resource("vibebus://agents", "Vibe Bus Agents", "Registered CLI/IDE agents."),
    resource("vibebus://tasks", "Vibe Bus Tasks", "Shared task board."),
    resource("vibebus://messages", "Vibe Bus Messages", "Recent message bus traffic."),
    resource("vibebus://decisions", "Vibe Bus Decisions", "Recorded team decisions."),
    resource("vibebus://guide", "Vibe Bus Guide", "Agent coordination protocol."),
  ];
}

export function readResource(store, uri) {
  const state = store.read();

  if (uri === "vibebus://status") {
    return textResource(uri, {
      agents: Object.values(state.agents),
      open_tasks: state.tasks.filter((task) => ["open", "claimed", "blocked"].includes(task.status)),
      recent_messages: state.messages.slice(-25),
      recent_decisions: state.decisions.slice(-25),
    });
  }
  if (uri === "vibebus://agents") {
    return textResource(uri, Object.values(state.agents));
  }
  if (uri === "vibebus://tasks") {
    return textResource(uri, state.tasks);
  }
  if (uri === "vibebus://messages") {
    return textResource(uri, state.messages.slice(-100));
  }
  if (uri === "vibebus://decisions") {
    return textResource(uri, state.decisions);
  }
  if (uri === "vibebus://guide") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: [
            "# Vibe Bus Agent Protocol",
            "",
            "1. Register with `register_agent` at session start.",
            "2. Read `team_status`, `read_inbox`, and relevant `read_thread` context.",
            "3. Use `handoff_task` for required-ack delegation.",
            "4. Use `ack_message` when you accept or complete a handoff.",
            "5. Use `heartbeat` for progress and `record_decision` for durable choices.",
            "6. Use `wait_for_messages` with short timeouts only.",
          ].join("\n"),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
}

export function getPrompt(name, args = {}) {
  if (name === "vibebus-start") {
    return promptResult("Start Vibe Bus Session", [
      `Register as ${args.agent_id ?? "<agent_id>"} using cli=${args.cli ?? "<cli>"} and role=${args.role ?? "agent"}.`,
      "Then read team_status and unread inbox messages before doing work.",
    ]);
  }
  if (name === "vibebus-handoff") {
    return promptResult("Create Agent Handoff", [
      `Create a required-ack handoff from ${args.from ?? "<from>"} to ${args.to ?? "<to>"}.`,
      `Goal: ${args.goal ?? "<goal>"}`,
      "Use handoff_task and include files/task context when available.",
    ]);
  }
  if (name === "vibebus-review") {
    return promptResult("Request Review", [
      `Ask ${args.to ?? "<reviewer>"} to review work from ${args.from ?? "<from>"}.`,
      `Files: ${args.files ?? "<files or task id>"}`,
      "Use send_message with requires_ack=true and topic=review.",
    ]);
  }
  throw new Error(`Unknown prompt: ${name}`);
}

function resource(uri, name, description) {
  return { uri, name, title: name, description, mimeType: "application/json" };
}

function textResource(uri, data) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function promptResult(description, lines) {
  return {
    description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: lines.join("\n"),
        },
      },
    ],
  };
}
