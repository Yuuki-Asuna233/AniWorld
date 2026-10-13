// Public progress contains capability labels, never raw arguments or credentials.
const ACTIVITIES = Object.freeze({
  resolve_anime: '确认作品身份', search_anime: '搜索动漫',
  retrieve_anime_knowledge: '检索作品资料', get_anime_detail: '查询作品详情',
  lookup_external_anime_info: '核实制作与角色资料', web_search_anime_evidence: '查询网页证据',
  compare_anime: '比较作品', get_user_profile: '读取相关偏好',
  recommend_anime: '筛选推荐作品', get_airing_schedule: '查询更新日程',
  get_my_airing_schedule: '查询你的追番更新', get_user_library: '查询你的追番与历史',
  get_page_context: '读取当前页面信息', search_memory: '检索相关记忆',
  query_context_evidence: '读取对话与工具证据', follow_anime: '处理加入追番',
  unfollow_anime: '处理取消追番', delete_watch_history: '处理历史删除',
  open_anime_playback: '准备播放入口', update_memory: '处理记忆变更',
  start_task: '切换当前任务', load_skill: '读取工作流程',
  present_anime_results: '整理作品清单'
});

function toolProgress(event) {
  const activity = ACTIVITIES[event.name] || '调用工具';
  const outcome = event.type === 'tool_error' ? 'error' : event.result?.outcome;
  const status = event.type === 'tool_start' ? 'running'
    : ['error', 'rejected', 'requires_login'].includes(outcome) ? 'failed'
      : outcome === 'awaiting_confirmation' ? 'awaiting_confirmation'
        : ['needs_input', 'not_found', 'empty', 'partial'].includes(outcome) ? 'needs_attention' : 'completed';
  const text = status === 'running' ? `白羽正在${activity}…`
    : status === 'failed' ? `未能完成${activity}`
      : status === 'awaiting_confirmation' ? `${activity}需要你的确认`
        : status === 'needs_attention' ? `${activity}返回了待说明的结果` : `已完成${activity}`;
  return { type: event.type === 'tool_start' ? 'tool_start' : 'tool_result',
    name: event.name, sequence: event.sequence, status, outcome, text };
}

module.exports = { toolProgress };
