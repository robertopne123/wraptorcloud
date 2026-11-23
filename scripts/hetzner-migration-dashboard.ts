import { createServer } from "node:http";

export type ObjectProgress = {
  phase: string;
  key: string;
  fileBytes: number;
  phaseBytes: number;
};

export type MigrationProgress = {
  mode: "copy" | "inventory";
  state: "running" | "done" | "failed";
  phase: string;
  active: ObjectProgress[];
  totals: { objects: number; bytes: number; copied: number; verifiedExisting: number; failed: number };
  recent: { key: string; result: string }[];
};

const page = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wraptor Vault · Storage migration</title>
<style>
body{font:16px system-ui;background:#141619;color:#f5f6f7;margin:0}main{max-width:800px;margin:8vh auto;padding:0 24px}
h1{font-size:2rem}section{background:#23262b;border:1px solid #3e444d;border-radius:12px;padding:20px;margin:16px 0}
progress{display:block;width:100%;height:14px;accent-color:#70d3a7;margin-top:14px}p,li{overflow-wrap:anywhere}li{margin:.45em 0}
#status,#amount{color:#b9c2cc}h2{font-size:1rem;margin-top:0}
</style>
<main><h1>Wraptor Vault storage migration</h1><p id="status" role="status">Connecting…</p>
<section><h2 id="phase">Current transfers</h2><div id="active"></div></section>
<section><h2>Totals</h2><p id="totals"></p></section><section><h2>Recent results</h2><ul id="recent"></ul></section></main>
<script>
const byId = id => document.getElementById(id);
const bytes = value => new Intl.NumberFormat(undefined, {maximumFractionDigits:2}).format(value / 1048576) + ' MiB';
async function update() {
  try {
    const response = await fetch('/progress', {cache:'no-store'});
    if (!response.ok) throw new Error('Progress unavailable');
    const state = await response.json();
    const {objects, copied, verifiedExisting, failed} = state.totals;
    byId('status').textContent = (state.mode === 'copy' ? 'AWS → Hetzner copy' : 'Read-only inventory') + ' · ' + state.state;
    byId('phase').textContent = state.phase;
    byId('active').replaceChildren(...state.active.map(file => {
      const row = document.createElement('div');
      const label = document.createElement('p');
      label.textContent = file.phase + ' · ' + file.key;
      row.append(label);
      if (file.fileBytes) {
        const bar = document.createElement('progress');
        bar.setAttribute('aria-label', label.textContent);
        bar.max = file.fileBytes;
        bar.value = file.phaseBytes;
        const amount = document.createElement('p');
        amount.textContent = bytes(file.phaseBytes) + ' / ' + bytes(file.fileBytes);
        row.append(bar, amount);
      }
      return row;
    }));
    byId('totals').textContent = objects + ' found (' + bytes(state.totals.bytes) + ') · ' + copied + ' copied · ' + verifiedExisting + ' already verified · ' + failed + ' failed';
    byId('recent').replaceChildren(...state.recent.map(entry => {
      const item = document.createElement('li');
      item.textContent = entry.result + ' · ' + entry.key;
      return item;
    }));
  } catch {
    byId('status').textContent = 'Disconnected from the local migration command';
  }
  setTimeout(update, 1000);
}
update();
</script></html>`;

export async function startDashboard(progress: MigrationProgress) {
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && request.url === "/progress") {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(progress));
    } else if (request.method === "GET" && request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(page);
    } else {
      response.writeHead(404).end();
    }
  });
  const host = "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Dashboard address unavailable");
  console.log(`Migration dashboard: http://${host}:${address.port}/`);
}
