/**
 * E8: optional local-only read-only UI.
 *
 * No framework, no build step, no external requests. It binds to 127.0.0.1 and
 * only exposes GET endpoints; all mutations stay in the CLI.
 */
import { createServer } from 'node:http'

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Advisers</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.2rem}pre{background:#f5f5f5;padding:.8rem;overflow:auto;border-radius:6px}
nav a{margin-right:1rem}.muted{color:#777}</style>
<h1>Advisers · 本地只读视图</h1>
<p class="muted">仅监听 127.0.0.1；没有遥测、没有写路径。日常操作请用 CLI。</p>
<nav><a href="/api/today">today</a><a href="/api/commitments">commitments</a><a href="/api/who">who</a><a href="/api/reminders">reminders</a></nav>
<pre id="out">loading…</pre>
<script>
const path = location.hash ? location.hash.slice(1) : '/api/today';
async function load(p){const r=await fetch(p);document.getElementById('out').textContent=JSON.stringify(await r.json(),null,2)}
for(const a of document.querySelectorAll('nav a'))a.onclick=e=>{e.preventDefault();load(a.getAttribute('href'))};
load(path);
</script></html>`

export function createReadOnlyServer({ snapshot, host = '127.0.0.1', port = 0 } = {}) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end('read-only'); return }
    const url = new URL(req.url, `http://${host}`)
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(body)
    }
    try {
      if (url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8')
      if (url.pathname === '/api/today') return send(200, JSON.stringify(snapshot.today()))
      if (url.pathname === '/api/commitments') return send(200, JSON.stringify(snapshot.commitments()))
      if (url.pathname === '/api/who') return send(200, JSON.stringify(snapshot.who()))
      if (url.pathname === '/api/reminders') return send(200, JSON.stringify(snapshot.reminders()))
      send(404, JSON.stringify({ error: 'not found' }))
    } catch (error) { send(500, JSON.stringify({ error: error.message })) }
  })
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => resolve(`http://${host}:${server.address().port}`))
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
