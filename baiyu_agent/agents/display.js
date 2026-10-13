const { randomUUID } = require('crypto');

const DISPLAY_TOOLS = new Set(['recommend_anime', 'compare_anime', 'get_user_library',
  'get_my_airing_schedule', 'get_airing_schedule', 'search_anime', 'get_anime_detail',
  'resolve_anime', 'retrieve_anime_knowledge']);

// Evidence stays in tool messages. Only a selected result becomes the displayed list.
class DisplayResults {
  constructor() { this.results = new Map(); this.selected = null; }
  clear() { this.results.clear(); this.selected = null; }
  register(name, result) {
    if (!DISPLAY_TOOLS.has(name) || result.error || result.policyRejected) return result;
    const cards = (result.cards || (result.card ? [result.card] : []));
    const seen = new Set();
    const unique = cards.filter(card => {
      const id = Number(card?.anilistId);
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) return false;
      seen.add(id); return true;
    }).slice(0, 12);
    const resultId = randomUUID();
    const entry = { resultId, sourceTool: name, cards: unique };
    this.results.set(resultId, entry);
    return { ...result, resultId, displayItems: unique.map((card, index) => ({ index: index + 1, anilistId: card.anilistId, title: card.title })) };
  }
  present({ resultId, indices }) {
    const entry = this.results.get(resultId);
    if (!entry || (indices && (new Set(indices).size !== indices.length
      || indices.some(index => !Number.isInteger(index) || index < 1 || index > entry.cards.length)))) {
      return { error: '只能选择本轮返回的有效清单和不重复序号。', policyRejected: true };
    }
    // A reordered/subset list needs its own ID; the source list retains its original ordinals.
    this.selected = { ...entry, resultId: randomUUID(), cards: indices ? indices.map(index => entry.cards[index - 1]) : entry.cards };
    this.results.set(this.selected.resultId, this.selected);
    const items = this.selected.cards.map((card, index) => ({ index: index + 1, anilistId: card.anilistId, title: card.title }));
    return { status: 'display_selected', resultId: this.selected.resultId, sourceResultId: resultId, sourceTool: entry.sourceTool,
      items, displayItems: items };
  }
  final() {
    return this.selected || { cards: [], sourceTool: '' };
  }
}

module.exports = { DisplayResults };
