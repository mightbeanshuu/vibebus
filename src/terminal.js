import { execFile, execFileSync } from "node:child_process";

/**
 * Typing a wake into another agent's actual terminal.
 *
 * This is the tier that matters in practice. An idle CLI agent is sitting at
 * its prompt doing nothing; MCP sampling runs a side-channel completion that
 * does not move its real session, and most clients do not support sampling
 * anyway. Putting text in its input box and pressing return is the only thing
 * that makes it genuinely pick the work back up.
 *
 * The MCP server's own stdio are pipes, so the controlling terminal belongs to
 * the parent process — the CLI that spawned us. Its tty path is the one stable
 * handle that identifies a pane across tmux, Terminal.app, and iTerm2.
 */
export function detectTerminal(env = process.env) {
  if (env.VIBEBUS_TERMINAL === "0") {
    return null;
  }

  const tty = detectTty();
  const program = env.TERM_PROGRAM ?? null;

  if (env.TMUX_PANE) {
    return { kind: "tmux", pane: env.TMUX_PANE, tty, program };
  }
  if (program === "Apple_Terminal") {
    return { kind: "apple_terminal", tty, program };
  }
  if (program === "iTerm.app") {
    return { kind: "iterm2", tty, program };
  }
  if (tty) {
    // Unknown emulator: record it anyway so `who` can report why it is not
    // reachable rather than staying silent about it.
    return { kind: "unknown", tty, program };
  }
  return null;
}

/**
 * Find the terminal this agent is really sitting in.
 *
 * The MCP server's own stdio are pipes, and its immediate parent is often an
 * intermediate `node` rather than the CLI itself, so we walk up the process
 * tree until something owns a tty. That tty is the handle every terminal
 * emulator can be addressed by.
 */
function detectTty(startPid = process.ppid, maxHops = 6) {
  let pid = startPid;

  for (let hop = 0; hop < maxHops && pid && pid > 1; hop++) {
    try {
      const raw = execFileSync("ps", ["-o", "ppid=,tty=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
      if (!raw) {
        return null;
      }

      const [parent, tty] = raw.split(/\s+/);
      if (tty && tty !== "??" && tty !== "-") {
        return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
      }
      pid = Number.parseInt(parent, 10);
    } catch {
      return null;
    }
  }

  return null;
}

export function canType(terminal) {
  return Boolean(terminal && (terminal.kind === "tmux" || ((terminal.kind === "apple_terminal" || terminal.kind === "iterm2") && terminal.tty)));
}

/**
 * Send `text` to a terminal as if the user typed it, followed by return.
 * Callback style so the caller never blocks the bus on an AppleScript round trip.
 */
export function typeIntoTerminal(terminal, text, done = () => {}) {
  if (!canType(terminal)) {
    done({ ok: false, error: `No typable terminal registered (kind: ${terminal?.kind ?? "none"}).` });
    return;
  }

  if (terminal.kind === "tmux") {
    // Literal mode, then a separate Enter, so nothing in the text is
    // interpreted as a key sequence.
    execFile("tmux", ["send-keys", "-t", terminal.pane, "-l", text], (error) => {
      if (error) {
        done({ ok: false, error: error.message, method: "tmux" });
        return;
      }
      execFile("tmux", ["send-keys", "-t", terminal.pane, "Enter"], (enterError) => {
        done(enterError ? { ok: false, error: enterError.message, method: "tmux" } : { ok: true, method: "tmux", target: terminal.pane });
      });
    });
    return;
  }

  const script = terminal.kind === "apple_terminal" ? appleTerminalScript(terminal.tty, text) : itermScript(terminal.tty, text);

  execFile("osascript", ["-e", script], { timeout: 10_000 }, (error, stdout) => {
    if (error) {
      done({
        ok: false,
        method: terminal.kind,
        error: /not allowed|assistive|1743/i.test(error.message)
          ? "macOS blocked the keystroke. Grant Automation/Accessibility permission to the terminal app in System Settings > Privacy & Security."
          : error.message,
      });
      return;
    }
    if (String(stdout).trim() === "notfound") {
      done({ ok: false, method: terminal.kind, error: `No open tab is attached to ${terminal.tty} any more.` });
      return;
    }
    done({ ok: true, method: terminal.kind, target: terminal.tty });
  });
}

/**
 * `do script ... in <tab>` writes the text into that tab's tty and submits it,
 * which is exactly a paste-and-return into whatever TUI is in the foreground.
 */
function appleTerminalScript(tty, text) {
  return `
set target to "${escapeForAppleScript(tty)}"
set payload to "${escapeForAppleScript(text)}"
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      try
        if (tty of t) is target then
          do script payload in t
          return "ok"
        end if
      end try
    end repeat
  end repeat
end tell
return "notfound"`;
}

function itermScript(tty, text) {
  return `
set target to "${escapeForAppleScript(tty)}"
set payload to "${escapeForAppleScript(text)}"
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          if (tty of s) is target then
            tell s to write text payload
            return "ok"
          end if
        end try
      end repeat
    end repeat
  end repeat
end tell
return "notfound"`;
}

function escapeForAppleScript(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

/**
 * The text an agent actually receives.
 *
 * This lands directly in the agent's prompt and is submitted, so it has to be a
 * complete, self-contained brief — not a notification. "Go check your inbox"
 * costs a round trip and usually stalls waiting for its human; the whole point
 * is that the agent can start working from this text alone.
 *
 * Different kinds of bus traffic need different instructions, so the prompt is
 * built per kind rather than one generic nudge.
 */
export function buildWakePrompt({ agentId, from, reason, urgency, kind = "message", payload = null, askId = null }) {
  const header = `[Vibe Bus] ${urgency === "urgent" ? "URGENT " : ""}${from} -> ${agentId}.`;
  const autonomy = "Do not wait for me to prompt you — act on this now, then report back on the bus.";

  if (kind === "ask" || askId) {
    return [
      header,
      reason ? `Question: ${reason}` : null,
      `${from} is BLOCKED waiting on your answer.`,
      `Answer now: reply_to_ask(agent_id:"${agentId}", ask_id:"${askId}", answer:"...").`,
      autonomy,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (kind === "task" && payload?.task) {
    const task = payload.task;
    return [
      header,
      `You have been assigned ${task.id}: ${task.title}.`,
      task.description ? `Brief: ${task.description}` : null,
      task.files?.length ? `Files: ${task.files.join(", ")}.` : null,
      `Start now: claim_task(agent_id:"${agentId}", task_id:"${task.id}").`,
      `Take a lease on files before editing them: lease(action:"acquire", agent_id:"${agentId}", paths:[...], task_id:"${task.id}").`,
      `Save anything another agent would otherwise redo: artifact(action:"put", agent_id:"${agentId}", key:"${task.id}/<name>", task_id:"${task.id}", summary:"...", content:"...").`,
      `Finish with update_task(agent_id:"${agentId}", task_id:"${task.id}", status:"done", note:"...").`,
      autonomy,
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (kind === "approval" && payload?.approval) {
    return [
      header,
      `Decision needed: ${payload.approval.question}`,
      `Options: ${(payload.approval.options ?? ["approve", "reject"]).join(", ")}.`,
      `Answer: resolve_approval(agent_id:"${agentId}", approval_id:"${payload.approval.id}", action:"...").`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    header,
    reason ? `Reason: ${reason}` : null,
    `Run read_inbox(agent_id:"${agentId}", unread_only:true, mark_read:true), handle it, then ack_message.`,
    autonomy,
  ]
    .filter(Boolean)
    .join(" ");
}
