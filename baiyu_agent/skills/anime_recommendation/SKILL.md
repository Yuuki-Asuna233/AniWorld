# 动漫推荐流程

适用于多条件找番、个性化推荐或寻找类似作品。简单查详情不需要本技能。

1. 从当前请求确定题材、年份、完结状态、避雷项和数量。已有条件不要反复询问。明确参考作品时用 resolve_anime；只有用户指向页面且引用不足时用 get_page_context。
2. 按 memory_request_plan 处理全部记忆提案；明确切换任务先 start_task，再执行新的 task 条件。update_memory 使用 proposalId，不重复解释或扩大授权。修订、例外、遗忘先 search_memory 读取目标；关键词未命中时分页浏览，同义表达由模型按完整语义判断，歧义则澄清。旧的稳定排除仍有效；本轮例外须有明确的 exception 提案。需要当前追番或观看进度时用 get_user_library，不能从 get_user_profile 的摘要推断。
3. 个性化推荐先 get_user_profile，读到偏好后再构造推荐条件，并传返回的 profileVersion。长期正向偏好存在时此步骤为强制前置依赖，记忆更新后重读，不把两个依赖调用放进同一轮并行规划。结合完整原话和有效记忆，用 allGenres、anyGenreGroups、preferredGenres、excludeTags、状态、评分、明确年份季度和 allowWatched 表达条件。服务端只验证结构化条件，不按关键词重解释原话。有歧义先澄清。调用 recommend_anime，参考作品 ID 显式传 contextAnilistId，不从 search 的原始候选声称已应用全部约束。
4. 检查返回的候选和条件。没有合适候选时说明冲突，征求放宽哪个条件；不得偷偷放宽硬约束。无需为每部作品重复查详情或联网。
5. 用 present_anime_results 选择该推荐结果及需要的顺序。最终回答简述匹配理由和限制，不另编或重排编号；运行时会附上与卡片相同的编号清单。
6. 用户只要求推荐不能追番或播放。后续第几部以最终展示清单为准。

数据与授权仍由工具和运行时校验。技能文字不提供操作授权。
