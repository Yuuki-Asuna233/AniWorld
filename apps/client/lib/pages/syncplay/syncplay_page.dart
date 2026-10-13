import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/plugins/plugins_controller.dart';
import 'package:kazumi/pages/video/video_controller.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/services/player/syncplay_session_controller.dart';
import 'package:kazumi/services/storage/storage.dart';

class SyncPlayPage extends StatefulWidget {
  const SyncPlayPage({super.key});

  @override
  State<SyncPlayPage> createState() => _SyncPlayPageState();
}

class _SyncPlayPageState extends State<SyncPlayPage> {
  final SyncPlaySessionController session =
      Modular.get<SyncPlaySessionController>();
  static final Random _random = Random();
  bool _openingPlayback = false;

  String _generateRoom() => List.generate(8, (_) => _random.nextInt(10)).join();

  String _generateUserName() {
    const consonants = 'bcdfghjklmnpqrstvwxyz';
    const vowels = 'aeiou';
    final buffer = StringBuffer();
    for (var i = 0; i < 4; i++) {
      buffer.write(consonants[_random.nextInt(consonants.length)]);
      buffer.write(vowels[_random.nextInt(vowels.length)]);
    }
    final value = buffer.toString();
    return value[0].toUpperCase() + value.substring(1);
  }

  String _savedUserName() {
    final saved = GStorage.getSetting<String>(SettingsKeys.syncPlayUserName);
    if (saved.trim().isNotEmpty) return saved.trim();
    return _generateUserName();
  }

  Future<void> _showRoomDialog({required bool asHost}) async {
    final formKey = GlobalKey<FormState>();
    final roomController =
        TextEditingController(text: asHost ? _generateRoom() : '');
    final usernameController = TextEditingController(text: _savedUserName());
    final result = await showDialog<(String, String)>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(asHost ? '创建一起看房间' : '加入一起看房间'),
        content: Form(
          key: formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (asHost)
                TextFormField(
                  controller: roomController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: '房间号'),
                  validator: (value) =>
                      RegExp(r'^[0-9]{6,10}$').hasMatch(value?.trim() ?? '')
                          ? null
                          : '请输入 6-10 位数字房间号',
                )
              else
                TextFormField(
                  controller: roomController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(labelText: '房间号'),
                  validator: (value) =>
                      RegExp(r'^[0-9]{6,10}$').hasMatch(value?.trim() ?? '')
                          ? null
                          : '请输入 6-10 位数字房间号',
                ),
              const SizedBox(height: 12),
              TextFormField(
                controller: usernameController,
                decoration: const InputDecoration(labelText: '昵称（英文）'),
                validator: (value) =>
                    RegExp(r'^[a-zA-Z]{4,12}$').hasMatch(value?.trim() ?? '')
                        ? null
                        : '昵称需为 4-12 位英文字母',
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () {
              if (formKey.currentState?.validate() ?? false) {
                Navigator.of(context).pop((
                  roomController.text.trim(),
                  usernameController.text.trim(),
                ));
              }
            },
            child: Text(asHost ? '创建并加入' : '加入房间'),
          ),
        ],
      ),
    );
    roomController.dispose();
    usernameController.dispose();
    if (result == null || !mounted) return;
    await GStorage.putSetting(SettingsKeys.syncPlayUserName, result.$2);
    try {
      await session.connect(
        nextRoom: result.$1,
        nextUsername: result.$2,
        asHost: asHost,
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('一起看连接失败：$error')),
        );
      }
    }
  }

  ({int id, int episode, String source, String title})? _parseFile(
      String value) {
    final match = RegExp(r'^(\d+)\[(\d+)\](?:\|(.*))?$').firstMatch(value);
    if (match == null) return null;
    final id = int.tryParse(match.group(1) ?? '') ?? 0;
    final episode = int.tryParse(match.group(2) ?? '') ?? 0;
    final payload = match.group(3) ?? '';
    final separator = payload.indexOf('|');
    if (id <= 0 || episode <= 0) return null;
    try {
      return (
        id: id,
        episode: episode,
        source: separator < 0
            ? ''
            : Uri.decodeComponent(payload.substring(0, separator)),
        title: Uri.decodeComponent(
            separator < 0 ? payload : payload.substring(separator + 1))
      );
    } on FormatException {
      return null;
    }
  }

  Future<void> _openHostPlayback() async {
    if (_openingPlayback || session.currentFileName.isEmpty) return;
    final fileName = session.currentFileName;
    final connection = session.client;
    bool current() =>
        mounted &&
        session.isGuest &&
        identical(connection, session.client) &&
        connection != null &&
        session.currentFileName == fileName;
    final parsed = _parseFile(fileName);
    if (parsed == null) return;
    if (!current()) return;
    setState(() => _openingPlayback = true);
    try {
      BangumiItem? item;
      if (parsed.title.isNotEmpty) {
        final candidates = await AniWorldApi.searchOi(parsed.title);
        if (!current()) return;
        for (final candidate in candidates) {
          if (candidate.id == parsed.id) {
            item = candidate;
            break;
          }
        }
        final exact = candidates
            .where((item) =>
                (item.nameCn.isNotEmpty ? item.nameCn : item.name).trim() ==
                parsed.title)
            .toList();
        if (item == null && exact.length == 1) item = exact.single;
      }
      if (item == null) {
        throw StateError('无法解析房主正在播放的动漫');
      }
      final controller = VideoPageController();
      controller.bangumiItem = item;
      controller.title = item.nameCn.isNotEmpty ? item.nameCn : item.name;
      controller.src = parsed.source.isEmpty ? 'AniWorld' : parsed.source;
      if (parsed.source.isNotEmpty &&
          parsed.source.toLowerCase() != 'aniworld') {
        final plugin = Modular.get<PluginsController>().pluginList.firstWhere(
              (item) => item.name.toLowerCase() == parsed.source.toLowerCase(),
              orElse: () => throw StateError('找不到房主使用的播放源：${parsed.source}'),
            );
        controller.currentPlugin = plugin;
      }
      controller.syncPlayInitialEpisode = parsed.episode;
      controller.syncPlayInitialFileName = fileName;
      controller.resetEpisodeState(episode: parsed.episode, road: 0);
      controller.beginQueryRoads(
        parsed.source.isEmpty || parsed.source.toLowerCase() == 'aniworld'
            ? 'AniWorld'
            : controller.currentPlugin.baseUrl,
        parsed.source.isEmpty ? 'AniWorld' : parsed.source,
      );
      await Modular.to.pushNamed('/video/', arguments: controller);
    } catch (error) {
      if (mounted && current()) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$error')),
        );
      }
    } finally {
      if (mounted) setState(() => _openingPlayback = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: session,
      builder: (context, _) {
        final parsed = _parseFile(session.currentFileName);
        final connected = session.hasSession;
        return Scaffold(
          appBar: AppBar(title: const Text('一起看')),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 32),
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        connected ? '已连接一起看房间' : '和朋友同步看番',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 8),
                      Text(connected
                          ? '房间号：${session.room}\n房主：${session.ownerName.isEmpty ? '等待房主信息' : session.ownerName}\n身份：${session.isHost ? '房主' : '访客'}'
                          : '创建房间后分享房间号，朋友加入后会跟随房主的动漫、集数和播放进度。'),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (!connected) ...[
                FilledButton.icon(
                  onPressed: () => _showRoomDialog(asHost: true),
                  icon: const Icon(Icons.add_link_rounded),
                  label: const Text('创建房间'),
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () => _showRoomDialog(asHost: false),
                  icon: const Icon(Icons.login_rounded),
                  label: const Text('加入房间'),
                ),
              ] else ...[
                if (parsed != null)
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.live_tv_rounded),
                      title:
                          Text(parsed.title.isEmpty ? '房主正在播放' : parsed.title),
                      subtitle: Text('第 ${parsed.episode} 集'),
                      trailing: FilledButton(
                        onPressed: _openingPlayback ? null : _openHostPlayback,
                        child: const Text('进入播放'),
                      ),
                    ),
                  )
                else
                  const Card(
                    child: ListTile(
                      leading: Icon(Icons.hourglass_empty_rounded),
                      title: Text('等待房主开始播放'),
                      subtitle: Text('房主打开播放页后，这里会显示当前动漫和集数'),
                    ),
                  ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: () => session.disconnect(),
                  icon: const Icon(Icons.logout_rounded),
                  label: const Text('退出房间'),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}
