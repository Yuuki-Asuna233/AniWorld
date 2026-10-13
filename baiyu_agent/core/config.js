const { envInt } = require('../shared/utils');
function agentConfig(env = process.env) {
  return {
    maxToolRounds: envInt('AGENT_MAX_TOOL_ROUNDS', 8, 1, 12, env),
    runTimeoutMs: envInt('AGENT_RUN_TIMEOUT_MS', 120000, 10000, 300000, env),
    toolTimeoutMs: envInt('AGENT_TOOL_TIMEOUT_MS', 30000, 3000, 90000, env),
    maxToolCalls: envInt('AGENT_MAX_TOOL_CALLS', 24, 1, 40, env),
    readConcurrency: envInt('AGENT_READ_CONCURRENCY', 3, 1, 4, env),
    maxAnswerChars: Math.max(500, Number(env.AGENT_MAX_ANSWER_CHARS) || 6000),
    requireConfirmationForActions: String(env.AGENT_REQUIRE_ACTION_CONFIRMATION || 'true') !== 'false'
  };
}

module.exports = { agentConfig };
