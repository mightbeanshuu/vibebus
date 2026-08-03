import http from "node:http";

import { describeAgent } from "./presence.js";

/**
 * Optional localhost dashboard.
 *
 * Nothing depends on it — the bus works with no daemon at all — but when you
 * are running four agents at once, watching the journal stream in a browser
 * beats reading four terminals. Server-sent events ride the same watcher the
 * agents use, so the page updates the instant the state file changes.
 */
export function startDashboard(store, { port = 7717, host = "127.0.0.1" } = {}) {
  const clients = new Set();

  const unsubscribe = store.onChange(() => {
    const state = store.read();
    const payload = JSON.stringify(snapshot(state));
    for (const client of clients) {
      client.write(`event: state\ndata: ${payload}\n\n`);
    }
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }

    if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot(store.read()), null, 2));
      return;
    }

    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot(store.read()))}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, host);

  return {
    url: `http://${host}:${port}`,
    close() {
      unsubscribe();
      for (const client of clients) {
        client.end();
      }
      server.close();
    },
  };
}

function snapshot(state) {
  const now = Date.now();
  return {
    seq: state.seq,
    agents: Object.values(state.agents).map((agent) => describeAgent(agent, now)),
    tasks: state.tasks.filter((task) => ["open", "claimed", "blocked"].includes(task.status)).slice(-25),
    events: state.events.slice(-80).reverse(),
    leases: state.leases,
    asks: state.asks.filter((ask) => ask.status === "pending" || ask.status === "servicing"),
    wakes: state.wakes.slice(-15).reverse(),
    dead_letters: state.messages.filter((message) => message.dead_lettered).length,
    decisions: state.decisions.slice(-8).reverse(),
  };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vibe Bus</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0c10; --panel: #12151c; --line: #1e2430; --text: #e6e9ef;
    --dim: #8b93a5; --accent: #5eead4; --warn: #fbbf24; --bad: #f87171; --ok: #4ade80;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-size: 13px; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
  .seq { color: var(--dim); }
  main { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(340px, 1.4fr); gap: 16px; padding: 16px 20px; align-items: start; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 16px; }
  h2 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); margin: 0 0 10px; font-weight: 600; }
  .row { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid #171b24; }
  .row:last-child { border-bottom: 0; }
  .id { color: var(--accent); }
  .dim { color: var(--dim); }
  .pill { font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); text-transform: uppercase; letter-spacing: .06em; }
  .online { color: var(--ok); border-color: #1f4034; }
  .asleep { color: var(--warn); border-color: #40351f; }
  .idle, .stale { color: var(--warn); border-color: #40351f; }
  .offline { color: var(--bad); border-color: #402020; }
  .feed { max-height: 74vh; overflow-y: auto; }
  .ev { display: grid; grid-template-columns: 52px 128px 1fr; gap: 10px; padding: 4px 0; border-bottom: 1px solid #171b24; }
  .ev b { font-weight: 500; color: var(--accent); }
  .wake b { color: var(--warn); }
  .empty { color: var(--dim); padding: 6px 0; }
  .stat { display: flex; gap: 18px; flex-wrap: wrap; }
  .stat div span { color: var(--dim); }
</style>
</head>
<body>
<header>
  <h1>Vibe Bus</h1>
  <div class="seq">seq <b id="seq">—</b></div>
  <div class="stat" id="stats"></div>
</header>
<main>
  <div>
    <section><h2>Agents</h2><div id="agents"></div></section>
    <section><h2>Open tasks</h2><div id="tasks"></div></section>
    <section><h2>Leases</h2><div id="leases"></div></section>
    <section><h2>Waiting on an answer</h2><div id="asks"></div></section>
  </div>
  <section><h2>Live journal</h2><div class="feed" id="events"></div></section>
</main>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const el = (id) => document.getElementById(id);
const empty = (msg) => '<div class="empty">' + msg + '</div>';

new EventSource("/api/stream").addEventListener("state", (e) => render(JSON.parse(e.data)));

function render(s) {
  el("seq").textContent = s.seq;
  el("stats").innerHTML = [
    '<div><span>agents</span> ' + s.agents.length + '</div>',
    '<div><span>tasks</span> ' + s.tasks.length + '</div>',
    '<div><span>leases</span> ' + s.leases.length + '</div>',
    '<div><span>dead letters</span> ' + s.dead_letters + '</div>',
  ].join("");

  el("agents").innerHTML = s.agents.length ? s.agents.map((a) =>
    '<div class="row"><span class="id">' + esc(a.agent_id) + '</span>' +
    '<span class="pill ' + a.presence + '">' + a.presence + '</span>' +
    '<span class="dim">' + esc(a.cli) + ' · ' + esc(a.role) + '</span>' +
    '<span class="dim" style="margin-left:auto">' + (a.seconds_since_seen ?? "?") + 's</span></div>'
  ).join("") : empty("no agents registered");

  el("tasks").innerHTML = s.tasks.length ? s.tasks.map((t) =>
    '<div class="row"><span class="id">' + esc(t.id) + '</span><span class="pill">' + t.status + '</span>' +
    '<span>' + esc(t.title) + '</span><span class="dim" style="margin-left:auto">' + esc(t.assignee ?? "unclaimed") + '</span></div>'
  ).join("") : empty("no open tasks");

  el("leases").innerHTML = s.leases.length ? s.leases.map((l) =>
    '<div class="row"><span class="id">' + esc(l.agent_id) + '</span><span>' + esc(l.paths.join(", ")) + '</span></div>'
  ).join("") : empty("no files claimed");

  el("asks").innerHTML = s.asks.length ? s.asks.map((a) =>
    '<div class="row"><span class="id">' + esc(a.from) + '</span><span class="dim">→</span>' +
    '<span class="id">' + esc(a.to) + '</span><span>' + esc(a.question) + '</span></div>'
  ).join("") : empty("nobody is blocked");

  el("events").innerHTML = s.events.map((e) =>
    '<div class="ev' + (e.type === "wake" ? " wake" : "") + '"><span class="dim">' + e.seq + '</span>' +
    '<b>' + esc(e.type) + '</b><span class="dim">' + esc(e.actor ?? "bus") + ' ' +
    esc(e.data && (e.data.preview || e.data.title || e.data.reason) || e.ref || "") + '</span></div>'
  ).join("");
}
</script>
</body>
</html>`;
