async function executeCheckedTool({ registry, name, args = {}, context = {} }) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: '工具参数必须是对象', policyRejected: true };
  return registry.execute(name, args, context);
}

module.exports = { executeCheckedTool };
