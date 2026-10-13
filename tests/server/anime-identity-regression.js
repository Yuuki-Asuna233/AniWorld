const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  extractAnimeSeason,
  titlesShareAnimeIdentity,
  resolveAnimeMetadata,
  resolveAnimeMetadataDetailed
} = require('../../apps/server/src/services/anime-identity');
const { mountOiapiRoutes } = require('../../apps/server/src/routes/oiapi');
const {
  resolveAnimeEditionPresentation,
  statusFromOiLabel
} = require('../../apps/server/src/services/anime-presentation');

const reZeroSeason3 = {
  anilist_id: 163134,
  title_chinese: 'Re：从零开始的异世界生活 3 第三季',
  title_romaji: 'Re:Zero kara Hajimeru Isekai Seikatsu 3rd Season',
  title_native: 'Re:ゼロから始める異世界生活 3rd season',
  oi_msg: 'Re:从零开始的异世界生活 第三季',
  average_score: 82,
  popularity: 54321,
  episodes: 16,
  status: 'RELEASING',
  season_year: 2024,
  next_airing_episode: 2,
  next_airing_at: 1730000000,
  start_date: '{"year":2024,"month":10,"day":2}'
};
const attackOnTitanSeason3Part2 = {
  anilist_id: 104578,
  title_chinese: '进击的巨人 3 第三季',
  title_romaji: 'Shingeki no Kyojin Season 3 Part 2',
  title_native: '進撃の巨人 Season３ Part.2',
  oi_msg: '进击的巨人 第三季 Part.2'
};
const reZeroSeason4 = {
  anilist_id: 189046,
  title_chinese: 'Re：从零开始的异世界生活 4 第四季',
  title_romaji: 'Re:Zero kara Hajimeru Isekai Seikatsu 4th Season',
  title_native: 'Re:ゼロから始める異世界生活 4th season',
  oi_msg: 'Re:从零开始的异世界生活 第四季',
  start_date: '{"year":2026,"month":4,"day":8}'
};
const reZeroSeason1 = {
  anilist_id: 21355,
  title_chinese: 'Re：从零开始的异世界生活',
  title_romaji: 'Re:Zero kara Hajimeru Isekai Seikatsu',
  title_native: 'Re:ゼロから始める異世界生活',
  oi_msg: 'Re:从零开始的异世界生活'
};
const higurashiGou = {
  anilist_id: 114446,
  title_chinese: '寒蝉鸣泣之时 业',
  title_romaji: 'Higurashi no Naku Koro ni Gou',
  title_native: 'ひぐらしのなく頃に業',
  oi_msg: '寒蝉鸣泣之时 业',
  average_score: 69,
  episodes: 24,
  status: 'FINISHED',
  season_year: 2020,
  start_date: '{"year":2020,"month":10,"day":1}'
};
const higurashiKaku = {
  anilist_id: 16700,
  title_chinese: '寒蝉鸣泣之时 扩',
  oi_msg: '寒蝉鸣泣之时 扩',
  average_score: 68,
  episodes: 1,
  status: 'FINISHED',
  season_year: 2013,
  start_date: '{"year":2013,"month":8,"day":15}'
};

assert.equal(extractAnimeSeason('第三季'), 3);
assert.equal(extractAnimeSeason('3rd Season'), 3);
assert.equal(extractAnimeSeason('Season 3'), 3);
assert(titlesShareAnimeIdentity(
  'Re：从零开始的异世界生活 第三季 反击篇',
  reZeroSeason3.title_chinese
));
assert(!titlesShareAnimeIdentity(
  'Re：从零开始的异世界生活 第三季 反击篇',
  attackOnTitanSeason3Part2.title_chinese
));
assert.equal(
  resolveAnimeEditionPresentation(
    'Re：从零开始的异世界生活 第四季 丧失篇'
  ).airDate,
  '2026-04-08'
);
assert.equal(
  resolveAnimeEditionPresentation(
    'Re：从零开始的异世界生活 第四季 夺还篇'
  ).episodes,
  8
);
assert.equal(statusFromOiLabel('即将放送'), 'NOT_YET_RELEASED');
assert(!titlesShareAnimeIdentity(
  'Re：从零开始的异世界生活',
  reZeroSeason4.title_chinese
));

const shuffledCandidates = [
  attackOnTitanSeason3Part2,
  reZeroSeason4,
  reZeroSeason3,
  reZeroSeason1
];
const fakeDatabase = { searchAnimeMetaByTitle: () => shuffledCandidates };
assert.equal(
  resolveAnimeMetadata(fakeDatabase, 'Re：从零开始的异世界生活 第三季 反击篇').anilist_id,
  163134
);
assert.equal(
  resolveAnimeMetadata(fakeDatabase, 'Re：从零开始的异世界生活').anilist_id,
  21355
);
assert.equal(
  resolveAnimeMetadataDetailed(fakeDatabase, 'Re：从零开始的异世界生活', { season: 4 }).selected.anilist_id,
  189046
);
assert.equal(
  resolveAnimeMetadata(fakeDatabase, '进击的巨人 第三季 Part.2').anilist_id,
  104578
);
const higurashiDatabase = {
  searchAnimeMetaByTitle: () => [higurashiGou, higurashiKaku]
};
assert.equal(
  resolveAnimeMetadata(higurashiDatabase, '寒蝉鸣泣之时').anilist_id,
  114446
);
assert.equal(
  resolveAnimeMetadata(higurashiDatabase, '寒蝉鸣泣之时', { year: 2006 }),
  null
);
assert.equal(
  resolveAnimeMetadata(higurashiDatabase, '寒蝉鸣泣之时', {
    year: 2020,
    minimumScore: 1000
  }),
  null
);
assert.equal(
  resolveAnimeMetadata(higurashiDatabase, '寒蝉鸣泣之时 业', { year: 2020 }).anilist_id,
  114446
);

// Audit every manually bound OI title in the checked dataset. This guards the
// shared resolver used by search cards, detail metadata and playback identity.
const datasetPath = path.join(
  __dirname,
  '..',
  '..',
  'data',
  'datasets',
  'anime_meta_final_simplified_cn_complete_checked.json'
);
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const mappedRows = dataset.filter(row => String(row.oi_msg || '').trim());
const datasetIds = new Set();
for (const row of dataset) {
  assert(row.anilist_id > 0, `Invalid AniList ID: ${row.title_chinese}`);
  assert(!datasetIds.has(row.anilist_id), `Duplicate AniList ID: ${row.anilist_id}`);
  datasetIds.add(row.anilist_id);
  const score = Number(row.average_score || 0);
  const popularity = Number(row.popularity || 0);
  assert(score >= 0 && score <= 100, `Invalid score: ${row.title_chinese}`);
  assert(popularity >= 0, `Invalid popularity: ${row.title_chinese}`);
  if (row.start_date) {
    const date = JSON.parse(row.start_date);
    if (date?.year) {
      assert(date.year >= 1900 && date.year <= 2100, `Invalid start date: ${row.title_chinese}`);
    }
  }
}
const fullDatasetDatabase = { searchAnimeMetaByTitle: () => mappedRows };
for (const row of mappedRows) {
  const resolved = resolveAnimeMetadata(fullDatasetDatabase, row.oi_msg);
  assert(resolved, `No metadata match for OI title: ${row.oi_msg}`);
  assert(
    titlesShareAnimeIdentity(row.oi_msg, resolved.oi_msg || resolved.title_chinese),
    `Cross-anime metadata match: ${row.oi_msg} -> ${resolved.title_chinese}`
  );
  const requestedSeason = extractAnimeSeason(row.oi_msg);
  const resolvedSeason = extractAnimeSeason(
    resolved.oi_msg || resolved.title_chinese || resolved.title_romaji
  );
  assert(
    !requestedSeason || !resolvedSeason || requestedSeason === resolvedSeason,
    `Cross-season metadata match: ${row.oi_msg} -> ${resolved.title_chinese}`
  );
  const startDate = JSON.parse(row.start_date || 'null');
  if (startDate?.year && row.season_year) {
    assert.equal(
      Number(startDate.year),
      Number(row.season_year),
      `Start date year mismatch: ${row.title_chinese}`
    );
  }
  assert(
    Number(row.average_score || 0) >= 0 && Number(row.average_score || 0) <= 100,
    `Invalid AniList score: ${row.title_chinese}`
  );
}

async function runRouteRegression() {
  const routes = new Map();
  const app = {
    get(route, handler) {
      routes.set(`GET ${route}`, handler);
    },
    post(route, handler) {
      routes.set(`POST ${route}`, handler);
    }
  };
  const database = {
    searchAnimeMetaByTitle: () => shuffledCandidates
  };
  const httpFetch = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.bgm.tv') {
      throw new Error('Detail route must not request Bangumi presentation data');
    }
    const requestedTitle = parsed.searchParams.get('msg');
    if (requestedTitle === '从零开始的异世界生活') {
      return {
        status: 200,
        data: {
          code: 200,
          data: [
            {
              name: 'Re：从零开始的异世界生活 第四季 夺还篇',
              image: 'https://example.invalid/recapture.jpg',
              ji: '即将放送',
              year: '2026'
            },
            {
              name: 'Re：从零开始的异世界生活 第四季 丧失篇',
              image: 'https://example.invalid/loss.jpg',
              ji: '已完结',
              year: '2026'
            }
          ]
        }
      };
    }
    if (requestedTitle === '寒蝉鸣泣之时') {
      const oiItem = {
        name: requestedTitle,
        image: 'https://example.invalid/higurashi-2006.jpg',
        class: '悬疑',
        ji: '已完结 26集',
        year: '2006',
        desc: 'Higurashi 2006 detail',
        playlist: Array.from({ length: 26 }, (_, index) => `第${index + 1}集`)
      };
      return {
        status: 200,
        data: {
          code: 200,
          data: parsed.searchParams.has('n') ? oiItem : [oiItem]
        }
      };
    }
    const oiItem = {
      name: requestedTitle,
      image: 'https://example.invalid/re-zero.jpg',
      class: '奇幻',
      ji: '已完结',
      year: '2024',
      desc: 'Re:ZERO detail',
      playlist: ['第1集']
    };
    return {
      status: 200,
      data: {
        code: 200,
        data: parsed.searchParams.has('n') ? oiItem : [oiItem]
      }
    };
  };
  mountOiapiRoutes(app, { database, httpFetch, cache: {} });
  const handler = routes.get('GET /api/oi/details');
  assert(handler, 'Details route was not mounted');

  let statusCode = 200;
  let payload;
  const response = {
    set() {
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return value;
    }
  };
  await handler({
    query: {
      msg: 'Re：从零开始的异世界生活 第三季 反击篇',
      n: '2'
    }
  }, response);

  assert.equal(statusCode, 200);
  assert.equal(payload.name, 'Re：从零开始的异世界生活 第三季 反击篇');
  assert.equal(payload.aniId, 163134);
  assert.equal(payload.metadataMatched, true);
  assert.notEqual(payload.aniId, 104578);
  assert.equal(payload.airDate, '2024-10-02');
  assert.equal(payload.ratingSource, 'anilist');
  assert.equal(payload.ratingScore, 82);
  assert.equal(payload.ratingTotal, 54321);
  assert.equal(payload.episodes, '16');
  assert.equal(payload.releasedEpisodes, 1);
  assert.equal(payload.episodeCountSource, 'anilist');

  payload = undefined;
  await handler({
    query: {
      msg: '寒蝉鸣泣之时',
      n: '1'
    }
  }, response);
  assert.equal(statusCode, 200);
  assert.equal(payload.name, '寒蝉鸣泣之时');
  assert.equal(payload.year, '2006');
  assert.equal(payload.aniId, 0);
  assert.equal(payload.metadataMatched, false);
  assert.equal(payload.airDate, '');
  assert.equal(payload.episodes, '26');
  assert.equal(payload.releasedEpisodes, 26);
  assert.equal(payload.episodeCountSource, 'oiapi_finished');
  assert.equal(payload.ratingSource, 'oiapi');

  payload = undefined;
  const searchHandler = routes.get('GET /api/oi/search');
  assert(searchHandler, 'Search route was not mounted');
  await searchHandler({
    query: {
      q: 'Re：从零开始的异世界生活 第三季 反击篇',
      pure: '1'
    }
  }, response);
  assert.equal(statusCode, 200);
  assert.equal(payload.results[0].anilistId, 163134);
  assert.equal(payload.results[0].metadataMatched, true);
  assert.notEqual(payload.results[0].anilistId, 104578);
  assert.equal(payload.results[0].status, 'RELEASING');
  assert.equal(payload.results[0].episodes, 16);
  assert.equal(payload.results[0].seasonYear, 2024);
  assert.equal(payload.results[0].releasedEpisodes, 1);

  payload = undefined;
  await searchHandler({
    query: {
      q: '寒蝉鸣泣之时',
      pure: '1'
    }
  }, response);
  assert.equal(statusCode, 200);
  assert.equal(payload.results[0].title, '寒蝉鸣泣之时');
  assert.equal(payload.results[0].year, '2006');
  assert.equal(payload.results[0].anilistId, undefined);
  assert.equal(payload.results[0].metadataMatched, undefined);

  payload = undefined;
  await searchHandler({ query: { q: 'RE0', pure: '1' } }, response);
  const reZeroTitles = payload.results.map(item => item.title);
  assert(reZeroTitles.includes('Re：从零开始的异世界生活 第四季 丧失篇'));
  assert(reZeroTitles.includes('Re：从零开始的异世界生活 第四季 夺还篇'));
}

runRouteRegression()
  .then(() => {
    console.log(
      `anime identity regression passed (${mappedRows.length} mapped titles audited)`
    );
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
