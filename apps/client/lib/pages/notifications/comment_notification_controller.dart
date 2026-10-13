import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:kazumi/modules/notifications/comment_notification.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/services/storage/storage.dart';

class CommentNotificationController extends ChangeNotifier {
  CommentNotificationController() {
    _accountSubscription = GStorage.accountChanges.listen((_) => _reset());
  }

  late final StreamSubscription<void> _accountSubscription;
  int _generation = 0;
  Future<void> _operations = Future<void>.value();
  Future<void>? _refreshFuture;
  AniWorldAccountSnapshot? _refreshAccount;
  bool _disposed = false;
  final List<CommentNotification> _likes = [];
  final List<CommentNotification> _replies = [];
  bool _loading = false;
  int _unreadCount = 0;
  DateTime? _lastLoadedAt;

  List<CommentNotification> get likes => List.unmodifiable(_likes);
  List<CommentNotification> get replies => List.unmodifiable(_replies);
  bool get isLoading => _loading;
  int get unreadCount => _unreadCount;

  void _reset() {
    if (_disposed) return;
    _generation++;
    _operations = Future<void>.value();
    _refreshFuture = null;
    _refreshAccount = null;
    _loading = false;
    _likes.clear();
    _replies.clear();
    _unreadCount = 0;
    _lastLoadedAt = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    unawaited(_accountSubscription.cancel());
    super.dispose();
  }

  bool _current(AniWorldAccountSnapshot account, int generation) =>
      !_disposed && generation == _generation && account.isCurrent;

  Future<void> _enqueue(AniWorldAccountSnapshot account, int generation,
      Future<void> Function() operation) {
    final task = _operations.then((_) async {
      if (_current(account, generation)) await operation();
    });
    _operations =
        task.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return task;
  }

  Future<void> refresh({bool force = false}) {
    final account = AniWorldAccountSnapshot();
    if (_disposed || !account.isCurrent) return Future<void>.value();
    // Authentication must be checked before cooldown or in-flight guards.
    if (!account.isLoggedIn) {
      _reset();
      return Future<void>.value();
    }
    if (_refreshFuture != null && _refreshAccount?.isCurrent == true) {
      return _refreshFuture!;
    }
    if (!force &&
        _lastLoadedAt != null &&
        DateTime.now().difference(_lastLoadedAt!) <
            const Duration(minutes: 2)) {
      return Future<void>.value();
    }
    final generation = _generation;
    late final Future<void> task;
    task = _enqueue(account, generation, () => _load(account, generation))
        .whenComplete(() {
      if (identical(_refreshFuture, task)) {
        _refreshFuture = null;
        _refreshAccount = null;
      }
    });
    _refreshAccount = account;
    _refreshFuture = task;
    return task;
  }

  Future<void> _load(AniWorldAccountSnapshot account, int generation) async {
    bool current() => _current(account, generation);
    _loading = true;
    notifyListeners();
    try {
      final result = await AniWorldApi.getCommentNotifications(
        type: 'all',
        limit: 100,
        account: account,
      );
      if (!current()) return;
      _likes
        ..clear()
        ..addAll(result.notifications.where((item) => item.isLike));
      _replies
        ..clear()
        ..addAll(result.notifications.where((item) => !item.isLike));
      _unreadCount = result.unreadCount;
      _lastLoadedAt = DateTime.now();
    } catch (_) {
      if (current()) rethrow;
    } finally {
      if (!_disposed && generation == _generation) {
        _loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> markAllRead({String type = 'all'}) {
    final account = AniWorldAccountSnapshot();
    final generation = _generation;
    if (_disposed || !account.isLoggedIn) return Future<void>.value();
    return _enqueue(
        account, generation, () => _markAllRead(type, account, generation));
  }

  Future<void> _markAllRead(
      String type, AniWorldAccountSnapshot account, int generation) async {
    final marked = await AniWorldApi.markCommentNotificationsRead(
        type: type, account: account);
    if (!marked ||
        _disposed ||
        generation != _generation ||
        !account.isCurrent) {
      return;
    }
    // Reads and writes share a queue, so a pre-write GET cannot complete later
    // and resurrect unread flags or prevent the initial list from loading.
    if (type == 'all' || type == 'like') {
      for (var i = 0; i < _likes.length; i++) {
        _likes[i] = _likes[i].copyWith(isRead: true);
      }
    }
    if (type == 'all' || type == 'reply') {
      for (var i = 0; i < _replies.length; i++) {
        _replies[i] = _replies[i].copyWith(isRead: true);
      }
    }
    _unreadCount = _likes.where((item) => !item.isRead).length +
        _replies.where((item) => !item.isRead).length;
    notifyListeners();
  }
}
