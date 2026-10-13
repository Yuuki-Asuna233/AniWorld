import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/settings/theme_provider.dart';
import 'package:kazumi/pages/collect/collect_controller.dart';
import 'package:kazumi/pages/download/download_controller.dart';
import 'package:kazumi/pages/my/my_controller.dart';
import 'package:kazumi/plugins/plugins_controller.dart';
import 'package:kazumi/services/access/access_gate_service.dart';
import 'package:kazumi/services/download/background_download_service.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/shaders/shader_asset_service.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/sync/bangumi_sync_service.dart';
import 'package:kazumi/services/sync/webdav.dart';
import 'package:provider/provider.dart';

class InitPage extends StatefulWidget {
  const InitPage({super.key});

  @override
  State<InitPage> createState() => _InitPageState();
}

class _InitPageState extends State<InitPage> {
  final PluginsController pluginsController = Modular.get<PluginsController>();
  final CollectController collectController = Modular.get<CollectController>();
  final ShaderAssetService shaderAssetService =
      Modular.get<ShaderAssetService>();
  final MyController myController = Modular.get<MyController>();
  final DownloadController downloadController =
      Modular.get<DownloadController>();
  late final ThemeProvider themeProvider;

  @override
  void initState() {
    super.initState();
    themeProvider = Provider.of<ThemeProvider>(context, listen: false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !AccessGateService.isUnlocked) return;
      _enterApp();
    });
  }

  void _enterApp() {
    try {
      _startDefaultPage();
    } catch (e, stackTrace) {
      KazumiLogger().e(
        'InitPage: failed to navigate to default page',
        error: e,
        stackTrace: stackTrace,
      );
      Modular.to.navigate('/tab/popular/');
    }

    unawaited(_continueStartup());
  }

  Future<void> _continueStartup() async {
    // Give the selected home page the first slice of CPU, disk and network.
    await Future<void>.delayed(const Duration(milliseconds: 700));
    await Future.wait<void>([
      _safeStartupTask('downloadController.init', () async {
        await downloadController.init().timeout(const Duration(seconds: 8));
        _setupBackgroundDownloadNavigation();
      }),
      _safeStartupTask('pluginInit', _pluginInit),
      _safeStartupTask('loadDanmakuShield', _loadDanmakuShield),
    ]);
    await Future.wait<void>([
      _safeStartupTask('migrateStorage', collectController.migrateCollect),
      _safeStartupTask(
        'loadShaders',
        shaderAssetService.copyShadersToExternalDirectory,
      ),
    ]);
    await _runOptionalStartupTasks();
  }

  Future<void> _runOptionalStartupTasks() async {
    await Future.wait<void>([
      _safeStartupTask('webDavInit', _webDavInit),
      _safeStartupTask('bangumiInit', _bangumiInit),
    ]);
  }

  Future<void> _safeStartupTask(
    String name,
    Future<void> Function() task,
  ) async {
    try {
      await task().timeout(const Duration(seconds: 10));
    } catch (e, stackTrace) {
      KazumiLogger().w(
        'InitPage: optional startup task failed or timed out: $name',
        error: e,
        stackTrace: stackTrace,
      );
    }
  }

  void _setupBackgroundDownloadNavigation() {
    final backgroundService = BackgroundDownloadService();
    backgroundService.onNavigateToDownloadRequested = () {
      Future.delayed(const Duration(milliseconds: 300), () {
        try {
          if (Modular.to.path.contains('/download')) return;
          Modular.to.pushNamed('/settings/download/');
        } catch (e) {
          KazumiLogger().w(
            'InitPage: failed to navigate to download page',
            error: e,
          );
        }
      });
    };
    backgroundService.onNotificationPermissionRequired = () async => false;
  }

  void _startDefaultPage() {
    final defaultStartupPage = _normalizedStartupPage(
      GStorage.getSetting(SettingsKeys.defaultStartupPage),
    );
    themeProvider.setDynamic(GStorage.getSetting(SettingsKeys.useDynamicColor));
    Modular.to.navigate(defaultStartupPage);
  }

  String _normalizedStartupPage(String page) {
    const validPages = {
      '/tab/popular/',
      '/tab/shiraha/',
      '/tab/collect/',
      '/tab/my/',
    };
    if (validPages.contains(page)) return page;
    GStorage.putSetting(SettingsKeys.defaultStartupPage, '/tab/popular/');
    return '/tab/popular/';
  }

  Future<void> _loadDanmakuShield() async {
    myController.loadShieldList();
  }

  Future<void> _pluginInit() async {
    try {
      await pluginsController.init();
      if (pluginsController.pluginList.isEmpty) {
        await pluginsController.copyPluginsToExternalDirectory();
        await pluginsController.init();
      }
      _pluginUpdate();
    } catch (e, stackTrace) {
      KazumiLogger().w(
        'Plugin: initialization skipped during startup',
        error: e,
        stackTrace: stackTrace,
      );
    }
  }

  Future<void> _webDavInit() async {
    final webDavEnable = GStorage.getSetting(SettingsKeys.webDavEnable);
    if (!webDavEnable) return;
    final webDav = WebDav();
    await webDav.init();
    await webDav.syncHistory();
  }

  Future<void> _bangumiInit() async {
    final bangumiEnable = GStorage.getSetting(
      SettingsKeys.bangumiSyncEnable,
    );
    if (!bangumiEnable) return;
    final bangumi = BangumiSyncService();
    try {
      await bangumi.init();
    } catch (e) {
      bangumi.reset();
      await GStorage.putSetting(SettingsKeys.bangumiSyncEnable, false);
      KazumiLogger().w(
        'Bangumi: initialization failed, disabling Bangumi sync',
        error: e,
      );
    }
  }

  Future<void> _pluginUpdate() async {
    try {
      await pluginsController.queryPluginHTTPList();
    } catch (e) {
      KazumiLogger().w('Plugin: update check skipped', error: e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return const LoadingWidget();
  }
}

class LoadingWidget extends StatelessWidget {
  const LoadingWidget({super.key});

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: Container(
        width: double.infinity,
        height: double.infinity,
        color: colorScheme.surface,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.auto_awesome_rounded,
                size: 48,
                color: colorScheme.primary,
              ),
              const SizedBox(height: 18),
              Text(
                'AniWorld 正在启动',
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 14),
              const SizedBox(
                width: 120,
                child: LinearProgressIndicator(minHeight: 3),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
