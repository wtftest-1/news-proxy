const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');

const app = express();
// Google News requires a browser-like User-Agent
const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
});
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Feed sources ────────────────────────────────────────────────────────────
// Google News RSS aggregates from Le Soir, L'Echo, RTBF, Paperjam, etc.
const FEEDS = [
  {
    url: 'https://news.google.com/rss/search?q=immobilier+belgique&hl=fr&gl=BE&ceid=BE:fr',
    source: 'Google News BE',
    region: 'belgique',
  },
  {
    url: 'https://news.google.com/rss/search?q=logement+belgique&hl=fr&gl=BE&ceid=BE:fr',
    source: 'Google News BE',
    region: 'belgique',
  },
  {
    url: 'https://news.google.com/rss/search?q=immobilier+luxembourg&hl=fr&gl=LU&ceid=LU:fr',
    source: 'Google News LU',
    region: 'luxembourg',
  },
  {
    url: 'https://news.google.com/rss/search?q=immobilier+france&hl=fr&gl=FR&ceid=FR:fr',
    source: 'Google News FR',
    region: 'france',
  },
  {
    url: 'https://www.lefigaro.fr/rss/figaro_economie.xml',
    source: 'Le Figaro',
    region: 'france',
  },
];

// ── Keyword list ─────────────────────────────────────────────────────────────
// Phrases first (longer → more specific), then single words
const KEYWORDS = [
  // Phrases (weight 3 each)
  { term: 'marché immobilier', weight: 3 },
  { term: 'bien immobilier', weight: 3 },
  { term: 'investissement immobilier', weight: 3 },
  { term: 'crédit immobilier', weight: 3 },
  { term: 'prêt immobilier', weight: 3 },
  { term: 'prix immobilier', weight: 3 },
  { term: 'prix des logements', weight: 3 },
  { term: 'agence immobilière', weight: 3 },
  { term: 'permis de construire', weight: 3 },
  { term: 'taux immobilier', weight: 3 },
  { term: 'real estate', weight: 3 },
  // Single words (weight 1)
  { term: 'immobilier', weight: 1 },
  { term: 'immobilière', weight: 1 },
  { term: 'logement', weight: 1 },
  { term: 'logements', weight: 1 },
  { term: 'appartement', weight: 1 },
  { term: 'appartements', weight: 1 },
  { term: 'maison', weight: 1 },
  { term: 'location', weight: 1 },
  { term: 'loyer', weight: 1 },
  { term: 'loyers', weight: 1 },
  { term: 'locataire', weight: 1 },
  { term: 'propriétaire', weight: 1 },
  { term: 'résidentiel', weight: 1 },
  { term: 'construction', weight: 1 },
  { term: 'urbanisme', weight: 1 },
  { term: 'copropriété', weight: 1 },
  { term: 'syndic', weight: 1 },
  { term: 'notaire', weight: 1 },
  { term: 'promoteur', weight: 1 },
  { term: 'lotissement', weight: 1 },
  { term: 'terrain', weight: 1 },
  { term: 'rénovation', weight: 1 },
  { term: 'hypothèque', weight: 1 },
  { term: 'mortgage', weight: 1 },
  { term: 'housing', weight: 1 },
  { term: 'property', weight: 1 },
  { term: 'rental', weight: 1 },
];

// ── Scoring ──────────────────────────────────────────────────────────────────
function scoreArticle(title, description) {
  const titleLower = (title || '').toLowerCase();
  const descLower = (description || '').toLowerCase();
  let raw = 0;
  let matchCount = 0;

  for (const { term, weight } of KEYWORDS) {
    const inTitle = titleLower.includes(term);
    const inDesc = descLower.includes(term);
    if (inTitle || inDesc) {
      matchCount++;
      // Title match counts double
      raw += weight * (inTitle ? 2 : 1);
    }
  }

  // Clamp to 1–10; raw >= 20 → 10
  const score = matchCount === 0 ? 0 : Math.min(10, Math.max(1, Math.round((raw / 20) * 10)));
  return { score, matchCount };
}

function impact(score) {
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

// ── Feed fetching ────────────────────────────────────────────────────────────
async function fetchAllFeeds() {
  const articles = [];

  await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        for (const item of parsed.items || []) {
          const title = item.title || '';
          const description = (item.contentSnippet || item.content || item.summary || '').replace(/<[^>]+>/g, '').trim();
          const { score, matchCount } = scoreArticle(title, description);

          // Google News feeds are pre-filtered by query; keep all with score >= 1
          if (score === 0) continue;

          articles.push({
            title,
            description: description.slice(0, 400),
            link: item.link || '',
            pubDate: item.pubDate || item.isoDate || '',
            _source: feed.source,
            _region: feed.region,
            _score: score,
            _impact: impact(score),
          });
        }
      } catch (err) {
        console.error(`[feed error] ${feed.source}: ${err.message}`);
      }
    })
  );

  // Best score first, then newest
  articles.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return new Date(b.pubDate) - new Date(a.pubDate);
  });

  return articles;
}

// ── Cache ────────────────────────────────────────────────────────────────────
let _cache = null;
let _cacheTs = 0;
const TTL = 30 * 60 * 1000; // 30 min

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  try {
    const now = Date.now();

    if (_cache && now - _cacheTs < TTL) {
      return res.json({
        articles: _cache,
        count: _cache.length,
        cached: true,
        cachedAt: new Date(_cacheTs).toISOString(),
        expiresIn: Math.round((TTL - (now - _cacheTs)) / 1000) + 's',
      });
    }

    const articles = await fetchAllFeeds();
    _cache = articles;
    _cacheTs = now;

    res.json({
      articles,
      count: articles.length,
      cached: false,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/news error]', err);
    res.status(500).json({ error: 'Failed to fetch news', detail: err.message });
  }
});

// Force cache refresh (useful during testing)
app.get('/api/news/refresh', async (req, res) => {
  _cache = null;
  _cacheTs = 0;
  res.redirect('/api/news');
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) + 's' });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'Real Estate News Proxy',
    endpoints: ['/api/news', '/api/news/refresh', '/health'],
  });
});

app.listen(PORT, () => {
  console.log(`Real estate news proxy listening on port ${PORT}`);
});
