import fs from "node:fs";
import path from "node:path";

/**
 * Change detection for the shared bus state.
 *
 * Every process that touches the bus writes a tiny sidecar file containing only
 * the monotonic sequence number. Watchers read that instead of reparsing the
 * whole state document, so "did anything happen?" costs a few bytes.
 *
 * fs.watch gives sub-millisecond wakeups; the interval is a safety net for
 * filesystems where watch events are unreliable (network mounts, some Docker
 * bind mounts).
 */
export function createFileWatcher({ statePath, seqPath, pollMs = 500 }) {
  const dir = path.dirname(statePath);
  const listeners = new Set();
  let watcher = null;
  let timer = null;
  let started = false;
  let lastSeq = readSeq();

  function readSeq() {
    try {
      const parsed = Number.parseInt(fs.readFileSync(seqPath, "utf8").trim(), 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    } catch {
      // fall through to the full document
    }

    try {
      const raw = fs.readFileSync(statePath, "utf8");
      if (!raw.trim()) {
        return 0;
      }
      const parsed = JSON.parse(raw);
      return Number.isFinite(parsed?.seq) ? parsed.seq : 0;
    } catch {
      return 0;
    }
  }

  function check() {
    const seq = readSeq();
    if (seq !== lastSeq) {
      lastSeq = seq;
      notify(seq);
    }
    return seq;
  }

  function notify(seq) {
    for (const listener of [...listeners]) {
      try {
        listener(seq);
      } catch {
        // a broken listener must not take the bus down
      }
    }
  }

  function start() {
    if (started) {
      return;
    }
    started = true;

    try {
      watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename || filename.startsWith(path.basename(statePath))) {
          check();
        }
      });
    } catch {
      watcher = null;
    }

    timer = setInterval(check, pollMs);
    timer.unref?.();
  }

  return {
    start,
    current() {
      return check();
    },
    peek() {
      return lastSeq;
    },
    /** Called by the store right after a local write so this process reacts instantly. */
    touch(seq) {
      if (Number.isFinite(seq) && seq !== lastSeq) {
        lastSeq = seq;
        notify(seq);
        return seq;
      }
      return check();
    },
    onChange(listener) {
      start();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForChange(sinceSeq, timeoutMs = 1500) {
      return waitForChange({ start, check, listeners }, sinceSeq, timeoutMs);
    },
    close() {
      watcher?.close();
      watcher = null;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      listeners.clear();
      started = false;
    },
  };
}

/** In-process equivalent used by tests and the memory store. */
export function createMemoryWatcher() {
  const listeners = new Set();
  let lastSeq = 0;

  const notify = (seq) => {
    for (const listener of [...listeners]) {
      try {
        listener(seq);
      } catch {
        // ignore
      }
    }
  };

  return {
    start() {},
    current() {
      return lastSeq;
    },
    peek() {
      return lastSeq;
    },
    touch(seq) {
      if (Number.isFinite(seq) && seq !== lastSeq) {
        lastSeq = seq;
        notify(seq);
      }
      return lastSeq;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForChange(sinceSeq, timeoutMs = 1500) {
      return waitForChange({ start() {}, check: () => lastSeq, listeners }, sinceSeq, timeoutMs);
    },
    close() {
      listeners.clear();
    },
  };
}

function waitForChange({ start, check, listeners }, sinceSeq, timeoutMs) {
  start();
  const baseline = Number.isFinite(sinceSeq) ? sinceSeq : -1;
  const current = check();
  if (current > baseline) {
    return Promise.resolve(current);
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      listeners.delete(onSeq);
      clearTimeout(timer);
      resolve(value);
    };

    const onSeq = (seq) => {
      if (seq > baseline) {
        finish(seq);
      }
    };

    listeners.add(onSeq);
    // Deliberately not unref'd: a caller waiting on the bus should keep the
    // process alive for the duration of its own wait.
    const timer = setTimeout(() => finish(check()), Math.max(0, timeoutMs));
  });
}
