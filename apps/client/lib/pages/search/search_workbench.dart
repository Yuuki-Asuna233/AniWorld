part of 'search_page.dart';

class _SearchWorkbenchResult {
  const _SearchWorkbenchResult({
    required this.filterState,
    required this.notShowWatched,
    required this.notShowAbandoned,
    required this.shouldSearch,
  });

  final SearchFilterState filterState;
  final bool notShowWatched;
  final bool notShowAbandoned;
  final bool shouldSearch;
}

class _SearchWorkbenchSheet extends StatefulWidget {
  const _SearchWorkbenchSheet({
    required this.initialState,
    required this.initialNotShowWatched,
    required this.initialNotShowAbandoned,
  });

  final SearchFilterState initialState;
  final bool initialNotShowWatched;
  final bool initialNotShowAbandoned;

  @override
  State<_SearchWorkbenchSheet> createState() => _SearchWorkbenchSheetState();
}

class _SearchWorkbenchSheetState extends State<_SearchWorkbenchSheet> {
  late SearchFilterState draft = widget.initialState.copyWith(
    sort:
        ['heat', 'score', 'match', 'latest'].contains(widget.initialState.sort)
            ? widget.initialState.sort
            : 'heat',
    explicitSort: widget.initialState.explicitSort,
    rankRange: null,
    weekdays: [],
  );
  late bool notShowWatched = widget.initialNotShowWatched;
  late bool notShowAbandoned = widget.initialNotShowAbandoned;
  final TextEditingController tagController = TextEditingController();

  @override
  void dispose() {
    tagController.dispose();
    super.dispose();
  }

  List<_SeasonOption> get seasonOptions {
    final now = DateTime.now();
    final values = <_SeasonOption>[];
    for (int year = now.year; year >= now.year - 19; year--) {
      for (int quarter = 4; quarter >= 1; quarter--) {
        final date = DateTime(year, (quarter - 1) * 3 + 1, 1);
        if (now.isAfter(date)) {
          values.add(_SeasonOption(
            value: '${year}Q$quarter',
            label: '$year ${_seasonLabel(quarter)}',
          ));
        }
      }
    }
    if (draft.season.isNotEmpty &&
        !values.any((item) => item.value == draft.season)) {
      values.insert(0, _SeasonOption(value: draft.season, label: draft.season));
    }
    return values;
  }

  void addTag(String value) {
    final tag = value.trim();
    if (tag.isEmpty || draft.tags.contains(tag)) return;
    setState(() {
      draft = draft.copyWith(tags: [...draft.tags, tag]);
      tagController.clear();
    });
  }

  SearchFilterState resetAdvancedFilters() {
    return draft.copyWith(
      tags: [],
      sort: 'heat',
      explicitSort: false,
      season: '',
      dateRange: null,
      rankRange: null,
      scoreRange: null,
      weekdays: [],
    );
  }

  Future<void> pickCustomDateRange() async {
    final now = DateTime.now();
    final initialStart = draft.dateRange?.start != null
        ? DateTime.tryParse(draft.dateRange!.start)
        : null;
    final initialEnd = draft.dateRange?.end != null
        ? DateTime.tryParse(draft.dateRange!.end)
        : null;
    final firstDate = DateTime(1970);
    final lastDate = DateTime(now.year + 3, 12, 31);
    final hasValidInitialRange = initialStart != null &&
        initialEnd != null &&
        !initialStart.isBefore(firstDate) &&
        !initialEnd.isAfter(lastDate) &&
        !initialStart.isAfter(initialEnd);
    final result = await showDateRangePicker(
      context: context,
      firstDate: firstDate,
      lastDate: lastDate,
      initialDateRange: hasValidInitialRange
          ? DateTimeRange(start: initialStart, end: initialEnd)
          : null,
    );
    if (result == null || !mounted) return;
    setState(() {
      draft = draft.copyWith(
        season: '',
        dateRange: SearchDateRange(
          start: formatDateTime(result.start),
          end: formatDateTime(result.end),
        ),
      );
    });
  }

  Widget _buildScoreRangeSlider(SearchDoubleRange range) {
    final values = _safeRangeValues(
      range.min ?? 0,
      range.max ?? 10,
      0,
      10,
    );
    return RangeSlider(
      values: values,
      min: 0,
      max: 10,
      divisions: 20,
      labels: RangeLabels(
        values.start.toStringAsFixed(1),
        values.end.toStringAsFixed(1),
      ),
      onChanged: (value) {
        setState(() {
          draft = draft.copyWith(
            scoreRange: SearchDoubleRange(
              min: value.start,
              max: value.end,
            ),
          );
        });
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return SafeArea(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(20, 16, 12, 16),
              decoration: BoxDecoration(
                color: colorScheme.surfaceContainerLow,
                borderRadius: BorderRadius.circular(24),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '筛选条件',
                          style: theme.textTheme.titleLarge?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '标签、季度、日期和评分筛选使用站内目录；暂无可靠的排名、放送星期和成人分类数据。',
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  IconButton.filledTonal(
                    tooltip: '关闭',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
              children: [
                _WorkbenchSection(
                  title: '排序',
                  description: '默认保留播放源的关键词搜索顺序；使用目录筛选时默认按热度。指定排序使用站内目录。',
                  icon: Icons.sort_rounded,
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: SegmentedButton<String>(
                      selected: {
                        draft.explicitSort || draft.sort != 'heat'
                            ? draft.sort
                            : 'default'
                      },
                      onSelectionChanged: (value) {
                        setState(() {
                          final selection = value.first;
                          draft = draft.copyWith(
                            sort: selection == 'default' ? 'heat' : selection,
                            explicitSort: selection != 'default',
                          );
                        });
                      },
                      segments: const [
                        ButtonSegment(value: 'default', label: Text('默认')),
                        ButtonSegment(value: 'heat', label: Text('热度')),
                        ButtonSegment(value: 'latest', label: Text('首播日期')),
                        ButtonSegment(value: 'score', label: Text('评分')),
                        ButtonSegment(value: 'match', label: Text('匹配')),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                _WorkbenchSection(
                  title: '标签',
                  description: '多个标签必须同时匹配目录题材或内容标签；自定义标签按元数据原名精确匹配。',
                  icon: Icons.sell_outlined,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          for (final tag in const [
                            '日常',
                            '校园',
                            '喜剧',
                            '奇幻',
                            '百合',
                            '恋爱',
                            '悬疑',
                            '后宫',
                            '机甲',
                            '治愈',
                            '动作',
                            '冒险',
                            '运动',
                            '科幻'
                          ])
                            FilterChip(
                              label: Text(tag),
                              selected: draft.tags.contains(tag),
                              showCheckmark: false,
                              onSelected: (selected) {
                                setState(() {
                                  draft = draft.copyWith(
                                    tags: selected
                                        ? [...draft.tags, tag]
                                        : draft.tags
                                            .where((item) => item != tag)
                                            .toList(),
                                  );
                                });
                              },
                            ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: tagController,
                              decoration: const InputDecoration(
                                labelText: '自定义标签',
                                prefixIcon: Icon(Icons.add_circle_outline),
                              ),
                              onSubmitted: addTag,
                            ),
                          ),
                          const SizedBox(width: 8),
                          IconButton.filledTonal(
                            tooltip: '添加标签',
                            onPressed: () => addTag(tagController.text),
                            icon: const Icon(Icons.add),
                          ),
                        ],
                      ),
                      if (draft.tags.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            for (final tag in draft.tags)
                              InputChip(
                                label: Text(tag),
                                onDeleted: () {
                                  setState(() {
                                    draft = draft.copyWith(
                                      tags: draft.tags
                                          .where((item) => item != tag)
                                          .toList(),
                                    );
                                  });
                                },
                              ),
                          ],
                        ),
                        TextButton.icon(
                          onPressed: () {
                            setState(() => draft = draft.copyWith(tags: []));
                          },
                          icon: const Icon(Icons.clear_all),
                          label: const Text('清空标签'),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                _WorkbenchSection(
                  title: '季度与日期',
                  description: '季度匹配目录年份与季度；自定义日期匹配首播日，包含起止两天，未知日期不会匹配。',
                  icon: Icons.calendar_month,
                  child: Column(
                    children: [
                      DropdownButtonFormField<String>(
                        initialValue:
                            draft.season.isEmpty ? null : draft.season,
                        decoration: const InputDecoration(
                          labelText: '季度',
                          prefixIcon: Icon(Icons.event_available_outlined),
                        ),
                        items: [
                          for (final season in seasonOptions)
                            DropdownMenuItem(
                              value: season.value,
                              child: Text(season.label),
                            ),
                        ],
                        onChanged: (value) {
                          setState(() {
                            draft = draft.copyWith(
                              season: value ?? '',
                              dateRange: null,
                            );
                          });
                        },
                      ),
                      const SizedBox(height: 12),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            OutlinedButton.icon(
                              onPressed: pickCustomDateRange,
                              icon: const Icon(Icons.date_range),
                              label: Text(draft.dateRange == null
                                  ? '自定义日期'
                                  : '${draft.dateRange!.start}..${draft.dateRange!.end}'),
                            ),
                            if (draft.season.isNotEmpty ||
                                draft.dateRange != null)
                              TextButton.icon(
                                onPressed: () {
                                  setState(() {
                                    draft = draft.copyWith(
                                      season: '',
                                      dateRange: null,
                                    );
                                  });
                                },
                                icon: const Icon(Icons.clear),
                                label: const Text('不限日期'),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                _WorkbenchSection(
                  title: '数值范围',
                  description: '使用目录 AniList 评分（0—10）；无评分作品不会匹配评分范围。',
                  icon: Icons.tune_rounded,
                  child: Column(
                    children: [
                      _SearchSwitchTile(
                        title: '启用评分范围',
                        value: draft.scoreRange?.isValid == true,
                        onChanged: (value) {
                          setState(() {
                            draft = draft.copyWith(
                              scoreRange: value
                                  ? const SearchDoubleRange(
                                      min: 7.0,
                                      max: 10.0,
                                    )
                                  : null,
                            );
                          });
                        },
                      ),
                      if (draft.scoreRange?.isValid == true)
                        _buildScoreRangeSlider(draft.scoreRange!),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                _WorkbenchSection(
                  title: '过滤',
                  description: '控制是否隐藏已经看过或放弃的番剧。',
                  icon: Icons.filter_alt_outlined,
                  child: Column(
                    children: [
                      _SearchSwitchTile(
                        title: '隐藏已看',
                        value: notShowWatched,
                        onChanged: (value) {
                          setState(() => notShowWatched = value);
                        },
                      ),
                      _SearchSwitchTile(
                        title: '隐藏已弃',
                        value: notShowAbandoned,
                        onChanged: (value) {
                          setState(() => notShowAbandoned = value);
                        },
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: Row(
              children: [
                TextButton.icon(
                  onPressed: () {
                    setState(() {
                      draft = resetAdvancedFilters();
                      notShowWatched = false;
                      notShowAbandoned = false;
                    });
                  },
                  icon: const Icon(Icons.restart_alt),
                  label: const Text('重置'),
                ),
                const Spacer(),
                FilledButton.icon(
                  onPressed: () {
                    Navigator.pop(
                      context,
                      _SearchWorkbenchResult(
                        filterState: draft,
                        notShowWatched: notShowWatched,
                        notShowAbandoned: notShowAbandoned,
                        shouldSearch: true,
                      ),
                    );
                  },
                  icon: const Icon(Icons.check),
                  label: const Text('应用'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _WorkbenchSection extends StatelessWidget {
  const _WorkbenchSection({
    required this.title,
    required this.description,
    required this.icon,
    required this.child,
  });

  final String title;
  final String description;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(
          color: colorScheme.outlineVariant.withValues(alpha: 0.45),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: colorScheme.primary),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      description,
                      style: textTheme.bodySmall?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          child,
        ],
      ),
    );
  }
}

class _SearchSwitchTile extends StatelessWidget {
  const _SearchSwitchTile({
    required this.title,
    required this.value,
    required this.onChanged,
  });

  final String title;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Material(
      type: MaterialType.transparency,
      child: SwitchListTile(
        contentPadding: EdgeInsets.zero,
        visualDensity: VisualDensity.compact,
        title: Text(title),
        value: value,
        onChanged: onChanged,
      ),
    );
  }
}

class _SeasonOption {
  const _SeasonOption({
    required this.value,
    required this.label,
  });

  final String value;
  final String label;
}

RangeValues _safeRangeValues(
  double start,
  double end,
  double min,
  double max,
) {
  final safeStart = start.clamp(min, max).toDouble();
  final safeEnd = end.clamp(min, max).toDouble();
  if (safeStart <= safeEnd) {
    return RangeValues(safeStart, safeEnd);
  }
  return RangeValues(safeEnd, safeStart);
}

String _sortLabel(String sort) {
  switch (sort) {
    case 'latest':
      return '首播日期';
    case 'rank':
      return '排名';
    case 'score':
      return '评分';
    case 'match':
      return '匹配';
    default:
      return '热度';
  }
}

String _seasonLabel(int quarter) {
  switch (quarter) {
    case 1:
      return '冬季';
    case 2:
      return '春季';
    case 3:
      return '夏季';
    case 4:
      return '秋季';
    default:
      return '';
  }
}
