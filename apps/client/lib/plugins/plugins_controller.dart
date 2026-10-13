import 'dart:io';
import 'dart:convert';
import 'package:mobx/mobx.dart';
import 'package:flutter/services.dart' show rootBundle, AssetManifest;
import 'package:path_provider/path_provider.dart';
import 'package:kazumi/plugins/plugins.dart';
import 'package:kazumi/services/plugin/plugin_validity_tracker.dart';
import 'package:kazumi/services/plugin/plugin_install_time_tracker.dart';
import 'package:kazumi/request/apis/plugin_catalog_api.dart';
import 'package:kazumi/modules/plugin/plugin_http_module.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/request/config/api_endpoints.dart';

part 'plugins_controller.g.dart';

// 从 1.5.1 版本开始，规则文件储存在单一的 plugins.json 文件中。
// 之前的版本中，规则以分离文件形式存储，版本更新后将这些分离文件合并为单一的 plugins.json 文件。

// ignore: library_private_types_in_public_api
class PluginsController = _PluginsController with _$PluginsController;

abstract class _PluginsController with Store {
  Future<void>? _initFuture;

  @observable
  ObservableList<Plugin> pluginList = ObservableList.of([]);

  /// Rules currently available to regular search and playback source pickers.
  /// The complete [pluginList] is intentionally kept intact so disabled rules
  /// can still be edited, re-enabled, or used by an explicit legacy history
  /// entry that names that rule.
  List<Plugin> get enabledPlugins =>
      pluginList.where((plugin) => plugin.enabled).toList(growable: false);

  @observable
  ObservableList<PluginHTTPItem> pluginHTTPList = ObservableList.of([]);

  // 规则有效性追踪器
  final validityTracker = PluginValidityTracker();

  // 规则安装时间追踪器
  final installTimeTracker = PluginInstallTimeTracker();

  String pluginsFileName = "plugins.json";

  Directory? oldPluginDirectory;

  Directory? newPluginDirectory;

  // Initializes the plugin directory and loads all plugins
  Future<void> init() {
    return _initFuture ??= _initInternal().whenComplete(() {
      _initFuture = null;
    });
  }

  Future<void> _initInternal() async {
    final directory = await getApplicationSupportDirectory();
    oldPluginDirectory = Directory('${directory.path}/plugins');
    if (!await oldPluginDirectory!.exists()) {
      await oldPluginDirectory!.create(recursive: true);
    }
    newPluginDirectory = Directory('${directory.path}/plugins/v2');
    if (!await newPluginDirectory!.exists()) {
      await newPluginDirectory!.create(recursive: true);
    }
    await loadAllPlugins();
  }

  /// Ensures all bundled sources are available before the playback picker is
  /// built, so opening a detail page during startup cannot render an empty or
  /// incomplete source list.
  Future<void> preparePlaybackSources() async {
    // Startup initializes plugins asynchronously after the first page is
    // shown. Await an in-flight initialization before inspecting pluginList;
    // otherwise a history tap during that window can still see an empty list.
    final pendingInit = _initFuture;
    if (pendingInit != null) {
      await pendingInit;
    }
    if (newPluginDirectory == null || oldPluginDirectory == null) {
      await init();
    } else {
      await removeRetiredPlaybackSource();
      await ensureBundledPlugin('assets/plugins/DM84.json');
      await ensureBundledPlugin('assets/plugins/AGE.json');
      await ensureBundledPlugin('assets/plugins/enlie.json');
    }
  }

  // Loads all plugins from the directory, populates the plugin list, and saves to plugins.json if needed
  Future<void> loadAllPlugins() async {
    pluginList.clear();
    KazumiLogger().i('Plugins Directory: ${newPluginDirectory!.path}');
    if (await newPluginDirectory!.exists()) {
      final pluginsFile = File('${newPluginDirectory!.path}/$pluginsFileName');
      if (await pluginsFile.exists()) {
        final jsonString = await pluginsFile.readAsString();
        pluginList.addAll(getPluginListFromJson(jsonString));
        KazumiLogger().i('Plugin: Current Plugin number: ${pluginList.length}');
      } else {
        // No plugins.json
        var jsonFiles = await getPluginFiles();
        for (var filePath in jsonFiles) {
          final file = File(filePath);
          final jsonString = await file.readAsString();
          final data = jsonDecode(jsonString);
          final plugin = Plugin.fromJson(data);
          pluginList.add(plugin);
          await file.delete(recursive: true);
        }
        savePlugins();
      }
    } else {
      KazumiLogger().w('Plugin: plugin directory does not exist');
    }
    await removeRetiredPlaybackSource();
    await ensureBundledPlugin('assets/plugins/DM84.json');
    await ensureBundledPlugin('assets/plugins/AGE.json');
    await ensureBundledPlugin('assets/plugins/enlie.json');
  }

  /// Keep built-in sources available for existing installations as well as
  /// fresh installs. User-installed rules are preserved; only the bundled
  /// rule with the same name is refreshed when its definition changes.
  Future<void> ensureBundledPlugin(String assetPath) async {
    try {
      final jsonString = await rootBundle.loadString(assetPath);
      final bundled = Plugin.fromJson(jsonDecode(jsonString));
      final index = pluginList.indexWhere((p) => p.name == bundled.name);
      if (index < 0) {
        pluginList.add(bundled);
        await savePlugins();
        KazumiLogger().i('Plugin: bundled ${bundled.name} installed');
        return;
      }
      final current = pluginList[index];
      if (current.version != bundled.version ||
          current.baseUrl != bundled.baseUrl ||
          current.searchURL != bundled.searchURL ||
          current.chapterResult != bundled.chapterResult) {
        bundled.enabled = current.enabled;
        pluginList[index] = bundled;
        await savePlugins();
        KazumiLogger().i('Plugin: bundled ${bundled.name} updated');
      }
    } catch (e) {
      KazumiLogger()
          .w('Plugin: failed to ensure bundled plugin $assetPath', error: e);
    }
  }

  Future<void> removeRetiredPlaybackSource() async {
    final count = pluginList.length;
    pluginList.removeWhere((plugin) => plugin.name.toLowerCase() == 'aniworld');
    if (pluginList.length != count) await savePlugins();
  }

  // Retrieves a list of JSON plugin file paths from the plugin directory
  Future<List<String>> getPluginFiles() async {
    if (await oldPluginDirectory!.exists()) {
      final jsonFiles = oldPluginDirectory!
          .listSync()
          .where((file) => file.path.endsWith('.json') && file is File)
          .map((file) => file.path)
          .toList();
      return jsonFiles;
    } else {
      return [];
    }
  }

  // Copies plugin JSON files from the assets to the plugin directory
  Future<void> copyPluginsToExternalDirectory() async {
    final assetManifest = await AssetManifest.loadFromAssetBundle(rootBundle);
    final assets = assetManifest.listAssets();
    final jsonFiles = assets.where((String asset) =>
        asset.startsWith('assets/plugins/') && asset.endsWith('.json'));

    for (var filePath in jsonFiles) {
      final jsonString = await rootBundle.loadString(filePath);
      final plugin = Plugin.fromJson(jsonDecode(jsonString));
      pluginList.add(plugin);
    }
    await savePlugins();
    KazumiLogger().i(
        'Plugin: ${jsonFiles.length} plugin files copied to ${newPluginDirectory!.path}');
  }

  List<dynamic> pluginListToJson() {
    final List<dynamic> json = [];
    for (var plugin in pluginList) {
      json.add(plugin.toJson());
    }
    return json;
  }

  // Converts a JSON string into a list of Plugin objects.
  List<Plugin> getPluginListFromJson(String jsonString) {
    List<dynamic> json = jsonDecode(jsonString);
    List<Plugin> plugins = [];
    for (var j in json) {
      plugins.add(Plugin.fromJson(j));
    }
    return plugins;
  }

  Future<void> removePlugin(Plugin plugin) async {
    pluginList.removeWhere((p) => p.name == plugin.name);
    await savePlugins();
  }

  // Update or add plugin
  void updatePlugin(Plugin plugin) {
    bool flag = false;
    for (int i = 0; i < pluginList.length; ++i) {
      if (pluginList[i].name == plugin.name) {
        // Catalog updates must not silently re-enable a source the user
        // intentionally disabled.
        plugin.enabled = pluginList[i].enabled;
        pluginList.replaceRange(i, i + 1, [plugin]);
        flag = true;
        break;
      }
    }
    if (!flag) {
      pluginList.add(plugin);
    }
    savePlugins();
  }

  /// Persist a rule's enabled state and notify MobX observers.
  Future<void> setPluginEnabled(Plugin plugin, bool enabled) async {
    final index = pluginList.indexWhere((item) => item.name == plugin.name);
    if (index < 0 || pluginList[index].enabled == enabled) return;
    pluginList[index].enabled = enabled;
    // Mutating a field on an object inside ObservableList does not itself
    // emit a list change, so assign the same object back to trigger rebuilds.
    pluginList[index] = pluginList[index];
    await savePlugins();
  }

  void onReorder(int oldIndex, int newIndex) {
    final plugin = pluginList.removeAt(oldIndex);
    pluginList.insert(newIndex, plugin);
    savePlugins();
  }

  Future<void> savePlugins() async {
    final jsonData = jsonEncode(pluginListToJson());
    final pluginsFile = File('${newPluginDirectory!.path}/$pluginsFileName');
    await pluginsFile.writeAsString(jsonData);
    KazumiLogger().i('Plugin: updated plugin file $pluginsFileName');
  }

  Future<void> queryPluginHTTPList() async {
    pluginHTTPList.clear();
    var pluginHTTPListRes = await PluginCatalogApi.getPluginList();
    pluginHTTPList.addAll(pluginHTTPListRes);
  }

  Future<Plugin?> queryPluginHTTP(String name) async {
    Plugin? plugin;
    plugin = await PluginCatalogApi.getPlugin(name);
    return plugin;
  }

  String pluginStatus(PluginHTTPItem pluginHTTPItem) {
    String pluginStatus = 'install';
    for (Plugin plugin in pluginList) {
      if (pluginHTTPItem.name == plugin.name) {
        if (pluginHTTPItem.version == plugin.version) {
          pluginStatus = 'installed';
        } else {
          pluginStatus = 'update';
        }
        break;
      }
    }
    return pluginStatus;
  }

  String pluginUpdateStatus(Plugin plugin) {
    if (!pluginHTTPList.any((p) => p.name == plugin.name)) {
      return "nonexistent";
    }
    PluginHTTPItem p = pluginHTTPList.firstWhere(
      (p) => p.name == plugin.name,
    );
    return p.version == plugin.version ? "latest" : "updatable";
  }

  Future<int> tryUpdatePlugin(Plugin plugin) async {
    return await tryUpdatePluginByName(plugin.name);
  }

  Future<int> tryUpdatePluginByName(String name) async {
    var pluginHTTPItem = await queryPluginHTTP(name);
    if (pluginHTTPItem != null) {
      if (int.parse(pluginHTTPItem.api) > ApiEndpoints.apiLevel) {
        return 1;
      }
      updatePlugin(pluginHTTPItem);
      return 0;
    }
    return 2;
  }

  Future<int> tryUpdateAllPlugin() async {
    int count = 0;
    for (Plugin plugin in pluginList) {
      if (pluginUpdateStatus(plugin) == 'updatable') {
        if (await tryUpdatePlugin(plugin) == 0) {
          count++;
        }
      }
    }
    return count;
  }

  void removePlugins(Set<String> pluginNames) {
    for (int i = pluginList.length - 1; i >= 0; --i) {
      var name = pluginList[i].name;
      if (pluginNames.contains(name)) {
        pluginList.removeAt(i);
      }
    }
    savePlugins();
  }
}
