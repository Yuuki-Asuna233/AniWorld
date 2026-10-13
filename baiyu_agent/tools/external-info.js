const { fetchJson, scopedSignal, throwIfAborted } = require('../shared/runtime');
const anilistCache = new Map();

function stripHtml(value) {
  return String(value || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function lookupJikanById(malId, signal) {
  const id = Number(malId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const cacheKey = `jikan:${id}`;
  const cached = anilistCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.value;
  try {
    const search = await fetchJson(`https://api.jikan.moe/v4/anime/${id}`, {
      signal, headers: { Accept: 'application/json', 'User-Agent': 'AniWorld-Agent/1.0' }
    });
    const item = search.data?.data;
    if (!search.ok || item?.mal_id !== id) return null;
    const value = {
      malId: item.mal_id,
      title: item.title || item.title_english || '',
      titleJapanese: item.title_japanese || '',
      url: item.url || '',
      type: item.type || '',
      source: item.source || '',
      rating: item.rating || '',
      status: item.status || '',
      aired: item.aired?.string || '',
      studios: (item.studios || []).map(x => x.name).filter(Boolean).slice(0, 6),
      producers: (item.producers || []).map(x => x.name).filter(Boolean).slice(0, 6),
      licensors: (item.licensors || []).map(x => x.name).filter(Boolean).slice(0, 6),
      trailer: item.trailer?.url || '',
      synopsis: stripHtml(item.synopsis || '').slice(0, 700)
    };
    if (anilistCache.size >= 500) anilistCache.delete(anilistCache.keys().next().value);
    anilistCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (error) {
    throwIfAborted(signal);
    return null;
  }
}

async function lookupAniList(args = {}, signal) {
  const id = Number(args.anilistId) || 0;
  if (!id) return { found: false, error: '请先确认 AniList ID。' };
  const cacheKey = `id:${id}`;
  const cached = anilistCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.value;

  const gql = `
    query($id:Int){
      Media(id:$id, type:ANIME){
        id idMal
        title { romaji english native }
        synonyms
        description(asHtml:false)
        format status episodes duration averageScore popularity genres
        season seasonYear source siteUrl
        nextAiringEpisode { episode airingAt }
        tags { name rank isMediaSpoiler }
        studios(isMain:true) { nodes { name siteUrl } }
        staff(perPage:8, sort:RELEVANCE) { pageInfo { hasNextPage } edges { role node { name { full native } siteUrl } } }
        characters(perPage:8, sort:ROLE) {
          pageInfo { hasNextPage }
          edges {
            role
            node { name { full native } siteUrl }
            voiceActors(language:JAPANESE, sort:RELEVANCE) { name { full native } siteUrl }
          }
        }
      }
    }`;
  try {
    const response = await fetchJson('https://graphql.anilist.co', {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'AniWorld-Agent/1.0'
      },
      body: JSON.stringify({ query: gql, variables: { id } })
    });
    const data = response.data;
    if (!response.ok || data.errors?.length) {
      const error = data.errors?.[0]?.message || `HTTP ${response.status}`;
      return { found: false, source: 'AniList', error };
    }
    const media = data.data?.Media;
    if (!media) return { found: false, source: 'AniList' };
    if (media.id !== id) return { found: false, error: 'EXTERNAL_IDENTITY_MISMATCH', source: 'AniList' };
    const bestTitle = media.title?.english || media.title?.romaji || media.title?.native || '';
    const supplement = scopedSignal(signal, 6000, 'JIKAN_LOOKUP_TIMEOUT');
    let jikan;
    try { jikan = await lookupJikanById(media.idMal, supplement.signal); }
    catch (error) { throwIfAborted(signal); jikan = null; }
    finally { supplement.dispose(); }
    const value = {
      found: true,
      source: jikan ? 'AniList + Jikan/MAL' : 'AniList',
      identity: { anilistId: id, malId: media.idMal || null, mappingSource: 'AniList.idMal' },
      coverage: { staffPartial: Boolean(media.staff?.pageInfo?.hasNextPage), charactersPartial: Boolean(media.characters?.pageInfo?.hasNextPage),
        jikanStatus: jikan ? 'verified' : media.idMal ? 'unavailable' : 'no_mapping' },
      partial: Boolean(media.staff?.pageInfo?.hasNextPage || media.characters?.pageInfo?.hasNextPage),
      sources: [{ title: 'AniList', url: media.siteUrl }, ...(jikan?.url ? [{ title: 'MyAnimeList via Jikan', url: jikan.url }] : [])],
      item: {
        anilistId: media.id,
        title: bestTitle || '',
        romajiTitle: media.title?.romaji || '',
        nativeTitle: media.title?.native || '',
        synonyms: (media.synonyms || []).slice(0, 8),
        description: stripHtml(media.description).slice(0, 900),
        format: media.format || '',
        status: media.status || '',
        episodes: media.episodes || 0,
        duration: media.duration || 0,
        score: media.averageScore || 0,
        popularity: media.popularity || 0,
        genres: media.genres || [],
        season: media.season || '',
        year: media.seasonYear || 0,
        sourceMaterial: media.source || '',
        siteUrl: media.siteUrl || '',
        nextAiring: media.nextAiringEpisode || null,
        studios: (media.studios?.nodes || []).map(studio => studio.name).slice(0, 6),
        tags: (media.tags || [])
          .filter(tag => !tag.isMediaSpoiler)
          .sort((a, b) => Number(b.rank || 0) - Number(a.rank || 0))
          .slice(0, 12)
          .map(tag => ({ name: tag.name, rank: tag.rank })),
        staff: (media.staff?.edges || []).slice(0, 8).map(edge => ({
          role: edge.role,
          name: edge.node?.name?.full || edge.node?.name?.native || ''
        })),
        characters: (media.characters?.edges || []).slice(0, 8).map(edge => ({
          role: edge.role,
          name: edge.node?.name?.full || edge.node?.name?.native || '',
          voiceActor: edge.voiceActors?.[0]?.name?.full || edge.voiceActors?.[0]?.name?.native || ''
        })),
        web: jikan
      }
    };
    if (anilistCache.size >= 500) anilistCache.delete(anilistCache.keys().next().value);
    anilistCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (error) {
    throwIfAborted(signal);
    return { found: false, source: 'AniList', error: error.message };
  }
}

module.exports = { lookupAniList };
