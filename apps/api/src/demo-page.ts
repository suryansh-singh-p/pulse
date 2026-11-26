// The demo page served at GET /. Plain HTML and JavaScript, no build step: it only calls
// the api's own endpoints (POST /events, GET /stats), so the pipeline can be shown in a
// browser. Kept in a .ts file so it is compiled into dist/ and ends up in the image.

/** Returns the page with the running version (image tag) filled in. */
export function demoPage(version: string): string {
  // The version comes from our own config, but never put unchecked text into HTML.
  const safeVersion = version.replace(/[^\w.-]/g, "").slice(0, 12) || "unknown";
  return PAGE.replace("%VERSION%", safeVersion);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pulse demo</title>
<style>
  :root { --bg: #f7f7f8; --card: #fff; --text: #1c1c1e; --muted: #6b6b70; --line: #e3e3e6;
          --accent: #2f6fed; --ok: #1f8a4c; --err: #c0362c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151517; --card: #1f1f22; --text: #f2f2f3; --muted: #9a9aa0; --line: #313136;
            --accent: #6b9bff; --ok: #4cc17f; --err: #ff6b5e; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h1 { font-size: 24px; margin: 0; }
  .version { font: 13px ui-monospace, monospace; color: var(--muted); }
  p.lead { color: var(--muted); margin: 4px 0 24px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
            padding: 20px; margin-bottom: 16px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
       margin: 0 0 12px; }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer;
           border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  button:hover { border-color: var(--accent); }
  button.burst { background: var(--accent); border-color: var(--accent); color: #fff; }
  #last { margin: 12px 0 0; font-size: 14px; color: var(--muted); min-height: 21px; }
  #last.ok { color: var(--ok); }
  #last.err { color: var(--err); }
  .counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
  .count { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .count .n { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .count .label { font-size: 13px; color: var(--muted); }
  #stats-note { margin: 12px 0 0; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Pulse demo</h1>
    <span class="version">version %VERSION%</span>
  </header>
  <p class="lead">Events go to the api, then Kafka, then the workers, which count them in Redis
    and save them to object storage.</p>

  <section>
    <h2>Send events</h2>
    <div class="buttons">
      <button data-type="page_view">page_view</button>
      <button data-type="click">click</button>
      <button data-type="purchase">purchase</button>
      <button class="burst" id="burst">Send 100 random</button>
    </div>
    <p id="last" role="status"></p>
  </section>

  <section>
    <h2>Counts (from Redis, updated every 2 s)</h2>
    <div class="counts" id="counts"></div>
    <p id="stats-note"></p>
  </section>
</main>
<script>
  const TYPES = ["page_view", "click", "purchase"];
  const last = document.getElementById("last");

  function show(text, kind) {
    last.textContent = text; // textContent, never innerHTML: data is shown, not run
    last.className = kind;
  }

  // One event. A small set of user ids, so Kafka spreads them over the 3 partitions
  // (the user id is the message key).
  async function sendOne(type) {
    const userId = "user-" + (1 + Math.floor(Math.random() * 20));
    const res = await fetch("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, userId, props: { source: "demo" } }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  document.querySelectorAll("button[data-type]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const { status, body } = await sendOne(button.dataset.type);
        if (status === 202) show("202 Accepted: " + button.dataset.type + ", id " + body.id, "ok");
        else show(status + ": " + (body.error || "request failed"), "err");
      } catch (err) {
        show("Network error: " + err.message, "err");
      }
    });
  });

  document.getElementById("burst").addEventListener("click", async () => {
    show("Sending 100 events...", "");
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => sendOne(TYPES[Math.floor(Math.random() * TYPES.length)])),
    );
    const accepted = results.filter((r) => r.status === "fulfilled" && r.value.status === 202).length;
    show(accepted + " of 100 accepted", accepted === 100 ? "ok" : "err");
  });

  // Polling: ask for the counts every 2 s. Simple, and fine for a demo.
  async function refreshStats() {
    const note = document.getElementById("stats-note");
    try {
      const res = await fetch("/stats");
      if (!res.ok) throw new Error("status " + res.status);
      const { counts, total } = await res.json();
      const box = document.getElementById("counts");
      box.replaceChildren();
      for (const [label, n] of [...TYPES.map((t) => [t, counts[t] || 0]), ["total", total]]) {
        const card = document.createElement("div");
        card.className = "count";
        const num = document.createElement("div");
        num.className = "n";
        num.textContent = n.toLocaleString();
        const name = document.createElement("div");
        name.className = "label";
        name.textContent = label;
        card.append(num, name);
        box.append(card);
      }
      note.textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (err) {
      note.textContent = "Stats unavailable (" + err.message + "), retrying...";
    }
  }
  refreshStats();
  setInterval(refreshStats, 2000);
</script>
</body>
</html>
`;
