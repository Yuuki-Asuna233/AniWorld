import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/pages/notifications/comment_notifications_page.dart';

class CommentNotificationsModule extends Module {
  @override
  void routes(r) {
    r.child('/', child: (_) => const CommentNotificationsPage());
  }
}
