import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/pages/notifications/update_notifications_page.dart';

class UpdateNotificationsModule extends Module {
  @override
  void routes(r) {
    r.child('/', child: (_) => const UpdateNotificationsPage());
  }
}
