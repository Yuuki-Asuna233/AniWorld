import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/card/network_img_layer.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/utils/anime_season.dart';

class TimelinePage extends StatefulWidget {
  const TimelinePage({super.key});

  @override
  State<TimelinePage> createState() => _TimelinePageState();
}

class _TimelinePageState extends State<TimelinePage>
    with SingleTickerProviderStateMixin {
  late final TabController tabController;
  List<List<BangumiItem>> calendar = List.generate(7, (_) => []);
  bool loading = true;
  bool failed = false;
  Timer? _seasonRefreshTimer;

  static const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  @override
  void initState() {
    super.initState();
    final today = DateTime.now().weekday - 1;
    tabController = TabController(
      length: weekdays.length,
      vsync: this,
      initialIndex: today.clamp(0, 6),
    );
    _scheduleSeasonRefresh();
    load();
  }

  void _scheduleSeasonRefresh() {
    _seasonRefreshTimer?.cancel();
    final now = DateTime.now();
    final nextSeasonMonth = now.month <= 3
        ? 4
        : now.month <= 6
            ? 7
            : now.month <= 9
                ? 10
                : 1;
    final nextSeasonYear = nextSeasonMonth == 1 ? now.year + 1 : now.year;
    final nextSeason = DateTime(nextSeasonYear, nextSeasonMonth);
    _seasonRefreshTimer = Timer(nextSeason.difference(now), () {
      if (!mounted) return;
      setState(() {});
      _scheduleSeasonRefresh();
    });
  }

  @override
  void dispose() {
    _seasonRefreshTimer?.cancel();
    tabController.dispose();
    super.dispose();
  }

  Future<void> load() async {
    setState(() {
      loading = true;
      failed = false;
    });
    try {
      final data = await AniWorldApi.getOiCalendar();
      if (!mounted) return;
      setState(() {
        calendar = data;
        loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        failed = true;
        loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(AnimeSeason(DateTime.now()).toString()),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: () => Modular.to.pop(),
        ),
        bottom: TabBar(
          controller: tabController,
          isScrollable: true,
          tabs: weekdays.map((day) => Tab(text: day)).toList(),
        ),
      ),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : failed
              ? Center(
                  child: FilledButton.icon(
                    onPressed: load,
                    icon: const Icon(Icons.refresh_rounded),
                    label: const Text('重新加载新番日历'),
                  ),
                )
              : TabBarView(
                  controller: tabController,
                  children: List.generate(
                    weekdays.length,
                    (index) => buildDayList(calendar[index]),
                  ),
                ),
    );
  }

  Widget buildDayList(List<BangumiItem> items) {
    if (items.isEmpty) {
      return const Center(child: Text('这一天暂时没有更新数据'));
    }
    return RefreshIndicator(
      onRefresh: load,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        physics: const AlwaysScrollableScrollPhysics(
          parent: BouncingScrollPhysics(),
        ),
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (context, index) {
          final item = items[index];
          final title = item.nameCn.isNotEmpty ? item.nameCn : item.name;
          return InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: () => Modular.to.pushNamed('/info/', arguments: item),
            child: Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Theme.of(context)
                    .colorScheme
                    .surfaceContainerHighest
                    .withValues(alpha: 0.55),
                borderRadius: BorderRadius.circular(18),
              ),
              child: Row(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: NetworkImgLayer(
                      src: item.images['large'] ?? '',
                      width: 86,
                      height: 116,
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context)
                              .textTheme
                              .titleMedium
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          [
                            if (item.airDate.isNotEmpty) item.airDate,
                            if (item.ratingScore > 0)
                              '${item.ratingScore.toStringAsFixed(1)} 分',
                            if (item.tags.isNotEmpty)
                              item.tags.take(2).map((e) => e.name).join(' / '),
                          ].join(' · '),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color:
                                Theme.of(context).colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right_rounded),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}
