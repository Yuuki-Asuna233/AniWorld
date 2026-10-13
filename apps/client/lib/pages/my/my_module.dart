import 'package:kazumi/pages/my/my_page.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/pages/collect/collect_module.dart';
import 'package:kazumi/pages/download/download_page_module.dart';
import 'package:kazumi/pages/history/history_module.dart';
import 'package:kazumi/pages/notifications/update_notifications_module.dart';
import 'package:kazumi/pages/notifications/comment_notifications_module.dart';
import 'package:kazumi/pages/syncplay/syncplay_module.dart';

class MyModule extends Module {
  @override
  void routes(r) {
    r.child("/", child: (_) => const MyPage());
    r.module("/history", module: HistoryModule());
    r.module("/notifications", module: UpdateNotificationsModule());
    r.module("/comment-notifications", module: CommentNotificationsModule());
    r.module("/collect", module: CollectModule());
    r.module("/download", module: DownloadModule());
    r.module("/syncplay", module: SyncPlayModule());
  }
}
