import 'dart:async';
import 'package:kazumi/services/storage/storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:dio/dio.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/bean/card/network_img_layer.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/pages/info/info_controller.dart';
import 'package:kazumi/pages/info/source_sheet.dart';
import 'package:kazumi/plugins/plugins_controller.dart';
import 'package:kazumi/bean/dialog/adaptive_bottom_sheet.dart';
import 'package:kazumi/pages/video/video_controller.dart';
import 'package:kazumi/pages/collect/collect_controller.dart';
import 'package:kazumi/pages/history/history_controller.dart';
import 'package:kazumi/modules/collect/collect_type.dart';

class ShirahaPage extends StatefulWidget {
  const ShirahaPage({super.key});

  @override
  State<ShirahaPage> createState() => _ShirahaPageState();
}

class _ChatMessage {
  const _ChatMessage(this.text, this.mine,
      {this.cards = const [],
      this.actions = const [],
      this.plan = const [],
      this.status = ''});

  final String text;
  final bool mine;
  final List<AniWorldAgentCard> cards;
  final List<Map<String, dynamic>> actions;
  final List<String> plan;
  final String status;
}

class _ShirahaPageState extends State<ShirahaPage> {
  static const _welcome = _ChatMessage(
    '你好，我是白羽酱。可以问我动漫推荐、更新和作品信息，也可以让我帮你追番或跳转播放。',
    false,
  );

  final TextEditingController input = TextEditingController();
  final ScrollController scrollController = ScrollController();
  final List<_ChatMessage> messages = [_welcome];
  List<AniWorldAgentSession> sessions = [];
  String currentSessionId = '';
  String currentSessionTitle = '新对话';
  List<String> suggestions = const [
    '根据我的记录推荐',
    '推荐几部轻松治愈番',
    '查今天更新',
  ];
  bool loading = false;
  bool loadingHistory = false;
  CancelToken? _agentCancelToken;
  String _agentRequestId = '';
  int _historyGeneration = 0;
  int _sessionsGeneration = 0;
  StreamSubscription<void>? _accountSubscription;

  @override
  void initState() {
    super.initState();
    _accountSubscription = GStorage.accountChanges.listen((_) {
      _agentCancelToken?.cancel('account_changed');
      if (!mounted) return;
      setState(() {
        sessions = [];
        loading = false;
        loadingHistory = false;
      });
      _newConversation();
      if (AniWorldApi.isLoggedIn) unawaited(_refreshSessions());
    });
    if (AniWorldApi.isLoggedIn) {
      _refreshSessions();
    }
  }

  @override
  void dispose() {
    _historyGeneration++;
    _sessionsGeneration++;
    _accountSubscription?.cancel();
    input.dispose();
    scrollController.dispose();
    _agentCancelToken?.cancel('page_disposed');
    super.dispose();
  }

  void _scrollToBottom({bool force = true}) {
    if (!force &&
        scrollController.hasClients &&
        scrollController.position.extentAfter > 96) {
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !scrollController.hasClients) return;
      if (!force) {
        scrollController.jumpTo(scrollController.position.maxScrollExtent);
        return;
      }
      scrollController.animateTo(
        scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _refreshSessions() async {
    if (!AniWorldApi.isLoggedIn) return;
    final generation = ++_sessionsGeneration;
    final account = AniWorldAccountSnapshot();
    try {
      final result = await AniWorldApi.getAgentSessions();
      if (mounted && account.isCurrent && generation == _sessionsGeneration) {
        setState(() => sessions = result);
      }
    } catch (_) {}
  }

  void _newConversation() {
    _historyGeneration++;
    _sessionsGeneration++;
    _agentCancelToken?.cancel('conversation_changed');
    _agentCancelToken = null;
    _agentRequestId = '';
    setState(() {
      loading = false;
      loadingHistory = false;
      currentSessionId = '';
      currentSessionTitle = '新对话';
      messages
        ..clear()
        ..add(_welcome);
      suggestions = const [
        '根据我的记录推荐',
        '推荐几部轻松治愈番',
        '查今天更新',
      ];
    });
  }

  Future<void> _openSession(AniWorldAgentSession session) async {
    if (loading || loadingHistory) return;
    final account = AniWorldAccountSnapshot();
    final generation = ++_historyGeneration;
    bool current() =>
        mounted && account.isCurrent && generation == _historyGeneration;
    setState(() => loadingHistory = true);
    try {
      final history = await AniWorldApi.getAgentMessages(session.id);
      if (!current()) return;
      setState(() {
        currentSessionId = session.id;
        currentSessionTitle =
            session.title.trim().isEmpty ? '历史对话' : session.title;
        messages
          ..clear()
          ..addAll(history.map(
            (item) => _ChatMessage(
              item.content,
              item.role == 'user',
              cards: item.cards,
            ),
          ));
        if (messages.isEmpty) messages.add(_welcome);
      });
      _scrollToBottom();
    } catch (e) {
      if (current()) KazumiDialog.showToast(message: '历史对话加载失败，请稍后重试');
    } finally {
      if (current()) setState(() => loadingHistory = false);
    }
  }

  String _sessionTime(int seconds) {
    if (seconds <= 0) return '';
    final date = DateTime.fromMillisecondsSinceEpoch(seconds * 1000);
    final now = DateTime.now();
    if (date.year == now.year &&
        date.month == now.month &&
        date.day == now.day) {
      return '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
    }
    return '${date.month}-${date.day}';
  }

  Future<void> _showHistory() async {
    if (!AniWorldApi.isLoggedIn) {
      KazumiDialog.showToast(message: '登录后才能查看白羽历史对话');
      return;
    }
    final account = AniWorldAccountSnapshot();
    final generation = ++_historyGeneration;
    setState(() => loadingHistory = true);
    await _refreshSessions();
    if (!mounted || !account.isCurrent || generation != _historyGeneration) {
      return;
    }
    setState(() => loadingHistory = false);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) {
        return StatefulBuilder(builder: (context, modalSetState) {
          return SafeArea(
            child: SizedBox(
              height: MediaQuery.sizeOf(context).height * 0.72,
              child: Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(18, 0, 10, 8),
                    child: Row(
                      children: [
                        Text('历史对话',
                            style: Theme.of(context).textTheme.titleLarge),
                        const Spacer(),
                        TextButton.icon(
                          onPressed: () {
                            Navigator.pop(sheetContext);
                            _newConversation();
                          },
                          icon: const Icon(Icons.add_comment_outlined),
                          label: const Text('新建'),
                        ),
                      ],
                    ),
                  ),
                  const Divider(height: 1),
                  Expanded(
                    child: sessions.isEmpty
                        ? const Center(child: Text('还没有历史对话'))
                        : ListView.separated(
                            itemCount: sessions.length,
                            separatorBuilder: (_, __) =>
                                const Divider(height: 1),
                            itemBuilder: (context, index) {
                              final session = sessions[index];
                              return ListTile(
                                selected: session.id == currentSessionId,
                                leading: const Icon(
                                    Icons.chat_bubble_outline_rounded),
                                title: Text(
                                  session.title.trim().isEmpty
                                      ? '未命名对话'
                                      : session.title,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                subtitle: Text(_sessionTime(session.updatedAt)),
                                trailing: IconButton(
                                  tooltip: '删除对话',
                                  icon: const Icon(Icons.close_rounded),
                                  onPressed: () async {
                                    try {
                                      await AniWorldApi.deleteAgentSession(
                                          session.id);
                                      sessions.removeWhere(
                                          (item) => item.id == session.id);
                                      if (currentSessionId == session.id) {
                                        _newConversation();
                                      }
                                      modalSetState(() {});
                                      if (mounted) setState(() {});
                                    } catch (_) {
                                      KazumiDialog.showToast(
                                          message: '删除失败，请稍后重试');
                                    }
                                  },
                                ),
                                onTap: () {
                                  Navigator.pop(sheetContext);
                                  _openSession(session);
                                },
                              );
                            },
                          ),
                  ),
                ],
              ),
            ),
          );
        });
      },
    );
  }

  Future<void> send({String? confirmationId}) async {
    final account = AniWorldAccountSnapshot();
    final text = input.text.trim();
    if (text.isEmpty || loading || loadingHistory || !account.isCurrent) return;
    _historyGeneration++;
    _sessionsGeneration++;
    setState(() {
      input.clear();
      messages.add(_ChatMessage(text, true));
      messages.add(const _ChatMessage('', false, status: '白羽正在理解你的问题…'));
      suggestions = const [];
      loading = true;
    });
    _agentCancelToken = CancelToken();
    _agentRequestId = '${DateTime.now().microsecondsSinceEpoch}';
    final requestId = _agentRequestId;
    bool current() =>
        mounted &&
        account.isCurrent &&
        _agentRequestId == requestId &&
        messages.isNotEmpty;
    _scrollToBottom();
    final activeTools = <String, String>{};
    var stageStatus = '白羽正在理解你的问题…';
    try {
      final result = await AniWorldApi.chatWithSession(
        text,
        sessionId: currentSessionId,
        pageContext: _pageContext(),
        requestId: _agentRequestId,
        confirmationId: confirmationId,
        cancelToken: _agentCancelToken,
        onEvent: (event) {
          if (!current()) return;
          final type = event['type'];
          if (!['progress', 'answer_start', 'tool_start', 'tool_result', 'done']
              .contains(type)) {
            return;
          }
          setState(() {
            final current = messages.last;
            var text = current.text;
            if (type == 'progress') {
              stageStatus = '${event['text'] ?? ''}';
            } else if (type == 'answer_start') {
              text = '';
              activeTools.clear();
              stageStatus = '白羽正在作答…';
            } else if (type == 'tool_start') {
              activeTools['${event['sequence'] ?? event['name']}'] =
                  '${event['text'] ?? '白羽正在调用工具…'}';
            } else if (type == 'tool_result') {
              activeTools.remove('${event['sequence'] ?? event['name']}');
              stageStatus = '${event['text'] ?? '白羽正在核对查询结果…'}';
            } else {
              activeTools.clear();
              stageStatus = '';
            }
            messages[messages.length - 1] = _ChatMessage(text, false,
                cards: current.cards,
                actions: current.actions,
                plan: current.plan,
                status: activeTools.isEmpty
                    ? stageStatus
                    : activeTools.values.join('\n'));
          });
          _scrollToBottom(force: false);
        },
        onDelta: (delta) {
          if (!current()) return;
          setState(() {
            final current = messages.last;
            final next =
                current.text == '白羽酱正在思考中…' ? delta : '${current.text}$delta';
            messages[messages.length - 1] = _ChatMessage(next, false,
                cards: current.cards,
                actions: current.actions,
                plan: current.plan,
                status: current.status);
          });
          _scrollToBottom(force: false);
        },
      );
      if (!current()) return;
      setState(() {
        currentSessionId = result.sessionId;
        if (currentSessionTitle == '新对话') currentSessionTitle = text;
        messages[messages.length - 1] = _ChatMessage(
          result.answer,
          false,
          cards: result.cards,
          actions: result.actions,
          plan: result.plan,
        );
        suggestions = result.suggestions;
      });
      try {
        await GStorage.runAccountTask(
            () => _handleActions(result, isCurrentRequest: current));
      } catch (_) {
        if (current()) {
          KazumiDialog.showToast(message: '回答已完成，App 本地状态同步失败，请刷新后查看');
        }
      }
      if (AniWorldApi.isLoggedIn) await _refreshSessions();
    } catch (error) {
      if (!current()) return;
      setState(() {
        messages[messages.length - 1] = const _ChatMessage(
          '本次请求已停止或暂时失败，请稍后再试。',
          false,
        );
      });
    } finally {
      if (current()) {
        setState(() => loading = false);
        _agentCancelToken = null;
      }
      if (current()) _scrollToBottom(force: false);
    }
  }

  Future<void> _cancelAgent() async {
    final token = _agentCancelToken;
    if (token == null) return;
    token.cancel('user_cancelled');
    final id = _agentRequestId;
    if (id.isNotEmpty) {
      try {
        await AniWorldApi.cancelAgentRequest(id);
      } catch (_) {}
    }
  }

  Map<String, dynamic> _pageContext() {
    VideoPageController? controller;
    final argument = Modular.args.data;
    if (argument is VideoPageController) {
      controller = argument;
    } else {
      try {
        controller = Modular.get<VideoPageController>();
      } catch (_) {}
    }
    if (controller != null) {
      try {
        final item = controller.bangumiItem;
        final identity = AniWorldApi.userAnimeIdentity(item);
        return {
          'page': '/video/',
          'anilistId': identity['anilist_id'],
          'title': item.nameCn.isNotEmpty ? item.nameCn : item.name,
          'msg': identity['anime_msg'],
          'n': identity['anime_n'],
          'image': identity['anime_image'],
          'episode': '${controller.selectedEpisode.episode}',
          'episodeIndex': controller.selectedEpisode.episode,
          'playing': controller.playingEpisode != null,
        };
      } catch (_) {}
    }
    return const {};
  }

  Future<void> _showMemory() async {
    if (!AniWorldApi.isLoggedIn) {
      KazumiDialog.showToast(message: '登录后才能查看白羽记忆');
      return;
    }
    final memoryAccountToken = AniWorldApi.token;
    try {
      final overview = await AniWorldApi.getAgentMemoryOverview();
      final profile = overview['profile'] is Map
          ? Map<String, dynamic>.from(overview['profile'] as Map)
          : <String, dynamic>{};
      final memories = (overview['results'] as List? ?? const [])
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
      final memoryItems = (profile['memoryItems'] as List? ?? const [])
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
      if (!mounted || memoryAccountToken != AniWorldApi.token) return;
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (sheetContext) => SafeArea(
          child: SizedBox(
            height: MediaQuery.sizeOf(sheetContext).height * .7,
            child: Column(children: [
              ListTile(
                title: const Text('白羽记忆'),
                subtitle: const Text('用于保持偏好和对话连续性，可随时清除'),
                trailing: TextButton(
                  onPressed: () async {
                    final confirmed = await showDialog<bool>(
                          context: sheetContext,
                          builder: (context) => AlertDialog(
                            title: const Text('清除全部记忆与聊天记录？'),
                            content: const Text(
                              '清除 Agent 记忆与聊天记录，观看历史和追番会保留。',
                            ),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.pop(context, false),
                                child: const Text('取消'),
                              ),
                              FilledButton(
                                onPressed: () => Navigator.pop(context, true),
                                child: const Text('清除'),
                              ),
                            ],
                          ),
                        ) ??
                        false;
                    if (!confirmed || memoryAccountToken != AniWorldApi.token) {
                      return;
                    }
                    try {
                      await AniWorldApi.clearAgentMemory();
                      if (!mounted || memoryAccountToken != AniWorldApi.token) {
                        return;
                      }
                      if (sheetContext.mounted) Navigator.pop(sheetContext);
                      _newConversation();
                      await _refreshSessions();
                      KazumiDialog.showToast(message: '白羽记忆已清除');
                    } catch (_) {
                      KazumiDialog.showToast(message: '清除未完成，请等待当前对话结束后重试');
                    }
                  },
                  child: const Text('全部清除'),
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  children: [
                    _memoryProfileCard(profile),
                    const SizedBox(height: 12),
                    if (memoryItems.isNotEmpty) ...[
                      Text('已记住的偏好与信息',
                          style: Theme.of(sheetContext).textTheme.titleMedium),
                      ...memoryItems.map((item) => Card(
                            child: ListTile(
                              title: Text('${item['value'] ?? ''}'),
                              trailing: IconButton(
                                tooltip: '忘记这条信息',
                                icon: const Icon(Icons.delete_outline),
                                onPressed: () async {
                                  if (memoryAccountToken != AniWorldApi.token) {
                                    return;
                                  }
                                  try {
                                    await AniWorldApi.forgetAgentMemoryItem(
                                        '${item['id'] ?? ''}');
                                    if (!mounted ||
                                        memoryAccountToken !=
                                            AniWorldApi.token) {
                                      return;
                                    }
                                    if (sheetContext.mounted) {
                                      Navigator.pop(sheetContext);
                                    }
                                    _showMemory();
                                  } catch (_) {
                                    KazumiDialog.showToast(
                                        message: '删除未完成，请等待当前对话结束后重试');
                                  }
                                },
                              ),
                            ),
                          )),
                      const SizedBox(height: 12),
                    ],
                    if (memories.isEmpty && memoryItems.isEmpty)
                      const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(child: Text('目前没有已保存的记忆')),
                      )
                    else if (memories.isNotEmpty) ...[
                      Text('记忆来源',
                          style: Theme.of(sheetContext).textTheme.titleMedium),
                      const SizedBox(height: 4),
                      ...memories.map((item) {
                        final questions =
                            (item['recentQuestions'] as List? ?? const [])
                                .map((value) => '$value')
                                .where((value) => value.trim().isNotEmpty)
                                .toList();
                        final titles = (item['titles'] as List? ?? const [])
                            .map((value) => '$value')
                            .where((value) => value.trim().isNotEmpty)
                            .toList();
                        final id = '${item['sessionId'] ?? ''}';
                        return Card(
                          margin: const EdgeInsets.only(bottom: 8),
                          child: ListTile(
                            title: Text('${item['title'] ?? '对话记忆'}'),
                            subtitle: Text(
                              [
                                if (questions.isNotEmpty)
                                  '最近咨询：${questions.join('；')}',
                                if (titles.isNotEmpty)
                                  '涉及作品：${titles.join('、')}',
                              ].join('\n'),
                              maxLines: 4,
                              overflow: TextOverflow.ellipsis,
                            ),
                            isThreeLine: true,
                            trailing: IconButton(
                              tooltip: '删除这条记忆',
                              icon: const Icon(Icons.delete_outline),
                              onPressed: () async {
                                if (id.isEmpty) return;
                                await AniWorldApi.clearAgentSessionMemory(id);
                                if (sheetContext.mounted) {
                                  Navigator.pop(sheetContext);
                                }
                                _showMemory();
                              },
                            ),
                          ),
                        );
                      }),
                    ],
                  ],
                ),
              ),
            ]),
          ),
        ),
      );
    } catch (_) {
      KazumiDialog.showToast(message: '记忆加载失败，请稍后重试');
    }
  }

  Widget _memoryProfileCard(Map<String, dynamic> profile) {
    List<String> values(dynamic raw) => (raw is List ? raw : const [])
        .where((item) => item != null)
        .map((item) {
          if (item is Map) return '${item['name'] ?? item['title'] ?? ''}';
          return '$item';
        })
        .where((item) => item.trim().isNotEmpty)
        .toList();
    final genres = values(profile['genres']);
    final tags = values(profile['tags']);
    final titles = values(profile['referencedTitles']);
    final questions = values(profile['recentQuestions']);
    final preferenceMap = profile['preferences'] is Map
        ? Map<String, dynamic>.from(profile['preferences'] as Map)
        : <String, dynamic>{};
    final liked = values(preferenceMap['positive']);
    final disliked = values(preferenceMap['negative']);
    final constraints = values(preferenceMap['constraints']);
    final status = profile['preferredStatus'] == 'FINISHED' ? '偏好已完结作品' : '';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('个性化画像', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 6),
          Text(profile['personalized'] == true
              ? '根据追番、观看和反馈逐步形成'
              : '完成一些观看或追番后会逐步形成'),
          if (genres.isNotEmpty || tags.isNotEmpty || status.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(spacing: 6, runSpacing: 6, children: [
              ...genres.take(6).map((value) => Chip(label: Text(value))),
              ...tags.take(6).map((value) => Chip(label: Text(value))),
              if (status.isNotEmpty) Chip(label: Text(status)),
            ]),
          ],
          if (liked.isNotEmpty ||
              disliked.isNotEmpty ||
              constraints.isNotEmpty) ...[
            const SizedBox(height: 10),
            if (liked.isNotEmpty) Text('明确喜欢：${liked.take(3).join('；')}'),
            if (disliked.isNotEmpty) Text('明确避开：${disliked.take(3).join('；')}'),
            if (constraints.isNotEmpty)
              Text('推荐约束：${constraints.take(3).join('；')}'),
          ],
          if (questions.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('最近咨询', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 4),
            Text(questions.take(5).join('\n')),
          ],
          if (titles.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text('近期涉及作品', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 4),
            Text(titles.take(10).join('、')),
          ],
        ]),
      ),
    );
  }

  Future<void> _handleActions(AniWorldAgentChatResult result,
      {bool Function()? isCurrentRequest}) async {
    final account = AniWorldAccountSnapshot();
    if (result.actions.isEmpty || !mounted || !account.isCurrent) return;
    AniWorldAgentCard? targetCard(Map<String, dynamic> action) {
      if (action['card'] is Map) {
        return AniWorldAgentCard.fromJson(
            Map<String, dynamic>.from(action['card']));
      }
      return result.cards.cast<AniWorldAgentCard?>().firstWhere(
          (card) => card?.anilistId == action['anilistId'],
          orElse: () => null);
    }

    // Mirror committed state before navigation, which may await an entire video page.
    for (final action in result.actions) {
      if (!mounted || !account.isCurrent) return;
      final type = '${action['type'] ?? ''}';
      if (type == 'collect') {
        final card = targetCard(action);
        if (card == null) throw StateError('操作回执缺少作品信息');
        await Modular.get<CollectController>().applyAgentCollect(
            card.toBangumiItem(),
            remove: '${action['operation'] ?? ''}' != 'add',
            type: int.tryParse(
                    '${action['collectType'] ?? CollectType.planToWatch.value}') ??
                CollectType.planToWatch.value);
      } else if (type == 'history_remove') {
        final canonical = int.tryParse('${action['anilistId'] ?? 0}') ?? 0;
        final id = canonical > 0
            ? canonical
            : targetCard(action)?.toBangumiItem().id ?? 0;
        if (id > 0) await Modular.get<HistoryController>().deleteForAgent(id);
      }
    }
    if (!mounted || !account.isCurrent || isCurrentRequest?.call() == false) {
      return;
    }
    final playAction = result.actions
        .cast<Map<String, dynamic>?>()
        .firstWhere((action) => action?['type'] == 'play', orElse: () => null);
    final playCard = playAction == null ? null : targetCard(playAction);
    if (playAction != null && playCard != null) {
      await Modular.get<PluginsController>().preparePlaybackSources();
      if (!mounted || !account.isCurrent || isCurrentRequest?.call() == false) {
        return;
      }
      final info = InfoController()..bangumiItem = playCard.toBangumiItem();
      await showAdaptiveBottomSheet<void>(
        context: context,
        maxHeightFactor: 0.86,
        compactLandscapeMaxHeightFactor: 0.95,
        builder: (_) => SourceSheet(
          infoController: info,
          explicitStart: true,
          initialEpisode: playAction['episodeExplicit'] == true
              ? int.tryParse('${playAction['episode']}')
              : null,
          resume: playAction['resume'] == true,
        ),
      );
      return;
    }
    for (final action in result.actions) {
      if ('${action['type'] ?? ''}' != 'navigate') continue;
      final url = '${action['url'] ?? ''}';
      final delay = int.tryParse('${action['delayMs'] ?? 0}') ?? 0;
      if (delay > 0) {
        await Future<void>.delayed(
            Duration(milliseconds: delay.clamp(0, 1500)));
      }
      if (!mounted || !account.isCurrent || isCurrentRequest?.call() == false) {
        return;
      }
      if (url == '/my.html') {
        Modular.to.navigate('/tab/my/');
      } else if ((url.startsWith('/anime.html') ||
              url.startsWith('/search_anime.html')) &&
          result.cards.isNotEmpty) {
        Modular.to
            .pushNamed('/info/', arguments: result.cards.first.toBangumiItem());
      }
    }
  }

  Widget _buildAgentCard(AniWorldAgentCard card) {
    final colorScheme = Theme.of(context).colorScheme;
    final status = card.status == 'FINISHED'
        ? '已完结'
        : card.status == 'RELEASING'
            ? '连载中'
            : '';
    final meta = [
      if (card.score > 0) '★ ${card.score.toStringAsFixed(1)}',
      if (card.year.isNotEmpty) card.year,
      if (status.isNotEmpty) status,
    ].join(' · ');
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: () => Modular.to.pushNamed(
        '/info/',
        arguments: card.toBangumiItem(),
      ),
      child: Container(
        width: 286,
        padding: const EdgeInsets.all(9),
        decoration: BoxDecoration(
          color: colorScheme.surfaceContainer,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: colorScheme.outlineVariant),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(9),
              child: NetworkImgLayer(
                src: card.image,
                width: 64,
                height: 88,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    card.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  if (meta.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(meta, style: Theme.of(context).textTheme.bodySmall),
                  ],
                  if (card.reason.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      card.reason,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(AniWorldApi.isLoggedIn ? '白羽' : '白羽（未登录）'),
            if (currentSessionId.isNotEmpty)
              Text(
                currentSessionTitle,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: '新对话',
            onPressed: _newConversation,
            icon: const Icon(Icons.add_comment_outlined),
          ),
          IconButton(
            tooltip: '历史对话',
            onPressed: loading || loadingHistory ? null : _showHistory,
            icon: loadingHistory
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.history_rounded),
          ),
          IconButton(
            tooltip: '白羽记忆',
            onPressed: _showMemory,
            icon: const Icon(Icons.psychology_alt_outlined),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              controller: scrollController,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              itemCount: messages.length,
              itemBuilder: (context, index) {
                final item = messages[index];
                return Align(
                  alignment:
                      item.mine ? Alignment.centerRight : Alignment.centerLeft,
                  child: Column(
                    crossAxisAlignment: item.mine
                        ? CrossAxisAlignment.end
                        : CrossAxisAlignment.start,
                    children: [
                      if (item.text.isNotEmpty)
                        Container(
                          constraints: BoxConstraints(
                            maxWidth: MediaQuery.sizeOf(context).width * 0.82,
                          ),
                          margin: const EdgeInsets.symmetric(vertical: 6),
                          padding: const EdgeInsets.symmetric(
                              horizontal: 14, vertical: 10),
                          decoration: BoxDecoration(
                            color: item.mine
                                ? colorScheme.primary
                                : colorScheme.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(16),
                          ),
                          child: Text(
                            item.text,
                            style: TextStyle(
                              color: item.mine
                                  ? colorScheme.onPrimary
                                  : colorScheme.onSurface,
                              fontSize: 14,
                              height: 1.45,
                            ),
                          ),
                        ),
                      if (!item.mine && item.status.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const SizedBox(
                                  width: 12,
                                  height: 12,
                                  child: CircularProgressIndicator(
                                      strokeWidth: 2)),
                              const SizedBox(width: 8),
                              Flexible(
                                  child: Text(item.status,
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall)),
                            ],
                          ),
                        ),
                      if (!item.mine && item.plan.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Text('行动计划：${item.plan.join(' → ')}',
                              style: Theme.of(context).textTheme.bodySmall),
                        ),
                      if (item.actions
                          .any((action) => action['type'] == 'confirm'))
                        Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: Row(mainAxisSize: MainAxisSize.min, children: [
                            FilledButton(
                                onPressed: loading
                                    ? null
                                    : () {
                                        input.text = '确认';
                                        send(
                                            confirmationId:
                                                '${item.actions.firstWhere((action) => action['type'] == 'confirm')['operationId'] ?? ''}');
                                      },
                                child: const Text('确认')),
                            const SizedBox(width: 8),
                            OutlinedButton(
                                onPressed: loading
                                    ? null
                                    : () {
                                        input.text = '取消';
                                        send(
                                            confirmationId:
                                                '${item.actions.firstWhere((action) => action['type'] == 'confirm')['operationId'] ?? ''}');
                                      },
                                child: const Text('取消')),
                          ]),
                        ),
                      if (item.cards.isNotEmpty)
                        SizedBox(
                          height: 112,
                          width: MediaQuery.sizeOf(context).width * 0.88,
                          child: ListView.separated(
                            scrollDirection: Axis.horizontal,
                            itemCount: item.cards.length,
                            separatorBuilder: (_, __) =>
                                const SizedBox(width: 8),
                            itemBuilder: (_, cardIndex) =>
                                _buildAgentCard(item.cards[cardIndex]),
                          ),
                        ),
                    ],
                  ),
                );
              },
            ),
          ),
          SafeArea(
            top: false,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (suggestions.isNotEmpty)
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
                    child: Row(
                      children: suggestions
                          .map((text) => Padding(
                                padding: const EdgeInsets.only(right: 8),
                                child: ActionChip(
                                  label: Text(text),
                                  onPressed: loading
                                      ? null
                                      : () {
                                          input.text = text;
                                          send();
                                        },
                                ),
                              ))
                          .toList(),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: input,
                          minLines: 1,
                          maxLines: 3,
                          decoration: InputDecoration(
                            hintText: '问我动漫推荐、更新或作品信息…',
                            filled: true,
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(22),
                              borderSide: BorderSide.none,
                            ),
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 16,
                              vertical: 11,
                            ),
                          ),
                          onSubmitted: (_) => send(),
                        ),
                      ),
                      const SizedBox(width: 10),
                      FilledButton(
                        onPressed: loading ? _cancelAgent : send,
                        child: Icon(
                            loading ? Icons.stop_rounded : Icons.send_rounded),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
