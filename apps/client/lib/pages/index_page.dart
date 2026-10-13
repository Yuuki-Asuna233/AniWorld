import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/pages/menu/menu.dart';
import 'package:kazumi/pages/my/my_controller.dart';
import 'package:kazumi/pages/notifications/update_notification_controller.dart';
import 'package:kazumi/services/storage/storage.dart';

class IndexPage extends StatefulWidget {
  //const IndexPage({super.key});
  const IndexPage({super.key});

  @override
  State<IndexPage> createState() => _IndexPageState();
}

class _IndexPageState extends State<IndexPage> with WidgetsBindingObserver {
  static const Duration _automaticCheckCooldown = Duration(minutes: 5);
  static DateTime? _lastAutomaticCheck;
  bool _checkingForUpdate = false;
  Timer? _updateReminderTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_checkForUpdates());
      unawaited(
        Modular.get<UpdateNotificationController>().checkForUpdates(),
      );
    });
    _updateReminderTimer = Timer.periodic(const Duration(minutes: 30), (_) {
      unawaited(
        Modular.get<UpdateNotificationController>().checkForUpdates(),
      );
    });
  }

  Future<void> _checkForUpdates() async {
    if (_checkingForUpdate || !GStorage.getSetting(SettingsKeys.autoUpdate)) {
      return;
    }

    final now = DateTime.now();
    final lastCheck = _lastAutomaticCheck;
    if (lastCheck != null &&
        now.difference(lastCheck) < _automaticCheckCooldown) {
      return;
    }

    _checkingForUpdate = true;
    _lastAutomaticCheck = now;
    try {
      // Wait until the main route and its dialog overlay have settled.
      await Future<void>.delayed(const Duration(seconds: 4));
      if (!mounted) return;
      await Modular.get<MyController>().checkUpdate(
        type: 'auto',
        context: context,
      );
    } finally {
      _checkingForUpdate = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) {
      unawaited(_checkForUpdates());
      unawaited(
        Modular.get<UpdateNotificationController>().checkForUpdates(),
      );
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _updateReminderTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return const ScaffoldMenu();
  }
}
