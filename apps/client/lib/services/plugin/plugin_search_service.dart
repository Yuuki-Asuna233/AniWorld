import 'package:kazumi/plugins/plugins.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/pages/info/info_controller.dart';
import 'package:kazumi/plugins/plugins_controller.dart';
import 'package:kazumi/services/logging/logger.dart';

class PluginSearchService {
  PluginSearchService({
    required this.infoController,
  });

  final InfoController infoController;
  final PluginsController pluginsController = Modular.get<PluginsController>();
  bool _isCancelled = false;
  int _batchGeneration = 0;
  final Map<String, int> _queryGenerations = {};

  Future<void> querySource(String keyword, String pluginName) async {
    if (_isCancelled) return;
    final generation = (_queryGenerations[pluginName] ?? 0) + 1;
    _queryGenerations[pluginName] = generation;
    bool current() =>
        !_isCancelled && _queryGenerations[pluginName] == generation;
    infoController.pluginSearchResponseList
        .removeWhere((response) => response.pluginName == pluginName);
    if (infoController.pluginSearchStatus.containsKey(pluginName)) {
      infoController.pluginSearchStatus[pluginName] = 'pending';
    }
    for (Plugin plugin in pluginsController.pluginList) {
      if (plugin.name == pluginName && plugin.enabled) {
        try {
          final result =
              await plugin.queryBangumi(keyword, shouldRethrow: true);
          if (!current()) return;

          infoController.pluginSearchStatus[plugin.name] = 'success';
          if (result.data.isNotEmpty) {
            pluginsController.validityTracker.markSearchValid(plugin.name);
          }
          infoController.pluginSearchResponseList.add(result);
        } catch (error) {
          if (!current()) return;

          if (error is CaptchaRequiredException) {
            KazumiLogger().w(
                'PluginSearchService: captcha required for ${error.pluginName}');
            infoController.pluginSearchStatus[error.pluginName] = 'captcha';
          } else if (error is NoResultException) {
            KazumiLogger()
                .i('PluginSearchService: no results for ${error.pluginName}');
            infoController.pluginSearchStatus[error.pluginName] = 'noResult';
          } else {
            final name =
                error is SearchErrorException ? error.pluginName : plugin.name;
            KazumiLogger().w('PluginSearchService: search error for $name');
            infoController.pluginSearchStatus[name] = 'error';
          }
        }
        return;
      }
    }
  }

  Future<void> queryAllSource(String keyword) async {
    _isCancelled = false;
    final batch = ++_batchGeneration;
    _queryGenerations.updateAll((_, value) => value + 1);
    infoController.pluginSearchResponseList.clear();

    final plugins = pluginsController.enabledPlugins;
    for (Plugin plugin in plugins) {
      infoController.pluginSearchStatus[plugin.name] = 'pending';
    }
    var nextIndex = 0;

    Future<void> worker() async {
      while (!_isCancelled &&
          batch == _batchGeneration &&
          nextIndex < plugins.length) {
        final plugin = plugins[nextIndex++];
        await querySource(keyword, plugin.name);
      }
    }

    final workerCount = plugins.length < 3 ? plugins.length : 3;
    await Future.wait(List.generate(workerCount, (_) => worker()));
  }

  void cancel() {
    _isCancelled = true;
    _batchGeneration++;
    _queryGenerations.updateAll((_, value) => value + 1);
  }
}
