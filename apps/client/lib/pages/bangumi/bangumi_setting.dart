import 'package:flutter/material.dart';
import 'package:kazumi/bean/appbar/sys_app_bar.dart';

/// The local catalogue bridge does not implement Bangumi account synchronization.
class BangumiEditorPage extends StatelessWidget {
  const BangumiEditorPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      appBar: SysAppBar(title: Text('Bangumi 配置')),
      body: Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            '当前服务器尚未提供 Bangumi 账号验证及收藏同步。\n请使用 AniWorld 账号进行追番。',
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}
