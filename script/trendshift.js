const path = require('path');
const { existsSync, readFileSync } = require('fs');
const { DATA_BASE_URL } = require('./base')
const { save } = require('./save')

// Adds the live Trendshift rankings (https://trendshift.io) to the GitHub trending
// files, keeping only repos a file does not already list.
const SHIFT_URL = 'https://trendshift.io';
// Trendshift language filter -> file name used in this repo.
const LANGUAGES = {
  all: 'all', C: 'c', 'C++': 'c++', 'C#': 'c#', Dart: 'dart', Go: 'go', Java: 'java',
  JavaScript: 'javascript', Kotlin: 'kotlin', PHP: 'php', Python: 'python', Ruby: 'ruby',
  Rust: 'rust', Swift: 'swift', TypeScript: 'typescript', Zig: 'zig'
};
const SINCE = { daily: '/', weekly: '/weekly', monthly: '/monthly' };

// trendshift.io is a Next.js app: asking with the RSC header returns the page's
// React Server Components stream, which carries the ranking as an "initialData" JSON array.
function extractInitialData (text) {
  const match = /"initialData"\s*:\s*\[/.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  return null;
}

async function fetchRanking (since, language) {
  const query = language === 'all' ? '' : `?language=${encodeURIComponent(language)}`;
  const res = await fetch(`${SHIFT_URL}${SINCE[since]}${query}`, {
    headers: { RSC: '1', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = extractInitialData(await res.text());
  if (!Array.isArray(rows)) throw new Error('no ranking data in response');
  // An unknown filter falls back to the overall ranking, so keep only rows in that language.
  if (language === 'all') return rows;
  const wanted = language.toLowerCase();
  return rows.filter(row => (row.repository_language || row.language || '').toLowerCase() === wanted);
}

function toItem (row, colors) {
  const count = n => Number(n || 0).toLocaleString('en-US')
  const language = row.repository_language || row.language || '';
  return {
    title: row.full_name,
    url: `https://github.com/${row.full_name}`,
    description: row.repository_description || '',
    language,
    languageColor: colors.get(language) || '',
    stars: count(row.repository_stars),
    forks: count(row.repository_forks),
    addStars: count(row.repository_stars_gained),
    contributors: [],
    source: 'trendshift'
  };
}

async function addTrendshift () {
  const colors = new Map();
  for (const since of Object.keys(SINCE)) {
    for (const [shiftLanguage, language] of Object.entries(LANGUAGES)) {
      try {
        const file = path.resolve(__dirname, DATA_BASE_URL, since, `${language}.json`);
        // Drop rows a previous run added, so a failed GitHub fetch never keeps stale Trendshift rows.
        const items = existsSync(file)
          ? JSON.parse(readFileSync(file, 'utf8')).items.filter(item => item.source !== 'trendshift')
          : [];
        items.forEach(item => item.languageColor && colors.set(item.language, item.languageColor));
        const known = new Set(items.map(item => item.title.toLowerCase()));
        const added = (await fetchRanking(since, shiftLanguage))
          .filter(row => /^[\w.-]+\/[\w.-]+$/.test(row.full_name || '') && !known.has(row.full_name.toLowerCase()))
          .map(row => toItem(row, colors));
        await save([...items, ...added], since, language);
        console.log('trendshift', since, language, `+${added.length}`);
      } catch (error) {
        console.error(`Error trendshift ${since} ${language}:`, error.message);
      }
    }
  }
}

if (require.main === module) addTrendshift();

module.exports = {
  addTrendshift
}
