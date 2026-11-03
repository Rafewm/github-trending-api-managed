const path = require('path');
const { existsSync, readFileSync } = require('fs');
const { DATA_BASE_URL } = require('./base')
const { save } = require('./save')

// Adds Trendshift's newest rankings (https://github.com/quantavil/trendshift) to the
// GitHub trending files, keeping only repos a file does not already list.
const SHIFT_URL = 'https://raw.githubusercontent.com/quantavil/trendshift/main/data';
// Trendshift language slug -> file name used in this repo.
const LANGUAGES = {
  all: 'all', c: 'c', cpp: 'c++', csharp: 'c#', dart: 'dart', go: 'go', java: 'java',
  javascript: 'javascript', kotlin: 'kotlin', php: 'php', python: 'python', ruby: 'ruby',
  rust: 'rust', swift: 'swift', typescript: 'typescript', zig: 'zig'
};
const SINCE = ['daily', 'weekly', 'monthly'];

// Each file holds the full history (1-2 MB) with the newest period first,
// so only its head is downloaded and cut at the last complete row.
async function fetchLatest (since, language) {
  const res = await fetch(`${SHIFT_URL}/${since}/${since}-${language}.json`, {
    headers: { Range: 'bytes=0-65535' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text = (await res.text()).trimEnd();
  if (!text.endsWith(']')) {
    const cut = text.lastIndexOf(',{"period_key"');
    if (cut < 0) throw new Error('unrecognized data');
    text = `${text.slice(0, cut)}]`;
  }
  const rows = JSON.parse(text);
  return rows.filter(row => row.period_key === rows[0].period_key);
}

function toItem (row, colors) {
  const count = n => Number(n || 0).toLocaleString('en-US')
  return {
    title: row.full_name,
    url: row.github_url,
    description: row.description || '',
    language: row.language || '',
    languageColor: colors.get(row.language) || '',
    stars: count(row.stars_total),
    forks: count(row.forks_total),
    addStars: count(row.stars_gained),
    contributors: [],
    source: 'trendshift'
  };
}

async function addTrendshift () {
  const colors = new Map();
  for (const since of SINCE) {
    for (const [shiftLanguage, language] of Object.entries(LANGUAGES)) {
      try {
        const file = path.resolve(__dirname, DATA_BASE_URL, since, `${language}.json`);
        // Drop rows a previous run added, so a failed GitHub fetch never keeps stale Trendshift rows.
        const items = existsSync(file)
          ? JSON.parse(readFileSync(file, 'utf8')).items.filter(item => item.source !== 'trendshift')
          : [];
        items.forEach(item => item.languageColor && colors.set(item.language, item.languageColor));
        const known = new Set(items.map(item => item.title.toLowerCase()));
        const added = (await fetchLatest(since, shiftLanguage))
          .filter(row => !known.has(row.full_name.toLowerCase()))
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
