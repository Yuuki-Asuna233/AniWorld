import 'package:flutter/material.dart';
import 'package:kazumi/bean/appbar/sys_app_bar.dart';
import 'package:kazumi/bean/settings/settings_list.dart';
import 'package:kazumi/services/storage/storage.dart';

class SuperResolutionSettings extends StatefulWidget {
  const SuperResolutionSettings({super.key});

  @override
  State<SuperResolutionSettings> createState() =>
      _SuperResolutionSettingsState();
}

class _SuperResolutionSettingsState extends State<SuperResolutionSettings> {
  late bool promptOnEnable;
  late String superResolutionType;

  @override
  void initState() {
    super.initState();
    promptOnEnable =
        GStorage.getSetting<bool>(SettingsKeys.superResolutionWarn);
    superResolutionType =
        GStorage.getSetting<int>(SettingsKeys.defaultSuperResolutionType)
            .toString();
  }

  Future<void> _setMode(String? value) async {
    if (value == null) return;
    await GStorage.putSetting<int>(
      SettingsKeys.defaultSuperResolutionType,
      int.tryParse(value) ?? 1,
    );
    if (mounted) setState(() => superResolutionType = value);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const SysAppBar(title: Text('超分辨率')),
      body: SettingsList(
        sections: [
          SettingsRadioSection<String>(
            title: const Text(
              '超分辨率需要启用硬件解码，若仍不生效，请尝试将视频渲染器切换为 gpu',
            ),
            groupValue: superResolutionType,
            onChanged: _setMode,
            tiles: const [
              SettingsTile<String>.radioTile(
                title: Text('OFF'),
                description: Text('默认禁用超分辨率'),
                radioValue: '1',
              ),
              SettingsTile<String>.radioTile(
                title: Text('Efficiency'),
                description: Text('默认启用基于 Anime4K 的超分辨率（效率优先）'),
                radioValue: '2',
              ),
              SettingsTile<String>.radioTile(
                title: Text('Quality'),
                description: Text('默认启用基于 Anime4K 的超分辨率（质量优先）'),
                radioValue: '3',
              ),
            ],
          ),
          SettingsSection(
            title: const Text('默认行为'),
            tiles: [
              SettingsTile.switchTile(
                leading: Icons.notifications_off_rounded,
                title: const Text('关闭提示'),
                description: const Text('关闭每次启用超分辨率时的提示'),
                initialValue: promptOnEnable,
                onToggle: (value) async {
                  promptOnEnable = value ?? !promptOnEnable;
                  await GStorage.putSetting<bool>(
                    SettingsKeys.superResolutionWarn,
                    promptOnEnable,
                  );
                  if (mounted) setState(() {});
                },
              ),
            ],
          ),
        ],
      ),
    );
  }
}
