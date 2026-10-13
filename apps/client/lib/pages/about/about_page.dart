import 'package:kazumi/bean/settings/settings_list.dart';
import 'package:kazumi/bean/settings/settings_detail_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/pages/my/my_controller.dart';
import 'package:kazumi/request/config/api_endpoints.dart';
import 'package:kazumi/utils/dandan_credentials.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/cache/app_cache_service.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:kazumi/utils/device.dart';

class AboutPage extends StatefulWidget {
  const AboutPage({super.key});

  @override
  State<AboutPage> createState() => _AboutPageState();
}

class _AboutPageState extends State<AboutPage> {
  final exitBehaviorTitles = <String>['退出 Kazumi', '最小化至托盘', '每次都询问'];
  late dynamic defaultDanmakuArea;
  late dynamic defaultThemeMode;
  late dynamic defaultThemeColor;
  late int exitBehavior = GStorage.getSetting(SettingsKeys.exitBehavior);
  late bool autoUpdate;
  double _cacheSizeMB = -1;
  final MyController myController = Modular.get<MyController>();
  final MenuController menuController = MenuController();

  @override
  void initState() {
    super.initState();
    autoUpdate = GStorage.getSetting(SettingsKeys.autoUpdate);
    _getCacheSize();
  }

  void onBackPressed(BuildContext context) {
    if (KazumiDialog.observer.hasKazumiDialog) {
      KazumiDialog.dismiss();
      return;
    }
  }

  Future<void> _getCacheSize() async {
    final totalSizeBytes = await AppCacheService.instance.sizeInBytes();
    final totalSizeMB = totalSizeBytes / (1024 * 1024);
    if (mounted) {
      setState(() {
        _cacheSizeMB = totalSizeMB;
      });
    }
  }

  Future<void> _clearCache() async {
    await AppCacheService.instance.clear();
    await _getCacheSize();
  }

  void _showCacheDialog() {
    KazumiDialog.show(
      builder: (context) {
        return AlertDialog(
          title: const Text('缓存管理'),
          content: const Text('缓存包含番剧封面和首页数据，清除后需要重新下载。确认清除吗？'),
          actions: [
            TextButton(
              onPressed: () {
                KazumiDialog.dismiss();
              },
              child: Text(
                '取消',
                style: TextStyle(color: Theme.of(context).colorScheme.outline),
              ),
            ),
            TextButton(
              onPressed: () async {
                try {
                  _clearCache();
                } catch (_) {}
                KazumiDialog.dismiss();
              },
              child: const Text('确认'),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final fontFamily = Theme.of(context).textTheme.bodyMedium?.fontFamily;
    return PopScope(
      canPop: true,
      onPopInvokedWithResult: (bool didPop, Object? result) async {
        onBackPressed(context);
      },
      child: SettingsDetailScaffold(
        title: const Text('关于'),
        // backgroundColor: Colors.transparent,
        body: SettingsList(
          maxWidth: 1000,
          sections: [
            // Keep only operational storage/logs and application update.
            if (false) ...[
            SettingsSection(
              tiles: [
                SettingsTile.navigation(
                  onPressed: (_) {
                    Modular.to.pushNamed('/settings/about/license');
                  },
                  title:
                      Text('开源许可证', style: TextStyle(fontFamily: fontFamily)),
                  description: Text('查看所有开源许可证',
                      style: TextStyle(fontFamily: fontFamily)),
                ),
              ],
            ),
            SettingsSection(
              title: Text('外部链接', style: TextStyle(fontFamily: fontFamily)),
              tiles: [
                SettingsTile.navigation(
                  onPressed: (_) {
                    launchUrl(Uri.parse(ApiEndpoints.projectUrl),
                        mode: LaunchMode.externalApplication);
                  },
                  title: Text('项目主页', style: TextStyle(fontFamily: fontFamily)),
                ),
                SettingsTile.navigation(
                  onPressed: (_) {
                    launchUrl(Uri.parse(ApiEndpoints.sourceUrl),
                        mode: LaunchMode.externalApplication);
                  },
                  title: Text('代码仓库', style: TextStyle(fontFamily: fontFamily)),
                  value:
                      Text('Github', style: TextStyle(fontFamily: fontFamily)),
                ),
                SettingsTile.navigation(
                  onPressed: (_) {
                    launchUrl(Uri.parse(ApiEndpoints.iconUrl),
                        mode: LaunchMode.externalApplication);
                  },
                  title: Text('项目资源', style: TextStyle(fontFamily: fontFamily)),
                  value:
                      Text('AniWorld', style: TextStyle(fontFamily: fontFamily)),
                ),
                SettingsTile.navigation(
                  onPressed: (_) {
                    launchUrl(Uri.parse(ApiEndpoints.bangumiIndex),
                        mode: LaunchMode.externalApplication);
                  },
                  title: Text('番剧索引', style: TextStyle(fontFamily: fontFamily)),
                  value:
                      Text('Bangumi', style: TextStyle(fontFamily: fontFamily)),
                ),
                SettingsTile.navigation(
                  onPressed: (_) {
                    launchUrl(Uri.parse('https://trace.moe'),
                        mode: LaunchMode.externalApplication);
                  },
                  title: Text('以图搜番', style: TextStyle(fontFamily: fontFamily)),
                  value: Text('trace.moe',
                      style: TextStyle(fontFamily: fontFamily)),
                ),
                SettingsTile.navigation(
                  onPressed: (_) {
                    launchUrl(Uri.parse(ApiEndpoints.dandanIndex),
                        mode: LaunchMode.externalApplication);
                  },
                  title: Text('弹幕来源', style: TextStyle(fontFamily: fontFamily)),
                  description: Text('ID: ${dandanCredentials['id']}',
                      style: TextStyle(fontFamily: fontFamily)),
                  value: Text('弹弹play开放平台',
                      style: TextStyle(fontFamily: fontFamily)),
                ),
              ],
            ),
            SettingsSection(
              title: Text('社区', style: TextStyle(fontFamily: fontFamily)),
              tiles: [
                SettingsTile.navigation(
                  onPressed: (_) {
                    launchUrl(Uri.parse(ApiEndpoints.telegramGroup),
                        mode: LaunchMode.externalApplication);
                  },
                  title: Text('Telegram',
                      style: TextStyle(fontFamily: fontFamily)),
                  value: Text('点击加入', style: TextStyle(fontFamily: fontFamily)),
                ),
              ],
            ),
            if (isDesktop()) // 之后如果有非桌面平台的新选项可以移除
              SettingsSection(
                title: Text('默认行为', style: TextStyle(fontFamily: fontFamily)),
                tiles: [
                  SettingsTile.navigation(
                    onPressed: (_) {
                      if (menuController.isOpen) {
                        menuController.close();
                      } else {
                        menuController.open();
                      }
                    },
                    title:
                        Text('关闭时', style: TextStyle(fontFamily: fontFamily)),
                    value: MenuAnchor(
                      consumeOutsideTap: true,
                      controller: menuController,
                      builder: (_, __, ___) {
                        return Text(exitBehaviorTitles[exitBehavior]);
                      },
                      menuChildren: [
                        for (int i = 0; i < 3; i++)
                          MenuItemButton(
                            requestFocusOnHover: false,
                            onPressed: () {
                              exitBehavior = i;
                              GStorage.putSetting(SettingsKeys.exitBehavior, i);
                              setState(() {});
                            },
                            child: Container(
                              height: 48,
                              constraints: BoxConstraints(minWidth: 112),
                              child: Align(
                                alignment: Alignment.centerLeft,
                                child: Text(
                                  exitBehaviorTitles[i],
                                  style: TextStyle(
                                    color: i == exitBehavior
                                        ? Theme.of(context).colorScheme.primary
                                        : null,
                                  ),
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ],
            SettingsSection(
              title: Text('存储与日志', style: TextStyle(fontFamily: fontFamily)),
              tiles: [
                SettingsTile.navigation(
                  onPressed: (_) {
                    Modular.to.pushNamed('/settings/about/logs');
                  },
                  title: Text('错误日志', style: TextStyle(fontFamily: fontFamily)),
                ),
                SettingsTile.navigation(
                  onPressed: (_) {
                    _showCacheDialog();
                  },
                  title: Text('清除缓存', style: TextStyle(fontFamily: fontFamily)),
                  value: _cacheSizeMB == -1
                      ? Text('统计中...', style: TextStyle(fontFamily: fontFamily))
                      : Text('${_cacheSizeMB.toStringAsFixed(2)}MB',
                          style: TextStyle(fontFamily: fontFamily)),
                ),
              ],
            ),
            SettingsSection(
              title: Text('应用更新', style: TextStyle(fontFamily: fontFamily)),
              tiles: [
                SettingsTile.switchTile(
                  onToggle: (value) async {
                    autoUpdate = value ?? !autoUpdate;
                    await GStorage.putSetting(
                        SettingsKeys.autoUpdate, autoUpdate);
                    setState(() {});
                  },
                  title: Text('启动时检查更新', style: TextStyle(fontFamily: fontFamily)),
                  initialValue: autoUpdate,
                ),
                SettingsTile.navigation(
                  onPressed: (_) {
                    myController.checkUpdate();
                  },
                  title: Text('检查应用更新', style: TextStyle(fontFamily: fontFamily)),
                  value: Text('当前版本 ${ApiEndpoints.version}',
                      style: TextStyle(fontFamily: fontFamily)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
