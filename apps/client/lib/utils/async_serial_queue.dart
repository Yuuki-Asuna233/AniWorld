import 'dart:async';

/// Runs asynchronous player-property updates in submission order.
///
/// mpv properties are asynchronous. Serializing writes prevents a lifecycle
/// transition from overwriting a newer cache setting with an older one.
class AsyncSerialQueue {
  Future<void> _tail = Future<void>.value();

  Future<T> run<T>(Future<T> Function() action) {
    final previous = _tail;
    final completer = Completer<T>();
    _tail = () async {
      try {
        await previous;
      } catch (_) {}
      try {
        completer.complete(await action());
      } catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    }();
    return completer.future;
  }
}
