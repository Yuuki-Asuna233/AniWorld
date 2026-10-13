const assert = require('assert');
const { configureTestDatabase } = require('./helpers/test-database');

process.env.TAVILY_API_KEY = '';
const testDatabase = configureTestDatabase('agent-regression');
process.on('exit', testDatabase.cleanup);

const database = require('../../apps/server/database');
const { runAgent } = require('../../baiyu_agent/agents/runner');
const { classifyIntent, INTENTS } = require('../../baiyu_agent/agents/intent');
const { enrichSearchResults } = require('../../baiyu_agent/retrieval/source-quality');
const { findAnimeTarget } = require('../../baiyu_agent/actions/actions');
const { getCurrentSeasonInfo, getSeasonSyncWindow } = require('../../apps/server/src/utils/date');

const fakeProvider = {
  isConfigured() { return false; },
  async chat() { throw new Error('fake provider should not be called when disabled'); }
};

async function ask(message, pageContext = {}) {
  return runAgent({
    provider: fakeProvider,
    database,
    userId: null,
    history: [],
    sessionSummary: '',
    message,
    pageContext
  });
}

async function main() {
  await testDatabase.initialize(database);

  assert.strictEqual(classifyIntent('你好').intent, INTENTS.GREETING);
  assert.strictEqual(classifyIntent('今天天气怎么样').intent, INTENTS.GENERAL_CHAT);
  assert.strictEqual(classifyIntent('新海诚的下一部作品是什么，什么时候上映').intent, INTENTS.CREATOR_NEWS);
  assert.strictEqual(classifyIntent('明天有什么番更新').intent, INTENTS.AIRING_SCHEDULE);
  assert.strictEqual(classifyIntent('查今日更新').intent, INTENTS.AIRING_SCHEDULE);
  assert.strictEqual(classifyIntent('我的追番今日更新什么').intent, INTENTS.MY_AIRING_SCHEDULE);
  assert.strictEqual(classifyIntent('根据我的记录推荐几部动漫').intent, INTENTS.ANIME_RECOMMEND);
  assert.strictEqual(classifyIntent('帮我追这个番', { anilistId: 1, title: '测试番剧' }).intent, INTENTS.FOLLOW_ANIME);
  assert.strictEqual(classifyIntent('帮我追葬送的芙莉莲第二季').intent, INTENTS.FOLLOW_ANIME);
  assert.strictEqual(classifyIntent('帮我删掉这个的浏览记录', { anilistId: 1, title: '测试番剧' }).intent, INTENTS.DELETE_HISTORY);
  assert.strictEqual(classifyIntent('帮我跳转到这个番的播放界面', { anilistId: 1, title: '测试番剧' }).intent, INTENTS.NAVIGATE_PLAY);

  const [currentSeason, nextSeason] = getCurrentSeasonInfo();
  const syncWindow = getSeasonSyncWindow();
  assert.strictEqual(syncWindow.length, 3);
  assert.deepStrictEqual(syncWindow[1], currentSeason);
  assert.deepStrictEqual(syncWindow[2], nextSeason);

  const weather = await ask('今天天气怎么样');
  assert.match(weather.answer, /不属于动漫|通用模型|站内推荐范围/);
  assert.strictEqual((weather.cards || []).length, 0);

  const greeting = await ask('你好');
  assert.match(greeting.answer, /白羽|动漫助手/);

  const creator = await ask('新海诚的下一部作品是什么，什么时候上映');
  assert.match(creator.answer, /创作者|行业|网页搜索|可靠结果|TAVILY_API_KEY/);
  assert.strictEqual((creator.cards || []).length, 0);

  const today = await ask('查今日更新');
  assert.strictEqual(today.intent, INTENTS.AIRING_SCHEDULE);
  assert.ok(Array.isArray(today.plan) && today.plan.length >= 2);
  assert.ok(!/推荐|推荐几部|根据我的记录/.test(today.answer), 'schedule answer must not become recommendation');

  const recommend = await ask('上季度有哪些好看的校园恋爱番');
  assert.strictEqual(recommend.intent, INTENTS.ANIME_RECOMMEND);
  assert.ok(Array.isArray(recommend.plan) && recommend.plan.some(item => /季度|题材|评分/.test(item)));
  for (const card of recommend.cards || []) {
    assert.ok(card.year, 'recommendation cards should carry year');
  }

  const rec = await ask('推荐几部动漫');
  assert.ok((rec.cards || []).length > 0, 'anime recommendation should return cards');

  let modelCalls = 0;
  const repeatingToolProvider = {
    isConfigured() { return true; },
    async chat() {
      modelCalls += 1;
      return {
        content: '',
        tool_calls: [{
          id: `call-${modelCalls}`,
          function: {
            name: 'recommend_anime',
            arguments: JSON.stringify({ intent: '推荐几部动漫', limit: 4 })
          }
        }]
      };
    }
  };
  const converged = await runAgent({
    provider: repeatingToolProvider,
    database,
    userId: null,
    history: [],
    sessionSummary: '',
    message: '推荐几部动漫',
    pageContext: {}
  });
  assert.strictEqual(modelCalls, 2, 'terminal tool result should stop repeated tool rounds');
  assert.ok((converged.cards || []).length > 0);
  assert.ok(!/工具调用没有及时收敛/.test(converged.answer));

  const page = await ask('这部有第二季吗', { anilistId: 1, title: '测试番剧', page: '/anime.html' });
  assert.notStrictEqual(page.intent, INTENTS.GENERAL_CHAT);

  const followGuest = await ask('帮我追这个番', { anilistId: 1, title: '测试番剧', page: '/anime.html' });
  assert.match(followGuest.answer, /需要登录|登录后/);
  assert.strictEqual(followGuest.actions?.[0]?.type, 'navigate');

  assert.strictEqual(classifyIntent('那可以帮我追番吗？').intent, INTENTS.FOLLOW_ANIME);
  assert.strictEqual(classifyIntent('播放到哪一季了').intent, INTENTS.ANIME_DETAIL);

  const frierenFollowGuest = await ask('帮我追葬送的芙莉莲第二季');
  assert.match(frierenFollowGuest.answer, /需要登录|登录后/);
  assert.ok(!/找不到|没能准确找到/.test(frierenFollowGuest.answer), 'Frieren season 2 should be recognized before login check');
  const frierenTarget = findAnimeTarget({ database, message: '帮我追葬送的芙莉莲第二季', pageContext: {} });
  assert.match(String(frierenTarget.meta?.title_chinese || frierenTarget.meta?.title_romaji || ''), /第二季|2nd/i);

  const playable = database.getRankingsFromDb('popular', 1)[0];
  if (playable) {
    const nav = await ask('帮我跳转到这个番的播放界面', {
      anilistId: Number(playable.anilist_id),
      title: playable.title_chinese || playable.title_romaji,
      msg: playable.oi_msg || '',
      n: playable.oi_index || 1,
      page: '/anime.html'
    });
    assert.strictEqual(nav.actions?.[0]?.type, 'navigate');
    assert.ok(String(nav.actions[0].url || '').startsWith('/'));
  }

  const sources = enrichSearchResults([
    { title: 'Official', url: 'https://re-zero-anime.jp/news/', score: 0.2 },
    { title: 'Random', url: 'https://example.com/post', score: 1 }
  ]);
  assert.strictEqual(sources[0].host, 're-zero-anime.jp');
  assert.ok(sources[0].trustScore > sources[1].trustScore);

  console.log('[agent-regression] all checks passed');
  process.exit(0);
}

main().catch(error => {
  console.error('[agent-regression] failed:', error);
  process.exit(1);
});
