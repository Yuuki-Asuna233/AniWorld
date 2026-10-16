// Core anime routes: search, anime info, episodes, stream

const { ANIME } = require('@consumet/extensions');
const { safeJsonParse } = require('../utils/db-helpers');
const { getCache, setCache } = require('../services/cache');
const { animeCoverFields } = require('../services/anime-covers');

const saturn = new ANIME.AnimeSaturn();

function mountAnimeRoutes(app, { database, cache }) {

  app.get('/api/search', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ results: [], total: 0 });
    try {
      const dbResults = database.searchAnimeMetaByTitle(q, 20);
      const results = dbResults.map(m => ({
        id: 'anilist_' + m.anilist_id,
        title: m.title_chinese || m.title_romaji || m.title_native || 'Unknown',
        nativeTitle: m.title_native || '',
        episodes: m.episodes || '?',
        status: m.status || 'UNKNOWN',
        score: m.average_score || 0,
        ...animeCoverFields({}, { metadata: m }),
        synopsis: '',
        source: 'db',
        oiMsg: m.oi_msg || '',
        oiIndex: m.oi_index || 0,
        romajiTitle: m.title_romaji || '',
        englishTitle: '',
        genres: safeJsonParse(m.genres, []),
        format: m.format || '',
        seasonYear: m.season_year || ''
      }));
      res.json({ results, total: results.length });
    } catch (e) {
      console.error('Search error:', e.message);
      res.json({ results: [], total: 0 });
    }
  });

  app.get('/api/anime/:id', async (req, res) => {
    const id = req.params.id;
    try {
      const numericId = id.startsWith('anilist_') ? parseInt(id.replace('anilist_', '')) : parseInt(id);
      if (!numericId || isNaN(numericId)) return res.status(404).json({ error: 'Not found' });
      const meta = database.getAnimeMetaById(numericId);
      if (meta) {
        return res.json({
          id: 'anilist_' + meta.anilist_id,
          title: meta.title_chinese || meta.title_romaji || meta.title_native || 'Unknown',
          nativeTitle: meta.title_native || '',
          episodes: meta.episodes || 0,
          status: meta.status || 'UNKNOWN',
          score: meta.average_score || 0,
          ...animeCoverFields({}, { metadata: meta }),
          synopsis: '',
          genres: safeJsonParse(meta.genres, []),
          source: 'db',
          format: meta.format || '',
          seasonYear: meta.season_year || '',
          oiMsg: meta.oi_msg || '',
          oiIndex: meta.oi_index || 0
        });
      }
    } catch (e) { console.error('Anime info error:', e.message); }
    res.status(404).json({ error: 'Not found' });
  });

  app.get('/api/episodes/:animeId', async (req, res) => {
    const animeId = req.params.animeId;
    let animeTitle = '';
    let metadata = null;
    try {
      const numericId = animeId.startsWith('anilist_') ? parseInt(animeId.replace('anilist_', '')) : parseInt(animeId);
      if (numericId && !isNaN(numericId)) {
        const meta = database.getAnimeMetaById(numericId);
        if (meta) {
          metadata = meta;
          animeTitle = meta.title_romaji || meta.title_native || meta.title_chinese || '';
        }
      }
    } catch (e) { return res.json({ episodes: [], error: 'Failed to get anime info' }); }
    if (!animeTitle) return res.json({ episodes: [], error: 'No title found' });

    try {
      const cacheKey = 'saturn_search_' + animeTitle.toLowerCase();
      let saturnResults = getCache(cache, cacheKey, 30 * 60 * 1000);
      if (!saturnResults) {
        const sr = await saturn.search(animeTitle);
        saturnResults = sr.results || [];
        setCache(cache, cacheKey, saturnResults, 30 * 60 * 1000, { name: 'saturn_search' });
      }
      if (saturnResults.length === 0) return res.json({ episodes: [], error: 'No streaming source found' });

      const bestMatch = saturnResults[0];
      const infoCacheKey = 'saturn_info_' + bestMatch.id;
      let info = getCache(cache, infoCacheKey, 30 * 60 * 1000);
      if (!info) {
        info = await saturn.fetchAnimeInfo(bestMatch.id);
        setCache(cache, infoCacheKey, info, 30 * 60 * 1000, { name: 'saturn_info' });
      }
      const episodes = (info.episodes || []).map(ep => ({
        id: ep.id, number: ep.number,
        title: ep.title || `第 ${ep.number} 集`,
        image: ep.image || info.image || ''
      }));
      return res.json({ episodes, title: info.title, ...animeCoverFields({ image: info.image }, { metadata }) });
    } catch (e) {
      return res.json({ episodes: [], error: e.message });
    }
  });

  app.get('/api/stream/:episodeId', async (req, res) => {
    const episodeId = req.params.episodeId;
    try {
      const sources = await saturn.fetchEpisodeSources(episodeId);
      const videoSources = (sources.sources || []).map(s => ({
        url: s.url, quality: s.quality || 'default', isM3U8: s.isM3U8 || false
      }));
      const proxiedSources = videoSources.map(s => ({
        ...s,
        url: `/api/video?url=${encodeURIComponent(s.url)}`,
        directUrl: s.url
      }));
      res.json({ sources: proxiedSources, subtitles: sources.subtitles || [], headers: sources.headers || {} });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

}

module.exports = { mountAnimeRoutes };
