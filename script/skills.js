const path = require('path');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { DATA_BASE_URL } = require('./base')

// Agent skills, MCP servers and AI agent tools, found the way AgentSkillsHub
// (https://github.com/zhuyansen/agent-skills-hub) does: GitHub repository searches on these
// topics, names and descriptions, up to 1,000 repos each, sorted by stars. Saved to data/skills/skills.json.
const QUERIES = [
  // Run every time by AgentSkillsHub
  'mcp-server in:name,topics',
  'claude-mcp in:name,description,topics',
  'model-context-protocol in:name,description,topics',
  'mcp in:topics language:python',
  'mcp in:topics language:typescript',
  'mcp-tool in:name,topics',
  'claude-skill in:name,description,topics',
  'claude-code in:topics',
  'agent-skill in:name,topics',
  'ai-agent-tool in:name,description,topics',
  '"agent skills" in:description stars:>50',
  'hyperframes in:name,description,topics',
  'remotion skill in:name,description,topics',
  'claude video skill in:name,description',
  // OpenClaw and NanoClaw
  'openclaw in:topics stars:>50',
  'openclaw-skills in:topics',
  'nanoclaw in:topics,name stars:>50',
  'clawdbot in:topics stars:>50',
  'clawhub in:topics',
  'openclaw-plugin in:topics stars:>50',
  // Run weekly by AgentSkillsHub
  'mcp-plugin in:name,description,topics',
  'claude-code-skill in:name,description,topics',
  'anthropic in:topics language:python',
  'anthropic in:topics language:typescript',
  'agent-tools in:name,description,topics',
  'llm-tool in:name,description,topics',
  'llm-agent in:name,topics stars:>10',
  'ai-tools in:topics stars:>20',
  'codex-skills in:name,description,topics',
  'codex-cli in:name,topics',
  'codex in:topics stars:>100',
  'agent-skills in:topics stars:>50',
  'openai-agent in:name,topics',
  'openai-tool in:name,topics',
  'gemini-agent in:name,topics',
  'gemini-tool in:name,description,topics',
  'function-calling in:topics language:python stars:>50',
  'tool-use in:topics language:typescript stars:>50',
  'ai-automation in:topics stars:>20'
];
// First match wins, checked against name, description and topics (AgentSkillsHub's categories, shortened).
const TYPES = [
  ['mcp', ['mcp', 'model-context-protocol', 'model context protocol']],
  ['claude', ['claude-skill', 'claude skill', 'claude-code', 'claude code', 'claude-plugin', 'claude desktop', 'claudekit']],
  ['codex', ['codex', 'openclaw', 'nanoclaw', 'clawdbot', 'clawhub', 'hermes-agent', 'hermes agent']],
  ['agent', ['agent-tool', 'ai-agent', 'ai agent', 'agent-skill', 'agent skill', 'agent framework', 'agent-framework',
    'multi-agent', 'multi agent', 'agentic', 'autonomous agent', 'coding agent', 'agent sdk', 'agent workflow']]
];
const FILE = path.resolve(__dirname, DATA_BASE_URL, 'skills', 'skills.json');
// AgentSkillsHub refreshes every 8 hours; the Action runs every 4, so every other run skips.
const EVERY_MS = 7.5 * 60 * 60 * 1000;
// Below this the searches return mostly empty or test repos, and the file would pass 10 MB.
const MIN_STARS = 10;
// Search allows 30 requests a minute.
const PAUSE_MS = 2500;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function searchPage (q, page, attempt = 1) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'github-trending-api',
      Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if ((res.status === 403 || res.status === 429) && attempt < 5) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
    await sleep(Math.max(Number(res.headers.get('retry-after')) * 1000 || 0, reset || 0, 10000 * attempt));
    return searchPage(q, page, attempt + 1);
  }
  if (!res.ok) throw new Error(`GitHub search ${res.status} for ${q}`);
  return res.json();
}

function skillType (repo) {
  const text = `${repo.full_name} ${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
  const found = TYPES.find(([, words]) => words.some(word => text.includes(word)));
  return found ? found[0] : text.includes('skill') ? 'skill' : 'tool';
}

function toEntry (repo) {
  return {
    name: repo.full_name,
    description: repo.description || '',
    language: repo.language || '',
    stars: repo.stargazers_count,
    topics: repo.topics || [],
    created: repo.created_at,
    pushed: repo.pushed_at,
    type: skillType(repo)
  };
}

async function updateSkills () {
  if (existsSync(FILE) && Date.now() - Date.parse(JSON.parse(readFileSync(FILE, 'utf8')).updated) < EVERY_MS) {
    return console.log('skills: updated recently, skipped');
  }
  const found = new Map();
  let failed = 0;
  for (const q of QUERIES) {
    try {
      for (let page = 1; page <= 10; page++) {
        const { items = [] } = await searchPage(q, page);
        for (const repo of items) {
          if (!repo.fork && !repo.archived && repo.stargazers_count >= MIN_STARS && !found.has(repo.full_name)) found.set(repo.full_name, toEntry(repo));
        }
        await sleep(PAUSE_MS);
        // Past here GitHub has no more results, or only repos below MIN_STARS.
        if (items.length < 100 || items[items.length - 1].stargazers_count < MIN_STARS) break;
      }
    } catch (error) {
      failed++;
      console.error('Error skills:', error.message);
    }
    console.log('skills', q, found.size);
  }
  // A run that mostly failed keeps the last good file instead of replacing it with a thin one.
  if (failed > QUERIES.length / 2) return console.error('skills: too many searches failed, file kept');
  const repos = [...found.values()].sort((a, b) => b.stars - a.stars);
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), repos }), 'utf-8');
  console.log('skills', repos.length, 'repos saved');
}

if (require.main === module) updateSkills();

module.exports = {
  updateSkills,
  skillType
}
