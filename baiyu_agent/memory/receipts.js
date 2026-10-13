function memoryReceiptText(receipt) {
  const scope = { user: '长期', session: '会话', task: '当前任务', turn: '本轮' }[receipt.scope] || '长期';
  if (!receipt.changed) return `没有需要变更的${scope}记忆。`;
  if (!['forget', 'upsert'].includes(receipt.action)) return `指定的${scope}记忆变更已提交。`;
  return receipt.action === 'forget' ? `已遗忘指定的${scope}记忆。` : `已更新指定的${scope}记忆。`;
}

module.exports = { memoryReceiptText };
