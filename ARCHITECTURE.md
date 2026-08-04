# Architecture

How Vibe Bus works, and why each decision was made. Written for someone deciding whether the
engineering is sound, so it includes the tradeoffs and the limits, not only the wins.

## The shape of the thing

There is no server. Each CLI launches its own copy of a stdio MCP server as a subprocess, and every one
of those processes reads and writes a single JSON file:

```
~/.vibebus/state.json       the shared state
~/.vibebus/state.json.seq   a sidecar holding only the sequence number
~/.vibebus/state.json.lock  a lock directory
~/.vibebus/cache/           artifact contents, kept out of the hot file
```

If every CLI is closed, nothing is running and nothing is down. That property is the reason for most of
what follows.

## Concurrency: one lock, held briefly

`store.update(mutator)` is the only write path. It takes an exclusive lock, re-reads state from disk,
applies the mutation, sweeps, writes atomically via temp-file-plus-rename, and releases.

```js
withLock(lockPath, () => {
  const state = readState(statePath);   // fresh read, inside the lock
  const result = mutator(state);
  sweep(state, limits);
  writeState(statePath, seqPath, state);
});
```

Because the read happens inside the same critical section as the write, check-then-set cannot straddle
two different states. Every claim in the system — claiming a task, claiming a wake tier, claiming a flow
step, granting a lease — is that same pattern, so none of them need version numbers or CAS tokens.

**The lock is held for bookkeeping only, never for work.** Claiming a flow step takes milliseconds; the
agent then thinks, edits, and runs tests entirely outside the lock, with ownership tracked by a lease
expiry rather than a held lock. A crashed agent cannot wedge the machine: the lock records its pid, and
any process finding a lock owned by a dead pid, or older than ten seconds, reclaims it.

**Corrupt state degrades instead of cascading.** A half-written or hand-edited file is copied aside for
forensics and replaced with a fresh document, rather than throwing in every agent on the machine.

## Real-time: a journal and a sidecar

Every mutation appends to an event journal carrying a monotonic `seq`. A process tracks one integer, so
"what did I miss?" is a slice.

The problem with polling a JSON file is that answering "did anything change?" costs a full parse. So
every write also stamps the sequence number into a tiny sidecar file. Watchers read a few bytes, compare
one integer, and only parse the document when it actually moved.

Waiting is `fs.watch` on the state directory, with a slow interval as a safety net for filesystems where
watch events are unreliable. Measured cross-process wake latency is single-digit milliseconds, against a
250ms floor when this was a poll loop. Idle waiting costs nothing.

## Bidirectional MCP

Most MCP servers only answer. This one also starts conversations:

| Direction | Mechanism | Used for |
| --- | --- | --- |
| server → client | `notifications/resources/updated` | subscribed clients see team activity |
| server → client | `notifications/message` | live journal streaming into the client UI |
| server → client | `notifications/progress` | status while a call blocks |
| server → client | `sampling/createMessage` | running another agent's model with no human |
| server → client | `elicitation/create` | putting a decision in front of another agent's human |

The transport therefore has to handle inbound *responses*, not just requests: a message with an `id` and
a `result` but no `method` is routed back to the outbound request waiting on it.

A per-process pump watches the bus while the client is idle and turns incoming work into outbound
traffic — auto-answering liveness pings, answering other agents' questions via sampling, and delivering
wakes.

## The wake ladder

The hard problem is not delivering a message. It is that the recipient is an interactive CLI sitting at
a prompt, doing nothing, with no reason to look.

| Tier | Mechanism | Reaches |
| --- | --- | --- |
| `bus` | journal write | anything parked in a `wait_*` call |
| `session` | `notifications/message` | a live MCP session |
| `model` | `sampling/createMessage` | the agent's model, no human needed |
| `terminal` | `tmux send-keys`, or AppleScript for Terminal.app / iTerm2 | the agent's real prompt |
| `human` | `elicitation/create` | the person behind that CLI |
| `process` | `claude -p`, `codex exec`, `gemini -p` | an agent that has exited |

`planWake` picks the tiers from presence and reachability and stops at the first that lands.

**The honest part:** MCP sampling and elicitation support is still uneven across clients in 2026, so the
`model` and `human` tiers frequently do not exist. The `terminal` and `process` tiers are what make
waking work everywhere. The terminal tier finds the agent's tty by walking up the process tree — the MCP
server's own stdio are pipes and its parent is often an intermediate `node` — then addresses that tty
through whichever emulator owns it.

**A wake is not a notification.** It carries its kind, so a task handoff arrives as the complete brief —
id, title, description, files, the exact calls to make, and an explicit instruction not to wait for a
human prompt. Telling an idle agent to "check your inbox" costs a round trip and usually stalls.

**Wakes are budgeted.** A wake can start a model turn, and that turn can wake someone else. Automatic
wakes are refused if the target woke the requester in the last two minutes, and all wakes are capped per
hour. A manual `wake_agent` is budget-capped but never loop-blocked, because that is a human decision.

## Failing loudly

The worst outcome for a coordination bus is looking healthy while nothing is delivered. Every failure is
a typed `BusError` carrying a code, an HTTP-shaped status, a hint naming the next action, and diagnostics
about what the target looked like at the time.

- `ask_agent` raises `no_reply` rather than returning an empty result.
- `ping_agent` raises `agent_unreachable`, and says explicitly that the bus is fine and nobody is home.
- Required-ack messages nobody acknowledged become visible dead letters.
- `vibebus doctor` separates "the state file is not writable" from "no agent has a live session".

## Conflict control

Advisory leases, because nothing can actually prevent another process writing a file.

- **Read leases share, write leases are exclusive.** A single exclusive mode made leases unusable past
  two agents, since readers blocked readers.
- **`wait_ms` queues instead of failing**, with FIFO fairness so a waiter is not starved by later
  arrivals.
- **Wait-for cycles are detected** and raised as a `deadlock` naming the cycle, instead of letting both
  agents burn their full timeout and both fail.
- **`guard: true` records content hashes.** `verify` then reports anyone who edited those paths without
  holding the lease, as `stale_read`. Since leases are advisory, this is the only way to catch a bypass.
- Leases attached to a task are released when the task finishes.

## Flows

A flow is a portable multi-agent program written against roles rather than agents.

Definitions are authored as a readable tree and compiled once, at start, into a flat map of steps with
explicit dependencies — the scheduler only ever asks "what is runnable now?", and a flat map answers that
without walking a tree. Cycles, duplicate ids, and unknown step types are rejected at definition time.

**There is no scheduler process.** `advance_flow` is the scheduler, and it executes inside whichever
agent calls it next. Engine-driven steps (`ask`, `quorum`, `debate`, `approve`, `exec`, `wait_for`,
`decide`) run immediately on claim; a `task` step is returned to the caller as an assignment.

Templates resolve by dotted path only — never `eval` — because a flow definition lives in a
world-readable file that any local process can write. Conditions are a small comparator grammar for the
same reason.

Role constraints resolve at claim time against reality, not at authoring time. This is what makes
`exclude_provider: ["${steps.build.claim.provider}"]` mean "a different vendor than whoever *actually*
implemented it". Completed steps deliberately retain their claim record so that reference survives.

## What this is not

- **Not distributed.** The file lock does not span hosts. One machine, by design.
- **Not high throughput.** Every mutation rewrites the whole document under a lock. Correct for a handful
  of agents on a laptop; the wrong tool at thousands of operations per second.
- **Not a replacement for git.** Leases are advisory and coordination-level; they do not version content.
- **Not fully crash-transactional.** Individual mutations are atomic and step claims are exactly-once,
  but a multi-step consequence — a quorum's adjudication, a flow's action list — is resumable rather than
  transactional. Two-phase commit over a JSON file with no daemon is out of scope, and claiming otherwise
  would be false.
- **Not dependent on MCP sampling.** It uses it where available and degrades honestly where it is not.

## Testing

36 tests covering the store, transport, wake ladder, blocking calls, lease conflicts and deadlocks, the
shared cache, flow scheduling, and cross-vendor quorum. Two bugs found by tests rather than review:

- A `decide` step reported done the moment it *chose* a branch, so the parent sequence completed and the
  run declared success while the chosen branch was still pending.
- A detected deadlock was computed and then discarded by the wait path, so callers still sat in the queue
  until timeout.

One bug found by the demo: `report_step` cleared a completed step's claim, which silently broke
`exclude_provider` — the flagship cross-vendor routing feature — because the provider it referenced no
longer existed.
