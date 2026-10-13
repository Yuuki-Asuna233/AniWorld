import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/pages/shiraha/shiraha_page.dart';

class ShirahaModule extends Module {
  @override
  void routes(r) {
    r.child('/', child: (_) => const ShirahaPage());
  }
}
