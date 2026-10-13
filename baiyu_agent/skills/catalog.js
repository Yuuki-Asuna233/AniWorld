const { readFileSync } = require('fs');
const { join } = require('path');

const SKILL_CATALOG = Object.freeze([
  { name: 'anime_recommendation', description: '多条件或个性化找番：澄清参考作品，处理偏好约束，筛选并展示推荐。' },
  { name: 'anime_comparison', description: '比较两三部作品：定位身份，选择比较维度，按需补资料并解释差异。' },
  { name: 'anime_research', description: '需要多来源核实的动漫调查：区分稳定事实和最新消息，评估证据与来源。' }
]);
const bodies = new Map();

function loadSkill(name) {
  if (!SKILL_CATALOG.some(skill => skill.name === name)) return { error: '未知技能。', policyRejected: true };
  if (!bodies.has(name)) bodies.set(name, readFileSync(join(__dirname, name, 'SKILL.md'), 'utf8'));
  return { status: 'skill_loaded', name, instructions: bodies.get(name) };
}

module.exports = { SKILL_CATALOG, loadSkill };
