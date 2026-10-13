import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';

class EdgeSwipeBackTracker {
  EdgeSwipeBackTracker({
    this.edgeWidth = 28,
    this.triggerDistance = 72,
    this.horizontalBias = 1.25,
  });

  final double edgeWidth;
  final double triggerDistance;
  final double horizontalBias;

  Offset? _start;
  bool _fromLeft = false;
  bool _fromRight = false;

  void start(Offset position, double viewportWidth) {
    _start = position;
    _fromLeft = position.dx <= edgeWidth;
    _fromRight = position.dx >= viewportWidth - edgeWidth;
  }

  bool finish(Offset position) {
    final start = _start;
    final fromLeft = _fromLeft;
    final fromRight = _fromRight;
    reset();
    if (start == null || (!fromLeft && !fromRight)) return false;

    final delta = position - start;
    final horizontal = delta.dx.abs();
    final vertical = delta.dy.abs();
    final movedInward = (fromLeft && delta.dx >= triggerDistance) ||
        (fromRight && delta.dx <= -triggerDistance);
    return movedInward && horizontal >= vertical * horizontalBias;
  }

  void reset() {
    _start = null;
    _fromLeft = false;
    _fromRight = false;
  }
}

class AndroidEdgeSwipeBack extends StatefulWidget {
  const AndroidEdgeSwipeBack({
    super.key,
    required this.child,
    this.enabled,
    this.onBack,
  });

  final Widget child;
  final bool? enabled;
  final Future<bool> Function()? onBack;

  @override
  State<AndroidEdgeSwipeBack> createState() => _AndroidEdgeSwipeBackState();
}

class _AndroidEdgeSwipeBackState extends State<AndroidEdgeSwipeBack> {
  final EdgeSwipeBackTracker _tracker = EdgeSwipeBackTracker();
  bool _handlingBack = false;

  bool get _enabled => widget.enabled ?? Platform.isAndroid;

  Future<void> _handlePointerUp(PointerUpEvent event) async {
    if (!_enabled || !_tracker.finish(event.position) || _handlingBack) return;
    _handlingBack = true;
    try {
      if (widget.onBack case final callback?) {
        await callback();
      } else if (Modular.to.canPop()) {
        await Modular.to.maybePop();
      }
    } finally {
      _handlingBack = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_enabled) return widget.child;

    return LayoutBuilder(
      builder: (context, constraints) {
        return Listener(
          behavior: HitTestBehavior.translucent,
          onPointerDown: (event) =>
              _tracker.start(event.position, constraints.maxWidth),
          onPointerCancel: (_) => _tracker.reset(),
          onPointerUp: _handlePointerUp,
          child: widget.child,
        );
      },
    );
  }
}
