import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { handleRepos, handleHn } from './repos.js';
import { handleHidden } from './hidden.js';

const PORT = Number(process.env.PORT) || 3210;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
// Keep in sync with vercel.json.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src https://avatars.githubusercontent.com; connect-src 'self'";

if (!process.env.UNSTARRED_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error('UNSTARRED_TOKEN is not set. Copy .env.example to .env and add your token.');
  process.exit(1);
}

// Loopback only: this process holds the token and shows your personal star filter.
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/repos') return handleRepos(req, res);
  if (path === '/api/hn') return handleHn(req, res);
  if (path === '/api/hidden') return handleHidden(req, res);
  const file = STATIC[path];
  if (!file) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': file[1], 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
  res.end(await readFile(new URL(`public/${file[0]}`, import.meta.url)));
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}`));
