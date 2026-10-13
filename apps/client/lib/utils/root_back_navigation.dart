import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';

/// Android can dispatch one system-back gesture to both the visible root
/// route and the tab navigator kept alive underneath it. Keep the gesture
/// single-consumer so one swipe never removes two routes.
class RootBackNavigationGuard {
  static const Duration duplicateWindow = Duration(milliseconds: 650);
  static DateTime? _lastClaimedAt;

  static bool get wasRecentlyClaimed {
    final lastClaimedAt = _lastClaimedAt;
    return lastClaimedAt != null &&
        DateTime.now().difference(lastClaimedAt) < duplicateWindow;
  }

  static bool tryClaim() {
    if (wasRecentlyClaimed) return false;
    _lastClaimedAt = DateTime.now();
    return true;
  }

  @visibleForTesting
  static void reset() {
    _lastClaimedAt = null;
  }
}

/// Bridges Android's system-back callback to the compact settings navigator.
///
/// The settings page is a root Modular route containing its own declarative
/// Navigator. On some Android versions the callback also reaches the retained
/// My tab; keeping this small coordinator lets that tab hand the event back to
/// the visible settings detail instead of applying My's "go to Discover"
/// behavior.
class SettingsBackNavigation {
  static bool Function()? _handler;

  static void register(bool Function() handler) {
    _handler = handler;
  }

  static void unregister(bool Function() handler) {
    if (identical(_handler, handler)) {
      _handler = null;
    }
  }

  static bool tryHandle() => _handler?.call() ?? false;
}

/// Gives the currently visible player first refusal of Android's back event.
///
/// Flutter Modular keeps the tab Navigator (and therefore the My page) alive
/// below `/video/`.  On some Android builds an edge-back callback reaches that
/// retained Navigator before it reaches the route displayed on top.  Delegating
/// to the video page keeps the gesture equivalent to pressing its back button:
/// only the player route is popped, leaving the history route intact.
class VideoBackNavigation {
  static bool Function()? _handler;

  static void register(bool Function() handler) {
    _handler = handler;
  }

  static void unregister(bool Function() handler) {
    if (identical(_handler, handler)) {
      _handler = null;
    }
  }

  static bool tryHandle() => _handler?.call() ?? false;
}

bool isMediaOverlayRoute(String path) {
  final normalized = Uri.tryParse(path)?.path ?? path;
  return normalized == '/info' ||
      normalized.startsWith('/info/') ||
      normalized == '/video' ||
      normalized.startsWith('/video/');
}

bool isSettingsRoute(String path) {
  final normalized = Uri.tryParse(path)?.path ?? path;
  return normalized == '/settings' ||
      normalized == '/settings/' ||
      normalized.startsWith('/settings/');
}

/// Pops a root-level details/player page before a tab page handles app exit.
///
/// Flutter Modular keeps the tab navigator alive below root module routes. On
/// Android, that tab's PopScope can receive the system back callback while an
/// `/info` or `/video` page is still visible. Consuming it here prevents the
/// underlying tab from showing its exit prompt or navigating to Discover.
bool popMediaOverlayIfPresent(
  BuildContext context, {
  String? currentPath,
}) {
  // The visible route already handled this same Android gesture. Consume the
  // callback from the retained tab route without navigating again.
  if (RootBackNavigationGuard.wasRecentlyClaimed) {
    return true;
  }

  // Do this before inspecting Modular's path.  The retained tab can report
  // its own `/tab/my/...` path even while the player route is visible.
  if (VideoBackNavigation.tryHandle()) {
    return true;
  }

  // A settings detail is hosted by a nested Navigator while Modular's path
  // remains `/settings/`. Try that active coordinator before relying on the
  // route path, because the retained My tab can receive the callback with its
  // own route context during an Android edge gesture.
  if (SettingsBackNavigation.tryHandle()) {
    RootBackNavigationGuard.tryClaim();
    return true;
  }

  final path = currentPath ?? Modular.to.path;

  if (isSettingsRoute(path)) {
    // The compact settings detail is a page in the settings route's nested
    // Navigator, so let it consume the event before touching the root stack.
    // For a real child route (decoder/editor/etc.) pop exactly that child.
    if (Modular.to.canPop()) {
      if (!RootBackNavigationGuard.tryClaim()) return true;
      Modular.to.pop();
    }
    return true;
  }

  if (!isMediaOverlayRoute(path)) return false;

  // Prefer Modular's route book. The tab RouterOutlet is retained below
  // `/info` and `/video`; popping the root Navigator first can pop that
  // retained tab stack instead of the visible overlay. That manifests as the
  // first edge swipe doing nothing and the second swipe jumping back to My.
  if (Modular.to.canPop()) {
    if (!RootBackNavigationGuard.tryClaim()) return true;
    Modular.to.pop();
    return true;
  }

  // Fallback for the short interval before Modular has synchronized its route
  // book with Flutter's Navigator after an overlay is pushed.
  final rootNavigator = Navigator.of(context, rootNavigator: true);
  if (rootNavigator.canPop()) {
    if (!RootBackNavigationGuard.tryClaim()) return true;
    rootNavigator.pop();
  }
  return true;
}
