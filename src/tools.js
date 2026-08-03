import { acknowledgeWake, heartbeat, registerAgent, sleepAgent, wakeAgent, who } from "./agents.js";
import { askAgent, listAsks, pingAgent, replyToAsk, requestApproval, resolveApproval } from "./asks.js";
import {
  ackMessage,
  broadcast,
  channel,
  readInbox,
  readThread,
  sendMessage,
  sendToRole,
  tailEvents,
  waitForEvents,
  waitForMessages,
} from "./messaging.js";
import {
  claimTask,
  context,
  createTask,
  handoffTask,
  lease,
  listTasks,
  recordDecision,
  teamStatus,
  updateTask,
} from "./tasks.js";
import {
  KNOWN_CLIENTS,
  arrayProp,
  booleanProp,
  enumProp,
  numberProp,
  objectProp,
  objectSchema,
  recipientProp,
  stringProp,
} from "./shared.js";

const PRIORITY = ["low", "normal", "high", "urgent"];
const TASK_STATUS = ["open", "claimed", "blocked", "done", "cancelled"];

export const TOOL_DEFINITIONS = [
  {
    name: "known_clients",
    description: "List known CLI/IDE agent clients and the normalized client ids to use when registering.",
    inputSchema: objectSchema({}),
  },
  {
    name: "register_agent",
    description:
      "Register or update this agent on the shared bus and bind this MCP session to it. Binding is what lets other agents wake, ask, and ping you in real time.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Stable agent id, for example codex-main, claude-reviewer, antigravity-ui, grok-research."),
        cli: stringProp("Normalized client id. Examples: codex, claude, gemini, antigravity, grok, cursor, windsurf, continue, vscode, lmstudio, aider, goose, qwen, crush, amp.", false),
        provider: stringProp("Model/provider owner, for example openai, anthropic, google, xai, local.", false),
        model: stringProp("Active model name if known.", false),
        session_id: stringProp("Current CLI session/conversation id if known.", false),
        role: stringProp("Agent role or responsibility.", false),
        workspace: stringProp("Current workspace path.", false),
        capabilities: arrayProp("Short capability labels.", false),
        wake_command: stringProp("Shell command that relaunches this agent headlessly if it exits, e.g. 'claude -p \"check vibebus\"'. Used only by the process wake tier.", false),
        tmux_target: stringProp("tmux pane to type wakes into, e.g. '%3' or 'vibe:0.1'. Auto-detected from TMUX_PANE when running inside tmux; set VIBEBUS_TMUX=0 to opt out.", false),
        auto_wake: booleanProp("Allow the bus to wake this agent automatically when work arrives. Default true."),
      },
      ["agent_id"],
    ),
  },
  {
    name: "heartbeat",
    description: "Update this agent's status, progress, and current task so others can see it is alive.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Registered agent id."),
        status: stringProp("Status such as idle, working, blocked, reviewing.", false),
        note: stringProp("Short progress note.", false),
        task_id: stringProp("Current task id.", false),
        progress: numberProp("Percent complete, 0-100."),
        eta: stringProp("Rough completion estimate.", false),
      },
      ["agent_id"],
    ),
  },
  {
    name: "who",
    description: "Live presence board: which agents are online, idle, asleep, or offline, and how each one can be reached.",
    inputSchema: objectSchema({
      presence: enumProp(["online", "idle", "asleep", "stale", "offline"], "Filter by presence."),
      role: stringProp("Filter by role.", false),
    }),
  },
  {
    name: "send_message",
    description: "Send a directed message to one agent, a list of agents, or a channel. Sleeping or idle recipients are woken automatically.",
    inputSchema: objectSchema(
      {
        from: stringProp("Sender agent id."),
        to: recipientProp("Recipient agent id, '*' for broadcast visibility, or an array of agent ids. Omit when using channel."),
        channel: stringProp("Send to every member of this channel instead of explicit recipients.", false),
        message: stringProp("Message body."),
        priority: enumProp(PRIORITY, "Priority. high/urgent escalate the wake ladder."),
        topic: stringProp("Optional topic/thread label.", false),
        thread_id: stringProp("Existing thread id to attach this message to.", false),
        reply_to: stringProp("Message id this message replies to.", false),
        task_id: stringProp("Related task id.", false),
        files: arrayProp("Related file paths.", false),
        requires_ack: booleanProp("Require recipient acknowledgement."),
      },
      ["from", "message"],
    ),
  },
  {
    name: "send_to_role",
    description: "Send one message to all registered agents matching a role, CLI, or provider.",
    inputSchema: objectSchema(
      {
        from: stringProp("Sender agent id."),
        message: stringProp("Message body."),
        role: stringProp("Target agent role.", false),
        cli: stringProp("Target CLI id.", false),
        provider: stringProp("Target model/provider.", false),
        priority: enumProp(PRIORITY, "Priority."),
        topic: stringProp("Optional topic/thread label.", false),
        requires_ack: booleanProp("Require acknowledgements from recipients."),
        exclude_self: booleanProp("Exclude sender from recipients."),
      },
      ["from", "message"],
    ),
  },
  {
    name: "broadcast",
    description: "Broadcast an instruction or update to every registered agent.",
    inputSchema: objectSchema(
      {
        from: stringProp("Sender agent id."),
        message: stringProp("Message body."),
        priority: enumProp(PRIORITY, "Priority."),
        topic: stringProp("Optional topic/thread label.", false),
        thread_id: stringProp("Existing thread id to attach this message to.", false),
        reply_to: stringProp("Message id this message replies to.", false),
        task_id: stringProp("Related task id.", false),
        files: arrayProp("Related file paths.", false),
        requires_ack: booleanProp("Require recipient acknowledgement."),
        exclude_self: booleanProp("Exclude sender from inbox."),
      },
      ["from", "message"],
    ),
  },
  {
    name: "read_inbox",
    description: "Read messages visible to an agent. Can mark messages as read.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Agent id reading its inbox."),
        since_id: stringProp("Only return messages after this id.", false),
        unread_only: booleanProp("Only return messages after this agent's read cursor."),
        mark_read: booleanProp("Advance read cursor to latest returned message."),
        include_acked: booleanProp("Include messages this agent has already acknowledged."),
        topic: stringProp("Only messages with this topic.", false),
        priority: enumProp(PRIORITY, "Only messages at this priority."),
        limit: numberProp("Maximum messages to return."),
      },
      ["agent_id"],
    ),
  },
  {
    name: "wait_for_messages",
    description:
      "Block until new inbox messages arrive. Returns within milliseconds of another agent sending, not at a poll interval. Safe to use with long timeouts.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Agent id waiting on its inbox."),
        since_id: stringProp("Only return messages after this id.", false),
        unread_only: booleanProp("Only return messages after this agent's read cursor."),
        mark_read: booleanProp("Advance read cursor to latest returned message."),
        timeout_ms: numberProp("Maximum wait time in ms (default 15000, max 600000)."),
        limit: numberProp("Maximum messages to return."),
      },
      ["agent_id"],
    ),
  },
  {
    name: "ack_message",
    description: "Acknowledge receipt or completion of a message that requires acknowledgement. Also acknowledges the wake that delivered it.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Acknowledging agent id."),
        message_id: stringProp("Message id to acknowledge."),
        note: stringProp("Optional acknowledgement note.", false),
      },
      ["agent_id", "message_id"],
    ),
  },
  {
    name: "read_thread",
    description: "Read all visible messages in a message thread.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Agent id reading the thread."),
        thread_id: stringProp("Thread id."),
        mark_read: booleanProp("Advance read cursor to latest returned message."),
        limit: numberProp("Maximum messages to return."),
      },
      ["agent_id", "thread_id"],
    ),
  },
  {
    name: "channel",
    description: "Join, leave, or list topic channels. Messages sent with a channel reach every member.",
    inputSchema: objectSchema(
      {
        action: enumProp(["join", "leave", "list"], "Channel action."),
        agent_id: stringProp("Agent id performing the action. Not needed for list.", false),
        channel: stringProp("Channel name, for example frontend, review, deploy.", false),
      },
      ["action"],
    ),
  },
  {
    name: "tail_events",
    description: "Read the bus event journal from a cursor. Every message, task change, wake, lease, and decision appears here in order.",
    inputSchema: objectSchema({
      since_seq: numberProp("Return events after this sequence number. 0 for the beginning."),
      agent_id: stringProp("Only events this agent can see.", false),
      types: arrayProp("Filter to these event types, e.g. task.created, wake, message.", false),
      limit: numberProp("Maximum events to return."),
    }),
  },
  {
    name: "wait_for_events",
    description: "Block until new bus events appear. The generic real-time watch: use it to react to any team activity, not just your inbox.",
    inputSchema: objectSchema({
      since_seq: numberProp("Return events after this sequence number."),
      agent_id: stringProp("Only events this agent can see.", false),
      types: arrayProp("Filter to these event types.", false),
      timeout_ms: numberProp("Maximum wait time in ms (default 15000, max 600000)."),
      limit: numberProp("Maximum events to return."),
    }),
  },
  {
    name: "ask_agent",
    description:
      "Ask another agent a question and WAIT for its answer. Wakes the target, then blocks. Raises a no_reply error with diagnostics if nothing answers, so a dead agent is never mistaken for agreement.",
    inputSchema: objectSchema(
      {
        from: stringProp("Asking agent id."),
        to: stringProp("Agent id being asked."),
        question: stringProp("The question. Be specific and self-contained; the answering model may have no other context."),
        context: stringProp("Extra background to include with the question.", false),
        files: arrayProp("Relevant file paths.", false),
        urgency: enumProp(PRIORITY, "How hard to escalate the wake. Default high."),
        timeout_ms: numberProp("How long to wait for the answer (default 60000, max 600000)."),
        soft_fail: booleanProp("Return a result object instead of raising when no reply arrives."),
      },
      ["from", "to", "question"],
    ),
  },
  {
    name: "reply_to_ask",
    description: "Answer a question another agent is currently blocked on. Unblocks the asker immediately.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Answering agent id."),
        ask_id: stringProp("Ask id, shown in the inbox message that carried the question."),
        answer: stringProp("The answer.", false),
        decline: booleanProp("Decline instead of answering."),
        reason: stringProp("Reason when declining.", false),
      },
      ["agent_id", "ask_id"],
    ),
  },
  {
    name: "list_asks",
    description: "List questions waiting for an answer, or past answers.",
    inputSchema: objectSchema({
      agent_id: stringProp("Only asks involving this agent.", false),
      status: enumProp(["pending", "servicing", "answered", "declined", "expired"], "Filter by status."),
      limit: numberProp("Maximum asks to return."),
    }),
  },
  {
    name: "ping_agent",
    description:
      "Prove another agent is actually alive. A live session answers automatically without spending a model call. Raises agent_unreachable if nothing responds.",
    inputSchema: objectSchema(
      {
        from: stringProp("Pinging agent id."),
        to: stringProp("Agent id to ping."),
        timeout_ms: numberProp("How long to wait (default 5000, max 60000)."),
        soft_fail: booleanProp("Return a result object instead of raising when there is no answer."),
      },
      ["from", "to"],
    ),
  },
  {
    name: "wake_agent",
    description:
      "Wake a sleeping, idle, or offline agent. Escalates bus -> session push -> its model (MCP sampling) -> its human (MCP elicitation) -> relaunching its process, stopping at the first tier that can reach it.",
    inputSchema: objectSchema(
      {
        from: stringProp("Waking agent id."),
        to: stringProp("Agent id to wake."),
        reason: stringProp("Why it is being woken. This becomes the message it reads on waking.", false),
        urgency: enumProp(PRIORITY, "Higher urgency climbs the ladder faster. Default normal."),
        max_tier: enumProp(
          ["bus", "session", "model", "tmux", "human", "process"],
          "Do not escalate past this tier. Default process. Relaunching a process additionally requires VIBEBUS_ALLOW_SPAWN=1.",
        ),
        task_id: stringProp("Task this wake relates to.", false),
        payload: objectProp("Structured context handed to the woken agent."),
        wait_ms: numberProp("Wait this long for delivery confirmation before returning (default 0, max 30000)."),
        requires_ack: booleanProp("Require the woken agent to acknowledge."),
      },
      ["from", "to"],
    ),
  },
  {
    name: "sleep_agent",
    description:
      "Park this agent until something needs it. Returns the moment another agent wakes it, or when the block window ends. Cheaper and more responsive than polling in a loop.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Agent going to sleep."),
        reason: stringProp("Why it is idle, shown to the rest of the team.", false),
        duration_ms: numberProp("How long the sleep window lasts (default 300000, max 24h)."),
        block_ms: numberProp("How long this call blocks waiting for a wake (default 60000, max 600000)."),
        block: booleanProp("Set false to mark asleep and return immediately."),
        wake_on: objectProp("Filter for automatic wakes: { min_priority, from: [], topics: [] }."),
      },
      ["agent_id"],
    ),
  },
  {
    name: "request_approval",
    description:
      "Ask the human behind another agent's CLI to make a call, via MCP elicitation. Blocks until answered; raises no_reply on timeout.",
    inputSchema: objectSchema(
      {
        from: stringProp("Requesting agent id."),
        to: stringProp("Agent whose human should decide."),
        question: stringProp("The decision to make."),
        options: arrayProp("Choices to offer, default approve/reject.", false),
        detail: stringProp("Extra context for the human.", false),
        timeout_ms: numberProp("How long to wait (default 120000, max 600000)."),
        soft_fail: booleanProp("Return a result object instead of raising on timeout."),
      },
      ["from", "to", "question"],
    ),
  },
  {
    name: "resolve_approval",
    description: "Record the decision for a pending approval request.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Agent recording the decision."),
        approval_id: stringProp("Approval id."),
        action: stringProp("Chosen option, for example approve or reject."),
        content: objectProp("Structured answer, if the request asked for fields."),
      },
      ["agent_id", "approval_id", "action"],
    ),
  },
  {
    name: "create_task",
    description: "Create a shared task that any agent can claim or an assignee can handle.",
    inputSchema: objectSchema(
      {
        from: stringProp("Creator agent id."),
        title: stringProp("Short task title."),
        description: stringProp("Task details.", false),
        assignee: stringProp("Preferred assignee agent id. Assigning wakes them.", false),
        priority: enumProp(PRIORITY, "Priority."),
        files: arrayProp("Related file paths.", false),
        depends_on: arrayProp("Task ids that must finish first. The task starts blocked and unblocks itself automatically.", false),
      },
      ["from", "title"],
    ),
  },
  {
    name: "handoff_task",
    description: "Create/assign a task, send a required-ack handoff message, and wake the recipient, in one atomic update.",
    inputSchema: objectSchema(
      {
        from: stringProp("Sender agent id."),
        to: recipientProp("Recipient agent id or ids."),
        title: stringProp("Task title."),
        description: stringProp("Task details.", false),
        priority: enumProp(PRIORITY, "Priority."),
        files: arrayProp("Related file paths.", false),
        depends_on: arrayProp("Task ids that must finish first.", false),
        message: stringProp("Handoff message. Defaults to task description.", false),
        topic: stringProp("Topic/thread label.", false),
      },
      ["from", "to", "title"],
    ),
  },
  {
    name: "list_tasks",
    description: "List shared tasks, optionally filtered by status or assignee.",
    inputSchema: objectSchema({
      status: enumProp(TASK_STATUS, "Task status."),
      assignee: stringProp("Assigned or claimed agent id.", false),
      limit: numberProp("Maximum tasks to return."),
    }),
  },
  {
    name: "claim_task",
    description: "Claim an open task for an agent.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Claiming agent id."),
        task_id: stringProp("Task id."),
      },
      ["agent_id", "task_id"],
    ),
  },
  {
    name: "update_task",
    description: "Update task status, note, assignee, or related files. Finishing a task unblocks and wakes anything waiting on it.",
    inputSchema: objectSchema(
      {
        agent_id: stringProp("Updating agent id."),
        task_id: stringProp("Task id."),
        status: enumProp(TASK_STATUS, "New status."),
        note: stringProp("Progress note.", false),
        assignee: stringProp("Assignee agent id.", false),
        files: arrayProp("Related file paths.", false),
      },
      ["agent_id", "task_id"],
    ),
  },
  {
    name: "lease",
    description:
      "Claim files before editing them so two agents never write the same path at once. Leases expire on their own; conflicts raise lease_conflict naming the holder.",
    inputSchema: objectSchema(
      {
        action: enumProp(["acquire", "release", "list"], "Lease action."),
        agent_id: stringProp("Agent holding or releasing the lease.", false),
        paths: arrayProp("File or directory paths to claim.", false),
        reason: stringProp("What you are about to do to them.", false),
        task_id: stringProp("Related task id.", false),
        lease_id: stringProp("Specific lease to release. Omit to release all of this agent's leases.", false),
        ttl_ms: numberProp("Lease lifetime in ms (default 900000, max 4h)."),
      },
      ["action"],
    ),
  },
  {
    name: "context",
    description:
      "Shared blackboard for facts the whole team must agree on (chosen library, API base URL, schema decisions). Versioned, with compare-and-set.",
    inputSchema: objectSchema(
      {
        action: enumProp(["get", "set", "list", "delete"], "Context action."),
        agent_id: stringProp("Agent writing the entry.", false),
        key: stringProp("Context key.", false),
        value: objectProp("Value to store. Any JSON."),
        if_version: numberProp("Only write if the current version matches. Prevents silent clobbering."),
        note: stringProp("Why this value was chosen.", false),
      },
      ["action"],
    ),
  },
  {
    name: "record_decision",
    description: "Record a team decision so agents can align on constraints and choices.",
    inputSchema: objectSchema(
      {
        from: stringProp("Decision author agent id."),
        title: stringProp("Short decision title."),
        decision: stringProp("Decision text."),
        rationale: stringProp("Reasoning or tradeoff.", false),
        supersedes: stringProp("Decision id this replaces.", false),
      },
      ["from", "title", "decision"],
    ),
  },
  {
    name: "team_status",
    description: "Full picture: agent presence, open tasks, recent messages, events, leases, pending questions, and decisions.",
    inputSchema: objectSchema({
      limit: numberProp("Number of recent messages/events/decisions."),
    }),
  },
];

const HANDLERS = {
  known_clients: () => ({
    ok: true,
    clients: KNOWN_CLIENTS,
    note: "Use a custom cli value when your agent is not listed; Vibe Bus is MCP-client agnostic.",
  }),
  register_agent: registerAgent,
  heartbeat,
  who,
  send_message: sendMessage,
  send_to_role: sendToRole,
  broadcast,
  read_inbox: readInbox,
  wait_for_messages: waitForMessages,
  ack_message: ackMessage,
  read_thread: readThread,
  channel,
  tail_events: tailEvents,
  wait_for_events: waitForEvents,
  ask_agent: askAgent,
  reply_to_ask: replyToAsk,
  list_asks: listAsks,
  ping_agent: pingAgent,
  wake_agent: wakeAgent,
  sleep_agent: sleepAgent,
  ack_wake: acknowledgeWake,
  request_approval: requestApproval,
  resolve_approval: resolveApproval,
  create_task: createTask,
  handoff_task: handoffTask,
  list_tasks: listTasks,
  claim_task: claimTask,
  update_task: updateTask,
  lease,
  context,
  record_decision: recordDecision,
  team_status: teamStatus,
};

export async function callTool(store, name, input = {}, ctx = {}) {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(store, input, ctx);
}

export { KNOWN_CLIENTS };
