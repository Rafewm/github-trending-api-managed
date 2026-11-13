import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { handleRepos, handleHn, handleReleases, handleNew, handleSkills } from './repos.js';
import { handleHidden, handleTracked } from './hidden.js';

// Above 15000, outside Windows' dynamic port range here (1024-15000), so Hyper-V/WSL never reserve it.
const PORT = Number(process.env.PORT) || 18210;
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
  if (path === '/api/skills') return handleSkills(req, res);
  if (path === '/api/new') return handleNew(req, res);
  if (path === '/api/releases') return handleReleases(req, res);
  if (path === '/api/hidden') return handleHidden(req, res);
  if (path === '/api/tracked') return handleTracked(req, res);
  const file = STATIC[path];
  if (!file) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': file[1], 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
  res.end(await readFile(new URL(`public/${file[0]}`, import.meta.url)));
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}`));
