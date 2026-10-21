// Local dev server: serves the static site and the /api functions.
// Usage: node server.js   (reads .env if present)   ->  http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// minimal .env loader (no dependencies)
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const STATIC = new Set(['/index.html', '/app.js', '/style.css', '/favicon.svg']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const api = url.pathname.match(/^\/api\/([a-z]+)$/);
    if (api) {
      const file = path.join(root, 'api', `${api[1]}.js`);
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
      const mod = await import(file);
      return await mod.default(req, res);
    }
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!STATIC.has(p)) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(p)] || 'application/octet-stream');
    fs.createReadStream(path.join(root, p)).pipe(res);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end('Server error');
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`VoiceCloser running at http://localhost:${port}`));
