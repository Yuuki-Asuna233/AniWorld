import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Enables mouse and trackpad dragging for touch-oriented carousels on Windows.
///
/// This behavior is only installed by [AppWidget] on Windows, so Android keeps
/// Flutter's original touch scrolling behavior unchanged.
class AniWorldDesktopScrollBehavior extends MaterialScrollBehavior {
  const AniWorldDesktopScrollBehavior();

  @override
  Set<PointerDeviceKind> get dragDevices => const {
        PointerDeviceKind.touch,
        PointerDeviceKind.mouse,
        PointerDeviceKind.stylus,
        PointerDeviceKind.invertedStylus,
        PointerDeviceKind.trackpad,
      };

  // Keep the vertical mouse wheel available to the surrounding page.
  @override
  Set<LogicalKeyboardKey> get pointerAxisModifiers => const {};
}

/// Gives a Windows horizontal list an independent controller.
///
/// On Android the original child is returned with no injected controller,
/// preserving the existing App behavior exactly.
class DesktopHorizontalScrollRegion extends StatefulWidget {
  const DesktopHorizontalScrollRegion({
    super.key,
    required this.builder,
  });

  final Widget Function(
    BuildContext context,
    ScrollController? controller,
  ) builder;

  @override
  State<DesktopHorizontalScrollRegion> createState() =>
      _DesktopHorizontalScrollRegionState();
}

class _DesktopHorizontalScrollRegionState
    extends State<DesktopHorizontalScrollRegion> {
  final ScrollController _controller = ScrollController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return widget.builder(context, Platform.isWindows ? _controller : null);
  }
}
