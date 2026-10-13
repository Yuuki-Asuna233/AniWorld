const { TOOL_SCHEMAS, executeTool } = require('./tools/tools');
const { ToolRegistry } = require('./tools/registry');

const toolRegistry = new ToolRegistry(TOOL_SCHEMAS, executeTool);

module.exports = { TOOL_SCHEMAS, executeTool, toolRegistry, ToolRegistry };
