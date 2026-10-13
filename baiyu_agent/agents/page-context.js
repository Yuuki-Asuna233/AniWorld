function pageSnapshot(input = {}) {
  if (!input || typeof input !== 'object') input = {};
  const text = (key, size) => String(input[key] || '').slice(0, size);
  const number = key => Number.isFinite(Number(input[key])) ? Math.max(0, Number(input[key])) : 0;
  return Object.freeze({ page: text('page', 80), anilistId: Math.floor(number('anilistId')), title: text('title', 120), image: text('image', 2048), n: Math.floor(number('n')),
    msg: text('msg', 120), episode: text('episode', 40), episodeIndex: Math.floor(number('episodeIndex') || number('n')),
    progress: Math.min(100, number('progress')), isFavorited: input.isFavorited === true, playing: input.playing === true });
}

function readPageContext(snapshot = {}) {
  const available = Boolean(snapshot.page || snapshot.anilistId || snapshot.title || snapshot.msg);
  return { available, source: 'client_snapshot_at_send', ...(available ? { page: snapshot } : {}),
    ...(available ? {} : { message: '本次消息没有可用页面快照，请询问具体作品。' }) };
}

module.exports = { pageSnapshot, readPageContext };
