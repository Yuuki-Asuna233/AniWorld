import 'dart:async';

import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/services/video_source/video_source_service.dart';
import 'package:kazumi/webview/video/video_webview_controller.dart';

/// One WebView owns one navigation at a time. The caller's deadline does not
/// release this ownership while an uncancellable native operation is pending.
class WebViewVideoSourceService implements IVideoSourceService {
  VideoWebviewController? _webview;
  StreamSubscription? _logSubscription;
  Future<void>? _resolveTail = Future<void>.value();
  Future<void>? _disposeFuture;
  _ResolveRequest? _activeRequest;
  bool _cleanupFailed = false;

  final StreamController<String> _logController =
      StreamController<String>.broadcast();
  Stream<String> get onLog => _logController.stream;

  @override
  Future<VideoSource> resolve(
    String episodeUrl, {
    required bool useLegacyParser,
    int offset = 0,
    Duration timeout = const Duration(seconds: 15),
  }) {
    final tail = _resolveTail;
    if (tail == null) {
      return Future.error(const VideoSourceCancelledException());
    }
    if (_cleanupFailed) {
      return Future.error(
          const VideoSourceNotFoundException('解析器资源清理失败，请重新打开播放页面'));
    }
    _activeRequest?.cancel();
    final request = _ResolveRequest(timeout);
    _activeRequest = request;
    // Queueing, initialization, navigation and parsing share the caller's budget.
    // Cleanup remains owned by the work tail after the result is delivered.
    _resolveTail = tail
        .then((_) => _runResolve(
              request,
              episodeUrl,
              useLegacyParser: useLegacyParser,
              offset: offset,
            ))
        .catchError((Object error, StackTrace stack) {
      request.fail(error, stack);
      _reportCleanupError(error, stack);
    });
    return request.result;
  }

  Future<void> _runResolve(
    _ResolveRequest request,
    String episodeUrl, {
    required bool useLegacyParser,
    required int offset,
  }) async {
    VideoWebviewController? view;
    VideoSource? source;
    var didStartLoad = false;
    try {
      if (_cleanupFailed) {
        throw const VideoSourceNotFoundException('解析器资源清理失败，请重新打开播放页面');
      }
      request.throwIfNotCurrent(_activeRequest);
      if (_webview == null) {
        view = VideoWebviewControllerFactory.getController();
        _webview = view;
        await view.init();
        request.throwIfNotCurrent(_activeRequest);
        _logSubscription = view.onLog.listen((log) {
          if (!_logController.isClosed) _logController.add(log);
        });
      } else {
        view = _webview!;
      }
      request.throwIfNotCurrent(_activeRequest);

      // Broadcast results can arrive before loadUrl returns. Subscribe first.
      // This completer only carries values: early stream errors terminate the
      // caller directly, so there is no unobserved parserFuture error.
      final parsed = Completer<VideoParserEvent>();
      request.attachParser(view.onVideoURLParser.listen(
        (event) {
          if (identical(_activeRequest, request) &&
              request.pending &&
              !parsed.isCompleted) {
            parsed.complete(event);
          }
        },
        onError: (Object error, StackTrace stack) => request.fail(error, stack),
        onDone: () {
          if (!parsed.isCompleted) {
            request.fail(const VideoSourceNotFoundException());
          }
        },
      ));
      request.throwIfNotCurrent(_activeRequest);
      didStartLoad = true;
      await view.loadUrl(episodeUrl, useLegacyParser, offset: offset);
      request.throwIfNotCurrent(_activeRequest);
      final event = await Future.any<VideoParserEvent?>([
        parsed.future,
        request.stopped.then<VideoParserEvent?>((_) => null),
      ]);
      request.throwIfNotCurrent(_activeRequest);
      if (event == null) throw const VideoSourceNotFoundException();
      source = VideoSource(
        url: event.url,
        offset: event.offset,
        type: VideoSourceType.online,
        format: event.format,
      );
      // Deliver an immutable result now. The work tail still owns/drains this
      // native instance, so another resolution cannot reuse its callbacks.
      request.throwIfNotCurrent(_activeRequest);
      request.complete(source);
    } catch (error, stack) {
      request.fail(error, stack);
    } finally {
      try {
        await request.cancelParser();
      } catch (error, stack) {
        request.fail(error, stack);
        _reportCleanupError(error, stack);
      }
      if (didStartLoad) {
        try {
          await view!.unloadPage();
        } catch (error, stack) {
          request.fail(error, stack);
          _reportCleanupError(error, stack);
        }
      }
      // Native parser callbacks do not carry a navigation ID. Even successful
      // requests therefore need a fresh instance: blank-page navigation alone
      // cannot prevent a late callback from satisfying the next subscription.
      // Drain native operations and disposal before releasing this work tail.
      if (view != null) {
        try {
          await _discardWebview(view);
        } catch (error, stack) {
          // Do not create another WebView while an old native instance may
          // still be alive. Only disposing this service may retry cleanup.
          _cleanupFailed = true;
          request.fail(error, stack);
          _reportCleanupError(error, stack);
        }
      }
      if (identical(_activeRequest, request)) _activeRequest = null;
    }
  }

  Future<void> _discardWebview(VideoWebviewController view) async {
    if (!identical(_webview, view)) return;
    final logs = _logSubscription;
    _logSubscription = null;
    try {
      await logs?.cancel();
    } finally {
      await view.dispose();
    }
    _webview = null;
  }

  @override
  void cancel() => _activeRequest?.cancel();

  @override
  Future<void> dispose() => _disposeFuture ??= _dispose();

  Future<void> _dispose() async {
    final tail = _resolveTail;
    _resolveTail = null;
    cancel();
    await tail;
    _activeRequest = null;
    try {
      final view = _webview;
      if (view != null) await _discardWebview(view);
    } finally {
      await _logController.close();
    }
  }
}

void _reportCleanupError(Object error, StackTrace stack) {
  KazumiLogger().w('WebView video source: cleanup failed',
      error: error, stackTrace: stack);
}

class _ResolveRequest {
  _ResolveRequest(Duration timeout) {
    _deadline =
        Timer(timeout, () => fail(VideoSourceTimeoutException(timeout)));
  }

  final Completer<VideoSource> _result = Completer<VideoSource>();
  final Completer<void> _stopped = Completer<void>();
  late final Timer _deadline;
  StreamSubscription<VideoParserEvent>? _parser;
  Future<void>? _parserCancellation;
  Object? _failure;

  Future<VideoSource> get result => _result.future;
  Future<void> get stopped => _stopped.future;
  bool get pending => !_result.isCompleted;

  void attachParser(StreamSubscription<VideoParserEvent> subscription) {
    _parser = subscription;
  }

  Future<void> cancelParser() =>
      _parserCancellation ??= _parser?.cancel() ?? Future<void>.value();

  void fail(Object error, [StackTrace? stack]) {
    if (!pending) return;
    _failure = error;
    _deadline.cancel();
    _stopped.complete();
    _result.completeError(error, stack);
    unawaited(cancelParser().catchError((Object error, StackTrace stack) {
      _reportCleanupError(error, stack);
    }));
  }

  void cancel() => fail(const VideoSourceCancelledException());

  void complete(VideoSource source) {
    if (!pending) return;
    _deadline.cancel();
    _stopped.complete();
    _result.complete(source);
  }

  void throwIfNotCurrent(_ResolveRequest? current) {
    if (!pending || !identical(current, this)) {
      throw _failure ?? const VideoSourceCancelledException();
    }
  }
}
