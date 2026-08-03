import { describeAgent } from "./presence.js";

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
    description: "Create a required-ack task handoff to another agent and wake it.",
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
  {
    name: "vibebus-standby",
    title: "Stand By On The Bus",
    description: "Park this agent so teammates can wake it the moment there is work.",
    arguments: [
      { name: "agent_id", description: "Agent going on standby.", required: true },
      { name: "reason", description: "What it is waiting for.", required: false },
    ],
  },
  {
    name: "vibebus-second-opinion",
    title: "Get A Second Opinion",
    description: "Ask an agent on a different model/provider to check a conclusion before acting on it.",
    arguments: [
      { name: "from", description: "Asking agent id.", required: true },
      { name: "question", description: "What to double-check.", required: true },
    ],
  },
];

export function listResources() {
  return [
    resource("vibebus://status", "Vibe Bus Status", "Agent presence, open tasks, recent messages, leases, and decisions."),
    resource("vibebus://agents", "Vibe Bus Agents", "Registered agents with presence and reachability."),
    resource("vibebus://tasks", "Vibe Bus Tasks", "Shared task board."),
    resource("vibebus://messages", "Vibe Bus Messages", "Recent message bus traffic."),
    resource("vibebus://events", "Vibe Bus Events", "The live event journal."),
    resource("vibebus://leases", "Vibe Bus Leases", "Files currently claimed by agents."),
    resource("vibebus://context", "Vibe Bus Context", "Shared blackboard of agreed facts."),
    resource("vibebus://decisions", "Vibe Bus Decisions", "Recorded team decisions."),
    resource("vibebus://guide", "Vibe Bus Guide", "Agent coordination protocol."),
  ];
}

export function readResource(store, uri) {
  const state = store.read();
  const now = Date.now();

  if (uri === "vibebus://status") {
    return textResource(uri, {
      bus_seq: state.seq,
      agents: Object.values(state.agents).map((agent) => describeAgent(agent, now)),
      open_tasks: state.tasks.filter((task) => ["open", "claimed", "blocked"].includes(task.status)),
      recent_messages: state.messages.slice(-25),
      recent_decisions: state.decisions.slice(-25),
      leases: state.leases,
      open_asks: state.asks.filter((ask) => ask.status === "pending"),
      pending_wakes: state.wakes.filter((wake) => wake.status === "pending"),
    });
  }
  if (uri === "vibebus://agents") {
    return textResource(uri, Object.values(state.agents).map((agent) => describeAgent(agent, now)));
  }
  if (uri === "vibebus://tasks") {
    return textResource(uri, state.tasks);
  }
  if (uri === "vibebus://messages") {
    return textResource(uri, state.messages.slice(-100));
  }
  if (uri === "vibebus://events") {
    return textResource(uri, { bus_seq: state.seq, events: state.events.slice(-200) });
  }
  if (uri === "vibebus://leases") {
    return textResource(uri, state.leases);
  }
  if (uri === "vibebus://context") {
    return textResource(uri, Object.values(state.context));
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
          text: GUIDE,
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
      "Subscribe to vibebus://status so you are notified as the team moves.",
    ]);
  }
  if (name === "vibebus-handoff") {
    return promptResult("Create Agent Handoff", [
      `Create a required-ack handoff from ${args.from ?? "<from>"} to ${args.to ?? "<to>"}.`,
      `Goal: ${args.goal ?? "<goal>"}`,
      "Use handoff_task and include files/task context. The recipient is woken automatically.",
      "If it must be answered before you continue, use ask_agent instead so you get a real answer or a real error.",
    ]);
  }
  if (name === "vibebus-review") {
    return promptResult("Request Review", [
      `Ask ${args.to ?? "<reviewer>"} to review work from ${args.from ?? "<from>"}.`,
      `Files: ${args.files ?? "<files or task id>"}`,
      "Use send_message with requires_ack=true and topic=review.",
    ]);
  }
  if (name === "vibebus-standby") {
    return promptResult("Stand By On The Bus", [
      `Call sleep_agent for ${args.agent_id ?? "<agent_id>"}${args.reason ? ` (reason: ${args.reason})` : ""}.`,
      "Do not poll in a loop. The call returns the moment a teammate wakes you, with your unread messages attached.",
    ]);
  }
  if (name === "vibebus-second-opinion") {
    return promptResult("Get A Second Opinion", [
      `Call who to find an online agent on a different provider than ${args.from ?? "<from>"}.`,
      `Then ask_agent that agent: ${args.question ?? "<question>"}`,
      "ask_agent blocks until it answers and raises no_reply if it cannot, so you never mistake silence for agreement.",
    ]);
  }
  throw new Error(`Unknown prompt: ${name}`);
}

const GUIDE = [
  "# Vibe Bus Agent Protocol",
  "",
  "## Session",
  "1. `register_agent` at session start. This binds the MCP connection to your agent id.",
  "2. `team_status` and `read_inbox` before doing work.",
  "3. `subscribe` to `vibebus://status` to receive push notifications as the team moves.",
  "",
  "## Working safely alongside other agents",
  "- `lease` the files you are about to edit. Releasing early is polite; leases expire on their own.",
  "- `context` holds facts everyone must agree on. Read before assuming, write with `if_version` to avoid clobbering.",
  "- `record_decision` for durable choices, not ordinary progress chatter.",
  "",
  "## Talking",
  "- `send_message` for notes, `ask_agent` when you need an actual answer before continuing.",
  "- `ask_agent` blocks and raises `no_reply` with diagnostics if nobody answers — silence is never treated as agreement.",
  "- `ping_agent` proves another agent is genuinely alive without spending a model call.",
  "",
  "## Idling and waking",
  "- `sleep_agent` instead of polling. You are woken within milliseconds when work arrives.",
  "- `wake_agent` to rouse a teammate. It escalates: bus -> session push -> its model -> its human -> relaunching it.",
  "- Sending high or urgent priority work to an idle agent wakes it automatically.",
  "",
  "## Tasks",
  "- One task, one owner, one completion condition. Use `depends_on` and let the bus unblock the chain.",
  "- Mark `blocked` with a note when waiting on someone; finishing a task wakes whoever was waiting.",
].join("\n");

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
