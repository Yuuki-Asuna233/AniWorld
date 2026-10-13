const assert = require('assert');
const {
  buildSessionSummary,
  estimateTokens,
  summaryMessage,
  trimHistoryForContext
} = require('../../baiyu_agent/memory/memory');
const {
  parseUserMemory,
  updateUserMemory,
  compactUserMemory
} = require('../../baiyu_agent/memory/user-memory');

const summary = buildSessionSummary(
  '',
  [{ role: 'user', content: '我们讨论了《葬送的芙莉莲》第二季的消息。' }],
  '这部作品目前有没有新的播放安排？',
  '我会先查询站内资料和可靠的外部来源。'
);
assert.strictEqual(typeof summary, 'string');
assert.ok(summary.includes('葬送的芙莉莲'));
assert.ok(!summary.includes('明确喜欢'));
assert.ok(summaryMessage(summary)?.content.includes('历史摘要'));

let store = updateUserMemory('', [], '我喜欢治愈和百合动漫');
let memory = parseUserMemory(store);
assert.strictEqual(memory.preferences.positive.length, 1);
assert.match(memory.preferences.positive[0], /治愈/);

store = updateUserMemory(store, [], '我现在不喜欢百合，别再推了');
memory = parseUserMemory(store);
assert.strictEqual(memory.preferences.positive.some(item => item.includes('百合')), false);
assert.strictEqual(memory.preferences.negative.some(item => item.includes('百合')), true);

store = updateUserMemory(store, [], '忘记我关于百合的偏好');
memory = parseUserMemory(store);
assert.strictEqual(
  [...memory.preferences.positive, ...memory.preferences.negative].some(item => item.includes('百合')),
  false
);

assert.ok(JSON.parse(compactUserMemory(memory)).version === 1);

const boundedHistory = trimHistoryForContext([
  { role: 'user', content: '旧消息'.repeat(1000) },
  { role: 'assistant', content: '新消息'.repeat(1000) }
], 80);
assert.ok(estimateTokens(boundedHistory.map(item => item.content).join('')) <= 80);

console.log('Agent memory regression checks passed.');
