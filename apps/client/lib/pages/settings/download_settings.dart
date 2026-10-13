import 'package:kazumi/bean/settings/settings_list.dart';
import 'package:kazumi/bean/settings/settings_detail_scaffold.dart';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:kazumi/services/storage/storage.dart';


class DownloadSettingsPage extends StatefulWidget {
  const DownloadSettingsPage({super.key});

  @override
  State<DownloadSettingsPage> createState() => _DownloadSettingsPageState();
}

class _DownloadSettingsPageState extends State<DownloadSettingsPage> {
  late int parallelEpisodes;
  late int parallelSegments;
  late bool downloadDanmaku;
  String downloadDirectory = '';
  String defaultDownloadDirectory = '';
  bool selectingDirectory = false;

  @override
  void initState() {
    super.initState();
    parallelEpisodes =
        GStorage.getSetting(SettingsKeys.downloadParallelEpisodes);
    parallelSegments =
        GStorage.getSetting(SettingsKeys.downloadParallelSegments);
    downloadDanmaku = GStorage.getSetting(SettingsKeys.downloadDanmaku);
    downloadDirectory =
        GStorage.getSetting<String>(SettingsKeys.downloadDirectory).trim();
    _loadDefaultDirectory();
  }

  Future<void> _loadDefaultDirectory() async {
    final support = await getApplicationSupportDirectory();
    if (!mounted) return;
    setState(() => defaultDownloadDirectory = '${support.path}/downloads');
  }

  Future<void> _chooseDirectory() async {
    if (!Platform.isWindows && !Platform.isMacOS && !Platform.isLinux) return;
    if (selectingDirectory) return;
    setState(() => selectingDirectory = true);
    try {
      final controller = TextEditingController(
        text: downloadDirectory.isNotEmpty
            ? downloadDirectory
            : defaultDownloadDirectory,
      );
      final selected = await showDialog<String>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('选择下载位置'),
          content: TextField(
            controller: controller,
            autofocus: true,
            decoration: const InputDecoration(hintText: '输入目录路径'),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, controller.text),
              child: const Text('确定'),
            ),
          ],
        ),
      );
      controller.dispose();
      if (selected != null && selected.isNotEmpty) {
        await Directory(selected).create(recursive: true);
        await GStorage.putSetting(SettingsKeys.downloadDirectory, selected);
        if (mounted) setState(() => downloadDirectory = selected);
      }
    } finally {
      if (mounted) setState(() => selectingDirectory = false);
    }
  }

  Future<void> _resetDirectory() async {
    await GStorage.putSetting(SettingsKeys.downloadDirectory, '');
    if (mounted) setState(() => downloadDirectory = '');
  }

  @override
  Widget build(BuildContext context) {
    final fontFamily = Theme.of(context).textTheme.bodyMedium?.fontFamily;
    return SettingsDetailScaffold(
      title: const Text('下载设置'),
      body: SettingsList(
        maxWidth: 1000,
        sections: [
          SettingsSection(
            title: Text('并发设置', style: TextStyle(fontFamily: fontFamily)),
            tiles: [
              SettingsTile(
                leading: Icons.video_library_rounded,
                title: Text('同时下载集数', style: TextStyle(fontFamily: fontFamily)),
                description: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '同时下载 $parallelEpisodes 集',
                      style: TextStyle(fontFamily: fontFamily),
                    ),
                    Slider(
                      value: parallelEpisodes.toDouble(),
                      min: 1,
                      max: 5,
                      divisions: 4,
                      label: '$parallelEpisodes',
                      onChanged: (value) {
                        setState(() => parallelEpisodes = value.toInt());
                        GStorage.putSetting(
                          SettingsKeys.downloadParallelEpisodes,
                          parallelEpisodes,
                        );
                      },
                    ),
                  ],
                ),
              ),
              SettingsTile(
                leading: Icons.call_split_rounded,
                title: Text('分片并发数', style: TextStyle(fontFamily: fontFamily)),
                description: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '每集同时下载 $parallelSegments 个分片',
                      style: TextStyle(fontFamily: fontFamily),
                    ),
                    Slider(
                      value: parallelSegments.toDouble(),
                      min: 1,
                      max: 10,
                      divisions: 9,
                      label: '$parallelSegments',
                      onChanged: (value) {
                        setState(() => parallelSegments = value.toInt());
                        GStorage.putSetting(
                          SettingsKeys.downloadParallelSegments,
                          parallelSegments,
                        );
                      },
                    ),
                  ],
                ),
              ),
            ],
          ),
          SettingsSection(
            title: Text('缓存设置', style: TextStyle(fontFamily: fontFamily)),
            tiles: [
              SettingsTile(
                leading: Icons.folder_rounded,
                title: Text('下载位置', style: TextStyle(fontFamily: fontFamily)),
                description: Text(
                  downloadDirectory.isEmpty
                      ? (defaultDownloadDirectory.isEmpty
                          ? '正在读取默认位置…'
                          : defaultDownloadDirectory)
                      : downloadDirectory,
                  style: TextStyle(fontFamily: fontFamily),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: selectingDirectory
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : downloadDirectory.isNotEmpty
                        ? IconButton(
                            tooltip: '恢复默认',
                            icon: const Icon(Icons.restore_rounded),
                            onPressed: _resetDirectory,
                          )
                        : const Icon(Icons.chevron_right_rounded),
                onPressed: (_) => _chooseDirectory(),
              ),
              SettingsTile.switchTile(
                leading: Icons.subtitles_rounded,
                onToggle: (value) {
                  setState(() => downloadDanmaku = value ?? !downloadDanmaku);
                  GStorage.putSetting(
                      SettingsKeys.downloadDanmaku, downloadDanmaku);
                },
                title: Text('缓存弹幕', style: TextStyle(fontFamily: fontFamily)),
                description: Text(
                  '下载视频时同时缓存弹幕数据',
                  style: TextStyle(fontFamily: fontFamily),
                ),
                initialValue: downloadDanmaku,
              ),
            ],
          ),
          SettingsSection(
            title: Text('说明', style: TextStyle(fontFamily: fontFamily)),
            tiles: [
              SettingsTile(
                leading: Icons.info_outline_rounded,
                title: Text('关于并发设置', style: TextStyle(fontFamily: fontFamily)),
                description: Text(
                  '• 集数并发：同时下载多少集视频\n'
                  '• 分片并发：每集内同时下载多少个视频片段\n'
                  '• 较高的并发可提升速度，但可能被服务器限制\n'
                  '• 修改后对新开始的下载生效',
                  style: TextStyle(fontFamily: fontFamily),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
