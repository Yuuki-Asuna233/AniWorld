import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/pages/syncplay/syncplay_page.dart';

class SyncPlayModule extends Module {
  @override
  void routes(r) {
    r.child('/', child: (_) => const SyncPlayPage());
  }
}
