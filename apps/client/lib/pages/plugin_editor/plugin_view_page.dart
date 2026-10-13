import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_mobx/flutter_mobx.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/plugins/plugins.dart';
import 'package:kazumi/plugins/plugins_controller.dart';
import 'package:kazumi/utils/encoding.dart';
import 'package:kazumi/bean/settings/settings_detail_scaffold.dart';

class PluginViewPage extends StatefulWidget {
  const PluginViewPage({super.key, this.controller});

  final PluginsController? controller;

  @override
  State<PluginViewPage> createState() => _PluginViewPageState();
}

class _PluginViewPageState extends State<PluginViewPage> {
  PluginsController get pluginsController =>
      widget.controller ?? Modular.get<PluginsController>();

  bool _loadingPlugins = true;
  Object? _pluginLoadError;

  // 是否处于多选模式
  bool isMultiSelectMode = false;

  // 已选中的规则名称集合
  final Set<String> selectedNames = {};

  Future<void> _handleUpdate() async {
    KazumiDialog.showLoading(msg: '更新中');
    int count = await pluginsController.tryUpdateAllPlugin();
    KazumiDialog.dismiss();
    if (count == 0) {
      KazumiDialog.showToast(message: '所有规则已是最新');
    } else {
      KazumiDialog.showToast(message: '更新成功 $count 条');
    }
  }

  void _handleAdd() {
    KazumiDialog.show(builder: (context) {
      return AlertDialog(
        // contentPadding: EdgeInsets.zero, // 设置为零以减小内边距
        content: SingleChildScrollView(
          // 使用可滚动的SingleChildScrollView包装Column
          child: Column(
            mainAxisSize: MainAxisSize.min, // 设置为MainAxisSize.min以减小高度
            children: [
              ListTile(
                title: const Text('新建规则'),
                onTap: () {
                  KazumiDialog.dismiss();
                  Modular.to.pushNamed('/settings/plugin/editor',
                      arguments: Plugin.fromTemplate());
                },
              ),
              const SizedBox(height: 10),
              ListTile(
                title: const Text('从规则仓库导入'),
                onTap: () {
                  KazumiDialog.dismiss();
                  Modular.to.pushNamed('/settings/plugin/shop',
                      arguments: Plugin.fromTemplate());
                },
              ),
              const SizedBox(height: 10),
              ListTile(
                title: const Text('从剪贴板导入'),
                onTap: () {
                  KazumiDialog.dismiss();
                  _showInputDialog();
                },
              ),
            ],
          ),
        ),
      );
    });
  }

  void _showInputDialog() {
    String pluginText = '';
    KazumiDialog.show(
      builder: (context) {
        return AlertDialog(
          title: const Text('导入规则'),
          content: StatefulBuilder(
              builder: (BuildContext context, StateSetter setState) {
            return TextField(
              onChanged: (value) => pluginText = value,
            );
          }),
          actions: [
            TextButton(
              onPressed: () => KazumiDialog.dismiss(),
              child: Text(
                '取消',
                style: TextStyle(color: Theme.of(context).colorScheme.outline),
              ),
            ),
            StatefulBuilder(
                builder: (BuildContext context, StateSetter setState) {
              return TextButton(
                onPressed: () async {
                  try {
                    pluginsController.updatePlugin(Plugin.fromJson(
                        json.decode(kazumiBase64ToJson(pluginText))));
                    KazumiDialog.showToast(message: '导入成功');
                  } catch (e) {
                    KazumiDialog.dismiss();
                    KazumiDialog.showToast(message: '导入失败 ${e.toString()}');
                  }
                  KazumiDialog.dismiss();
                },
                child: const Text('导入'),
              );
            })
          ],
        );
      },
    );
  }

  void onBackPressed(BuildContext context) {
    if (KazumiDialog.observer.hasKazumiDialog) {
      KazumiDialog.dismiss();
      return;
    }
  }

  @override
  void initState() {
    super.initState();
    unawaited(_ensurePluginsLoaded());
  }

  Future<void> _ensurePluginsLoaded() async {
    try {
      await pluginsController.init();
      if (pluginsController.pluginList.isEmpty) {
        await pluginsController.copyPluginsToExternalDirectory();
        await pluginsController.init();
      }
    } catch (error) {
      _pluginLoadError = error;
    } finally {
      if (mounted) setState(() => _loadingPlugins = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) {});
    return PopScope(
      canPop: !isMultiSelectMode,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (isMultiSelectMode) {
          setState(() {
            isMultiSelectMode = false;
            selectedNames.clear();
          });
          return;
        }
        onBackPressed(context);
      },
      child: SettingsDetailScaffold(
        title: isMultiSelectMode
            ? Text('已选择 ${selectedNames.length} 项')
            : const Text('规则管理'),
        leading: isMultiSelectMode
            ? IconButton(
                icon: const Icon(Icons.close),
                onPressed: () {
                  setState(() {
                    isMultiSelectMode = false;
                    selectedNames.clear();
                  });
                },
              )
            : null,
        actions: [
          if (isMultiSelectMode) ...[
            IconButton(
              onPressed: selectedNames.isEmpty
                  ? null
                  : () {
                      KazumiDialog.show(
                        builder: (context) => AlertDialog(
                          title: const Text('删除规则'),
                          content:
                              Text('确定要删除选中的 ${selectedNames.length} 条规则吗？'),
                          actions: [
                            TextButton(
                              onPressed: () => KazumiDialog.dismiss(),
                              child: Text(
                                '取消',
                                style: TextStyle(
                                    color:
                                        Theme.of(context).colorScheme.outline),
                              ),
                            ),
                            TextButton(
                              onPressed: () {
                                pluginsController.removePlugins(selectedNames);
                                setState(() {
                                  isMultiSelectMode = false;
                                  selectedNames.clear();
                                });
                                KazumiDialog.dismiss();
                              },
                              child: const Text('删除'),
                            ),
                          ],
                        ),
                      );
                    },
              icon: const Icon(Icons.delete),
            ),
          ] else ...[
            IconButton(
              onPressed: () {
                _handleUpdate();
              },
              tooltip: '更新全部',
              icon: const Icon(Icons.update),
            ),
            IconButton(
              onPressed: () {
                _handleAdd();
              },
              tooltip: '添加规则',
              icon: const Icon(Icons.add),
            )
          ],
        ],
        body: Observer(builder: (context) {
          if (_loadingPlugins) {
            return const Center(child: CircularProgressIndicator());
          }
          if (_pluginLoadError != null &&
              pluginsController.pluginList.isEmpty) {
            return Center(
              child: Text('规则加载失败：$_pluginLoadError'),
            );
          }
          return pluginsController.pluginList.isEmpty
              ? const Center(
                  child: Text('啊咧（⊙.⊙） 没有可用规则的说'),
                )
              : Builder(builder: (context) {
                  final enabledCount = pluginsController.pluginList
                      .where((plugin) => plugin.enabled)
                      .length;
                  return Column(
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                        child: Row(
                          children: [
                            Icon(Icons.tune_rounded,
                                size: 20,
                                color: Theme.of(context).colorScheme.primary),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                '规则源 · $enabledCount/${pluginsController.pluginList.length} 已启用',
                                style: Theme.of(context).textTheme.bodyMedium,
                              ),
                            ),
                            Text(
                              '关闭后不参与搜索和播放',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                      Expanded(
                        child: ReorderableListView.builder(
                          buildDefaultDragHandles: false,
                          proxyDecorator: (child, index, animation) {
                            return Material(
                              elevation: 0,
                              color: Colors.transparent,
                              child: child,
                            );
                          },
                          onReorderItem: (int oldIndex, int newIndex) {
                            pluginsController.onReorder(oldIndex, newIndex);
                          },
                          itemCount: pluginsController.pluginList.length,
                          itemBuilder: (context, index) {
                            var plugin = pluginsController.pluginList[index];
                            bool canUpdate =
                                pluginsController.pluginUpdateStatus(plugin) ==
                                    'updatable';
                            return Card(
                                key: ValueKey(plugin.name),
                                elevation: 0,
                                color: Theme.of(context)
                                    .colorScheme
                                    .surfaceContainerLow,
                                margin: const EdgeInsets.only(bottom: 8),
                                child: ListTile(
                                  trailing: pluginCardTrailing(index),
                                  shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(12)),
                                  onLongPress: () {
                                    if (!isMultiSelectMode) {
                                      setState(() {
                                        isMultiSelectMode = true;
                                        selectedNames.add(plugin.name);
                                      });
                                    }
                                  },
                                  onTap: () {
                                    if (isMultiSelectMode) {
                                      setState(() {
                                        if (selectedNames
                                            .contains(plugin.name)) {
                                          selectedNames.remove(plugin.name);
                                          if (selectedNames.isEmpty) {
                                            isMultiSelectMode = false;
                                          }
                                        } else {
                                          selectedNames.add(plugin.name);
                                        }
                                      });
                                    }
                                  },
                                  selected: selectedNames.contains(plugin.name),
                                  selectedTileColor: Theme.of(context)
                                      .colorScheme
                                      .primaryContainer,
                                  title: Row(
                                    children: [
                                      Expanded(
                                        child: Text(
                                          plugin.name,
                                          style: Theme.of(context)
                                              .textTheme
                                              .titleMedium,
                                        ),
                                      ),
                                      Container(
                                        padding: const EdgeInsets.symmetric(
                                            horizontal: 8, vertical: 3),
                                        decoration: BoxDecoration(
                                          color: plugin.enabled
                                              ? Theme.of(context)
                                                  .colorScheme
                                                  .primaryContainer
                                              : Theme.of(context)
                                                  .colorScheme
                                                  .surfaceContainerHighest,
                                          borderRadius:
                                              BorderRadius.circular(20),
                                        ),
                                        child: Text(
                                          plugin.enabled ? '已启用' : '已停用',
                                          style: Theme.of(context)
                                              .textTheme
                                              .labelSmall,
                                        ),
                                      ),
                                    ],
                                  ),
                                  subtitle: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        children: [
                                          Text(
                                            'Version: ${plugin.version}',
                                            style: const TextStyle(
                                                color: Colors.grey),
                                          ),
                                          if (canUpdate) ...[
                                            const SizedBox(width: 8),
                                            Container(
                                              padding:
                                                  const EdgeInsets.symmetric(
                                                      horizontal: 6,
                                                      vertical: 2),
                                              decoration: BoxDecoration(
                                                color: Theme.of(context)
                                                    .colorScheme
                                                    .errorContainer,
                                                borderRadius:
                                                    BorderRadius.circular(4),
                                              ),
                                              child: Text(
                                                '可更新',
                                                style: TextStyle(
                                                  fontSize: 12,
                                                  color: Theme.of(context)
                                                      .colorScheme
                                                      .onErrorContainer,
                                                ),
                                              ),
                                            ),
                                          ],
                                          if (pluginsController.validityTracker
                                              .isSearchValid(plugin.name)) ...[
                                            const SizedBox(width: 8),
                                            Container(
                                              padding:
                                                  const EdgeInsets.symmetric(
                                                      horizontal: 6,
                                                      vertical: 2),
                                              decoration: BoxDecoration(
                                                color: Theme.of(context)
                                                    .colorScheme
                                                    .tertiaryContainer,
                                                borderRadius:
                                                    BorderRadius.circular(4),
                                              ),
                                              child: Text(
                                                '搜索有效',
                                                style: TextStyle(
                                                  fontSize: 12,
                                                  color: Theme.of(context)
                                                      .colorScheme
                                                      .onTertiaryContainer,
                                                ),
                                              ),
                                            ),
                                          ],
                                        ],
                                      ),
                                    ],
                                  ),
                                ));
                          },
                        ),
                      ),
                    ],
                  );
                });
        }),
      ),
    );
  }

  Widget pluginCardTrailing(int index) {
    final plugin = pluginsController.pluginList[index];
    return Row(mainAxisSize: MainAxisSize.min, children: [
      isMultiSelectMode
          ? Checkbox(
              value: selectedNames.contains(plugin.name),
              onChanged: (bool? value) {
                setState(() {
                  if (value == true) {
                    selectedNames.add(plugin.name);
                  } else {
                    selectedNames.remove(plugin.name);
                    if (selectedNames.isEmpty) {
                      isMultiSelectMode = false;
                    }
                  }
                });
              },
            )
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Switch.adaptive(
                  value: plugin.enabled,
                  onChanged: (value) {
                    unawaited(
                        pluginsController.setPluginEnabled(plugin, value));
                  },
                ),
                popupMenuButton(index),
              ],
            ),
      ReorderableDragStartListener(
        index: index,
        child: const Icon(Icons.drag_handle), // 单独的拖拽按钮
      )
    ]);
  }

  Widget popupMenuButton(int index) {
    final plugin = pluginsController.pluginList[index];
    return MenuAnchor(
      consumeOutsideTap: true,
      builder:
          (BuildContext context, MenuController controller, Widget? child) {
        return IconButton(
          onPressed: () {
            if (controller.isOpen) {
              controller.close();
            } else {
              controller.open();
            }
          },
          icon: const Icon(Icons.more_vert),
        );
      },
      menuChildren: [
        MenuItemButton(
          requestFocusOnHover: false,
          onPressed: () async {
            var state = pluginsController.pluginUpdateStatus(plugin);
            if (state == "nonexistent") {
              KazumiDialog.showToast(message: '规则仓库中没有当前规则');
            } else if (state == "latest") {
              KazumiDialog.showToast(message: '规则已是最新');
            } else if (state == "updatable") {
              KazumiDialog.showLoading(msg: '更新中');
              int res = await pluginsController.tryUpdatePlugin(plugin);
              KazumiDialog.dismiss();
              if (res == 0) {
                KazumiDialog.showToast(message: '更新成功');
              } else if (res == 1) {
                KazumiDialog.showToast(message: 'kazumi版本过低, 此规则不兼容当前版本');
              } else if (res == 2) {
                KazumiDialog.showToast(message: '更新规则失败');
              }
            }
          },
          child: Container(
            height: 48,
            constraints: BoxConstraints(minWidth: 112),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Row(
                children: [
                  Icon(Icons.update_rounded),
                  SizedBox(width: 8),
                  Text('更新'),
                ],
              ),
            ),
          ),
        ),
        MenuItemButton(
          requestFocusOnHover: false,
          onPressed: () {
            Modular.to.pushNamed('/settings/plugin/editor', arguments: plugin);
          },
          child: Container(
            height: 48,
            constraints: BoxConstraints(minWidth: 112),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Row(
                children: [
                  Icon(Icons.edit),
                  SizedBox(width: 8),
                  Text('编辑'),
                ],
              ),
            ),
          ),
        ),
        MenuItemButton(
          requestFocusOnHover: false,
          onPressed: () {
            Modular.to.pushNamed('/settings/plugin/test', arguments: plugin);
          },
          child: Container(
            height: 48,
            constraints: BoxConstraints(minWidth: 112),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Row(
                children: [
                  Icon(Icons.bug_report_outlined),
                  SizedBox(width: 8),
                  Text('测试'),
                ],
              ),
            ),
          ),
        ),
        MenuItemButton(
          requestFocusOnHover: false,
          onPressed: () {
            KazumiDialog.show(builder: (context) {
              return AlertDialog(
                title: const Text('规则链接'),
                content: SelectableText(
                  jsonToKazumiBase64(json
                      .encode(pluginsController.pluginList[index].toJson())),
                  style: const TextStyle(fontWeight: FontWeight.bold),
                  textAlign: TextAlign.center,
                ),
                actions: [
                  TextButton(
                    onPressed: () => KazumiDialog.dismiss(),
                    child: Text(
                      '取消',
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.outline),
                    ),
                  ),
                  TextButton(
                    onPressed: () {
                      Clipboard.setData(ClipboardData(
                        text: jsonToKazumiBase64(
                          json.encode(
                            pluginsController.pluginList[index].toJson(),
                          ),
                        ),
                      ));
                      KazumiDialog.dismiss();
                    },
                    child: const Text('复制到剪贴板'),
                  ),
                ],
              );
            });
          },
          child: Container(
            height: 48,
            constraints: BoxConstraints(minWidth: 112),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Row(
                children: [
                  Icon(Icons.share),
                  SizedBox(width: 8),
                  Text('分享'),
                ],
              ),
            ),
          ),
        ),
        MenuItemButton(
          requestFocusOnHover: false,
          onPressed: () async {
            setState(() {
              pluginsController.removePlugin(plugin);
            });
          },
          child: Container(
            height: 48,
            constraints: BoxConstraints(minWidth: 112),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Row(
                children: [
                  Icon(Icons.delete),
                  SizedBox(width: 8),
                  Text('删除'),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
