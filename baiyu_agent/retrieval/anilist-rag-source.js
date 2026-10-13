const { fetchJson } = require('../shared/runtime');

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DETAIL_QUERY = `
  query RagMediaDetails($ids: [Int]) {
    Page(page: 1, perPage: 50) {
      media(id_in: $ids, type: ANIME) {
        id
        title { romaji english native }
        description(asHtml: false)
        source
        siteUrl
        tags { name rank isMediaSpoiler }
        studios(isMain: true) { nodes { name } }
        staff(perPage: 8, sort: RELEVANCE) {
          edges { role node { name { full native } } }
        }
        characters(perPage: 8, sort: ROLE) {
          edges {
            role
            node { name { full native } }
            voiceActors(language: JAPANESE, sort: RELEVANCE) { name { full native } }
          }
        }
      }
    }
  }
`;

function toDetail(media) {
  const title = media.title?.english || media.title?.romaji || media.title?.native || '';
  return {
    anilistId: Number(media.id) || 0,
    title,
    romajiTitle: media.title?.romaji || '',
    nativeTitle: media.title?.native || '',
    description: stripHtml(media.description),
    sourceMaterial: media.source || '',
    siteUrl: media.siteUrl || '',
    tags: (media.tags || [])
      .filter(tag => !tag.isMediaSpoiler)
      .sort((a, b) => Number(b.rank || 0) - Number(a.rank || 0))
      .slice(0, 16)
      .map(tag => ({ name: tag.name, rank: tag.rank })),
    studios: (media.studios?.nodes || []).map(item => item.name).filter(Boolean).slice(0, 8),
    staff: (media.staff?.edges || []).map(edge => ({
      role: edge.role || '',
      name: edge.node?.name?.full || edge.node?.name?.native || ''
    })).filter(item => item.name),
    characters: (media.characters?.edges || []).map(edge => ({
      role: edge.role || '',
      name: edge.node?.name?.full || edge.node?.name?.native || '',
      voiceActor: edge.voiceActors?.[0]?.name?.full || edge.voiceActors?.[0]?.name?.native || ''
    })).filter(item => item.name)
  };
}

async function fetchAniListRagDetails(ids, options = {}) {
  const values = [...new Set((ids || []).map(Number).filter(Boolean))].slice(0, 50);
  if (!values.length) return [];
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 20000);
  const { data } = await fetchJson('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'AniWorld-RAG-Indexer/1.0'
    },
    signal: options.signal,
    body: JSON.stringify({ query: DETAIL_QUERY, variables: { ids: values } })
  }, { timeoutMs, attempts: 3, fetchImpl });
  if (data.errors?.length) throw new Error(data.errors[0].message || 'ANILIST_DETAIL_FAILED');
  return (data.data?.Page?.media || []).map(toDetail).filter(item => item.anilistId);
}

module.exports = { fetchAniListRagDetails, toDetail };
