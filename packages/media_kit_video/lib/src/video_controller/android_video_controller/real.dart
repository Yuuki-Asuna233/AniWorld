/// This file is a part of media_kit (https://github.com/media-kit/media-kit).
///
/// Copyright © 2021 & onwards, Hitesh Kumar Saini <saini123hitesh@gmail.com>.
/// All rights reserved.
/// Use of this source code is governed by MIT license that can be found in the LICENSE file.
import 'dart:io';
import 'dart:async';
import 'dart:collection';
import 'dart:ffi';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import 'package:synchronized/synchronized.dart';

import 'package:media_kit/media_kit.dart';
import 'package:media_kit/ffi/ffi.dart';

import 'package:media_kit_video/src/utils/query_decoders.dart';
import 'package:media_kit_video/src/video_controller/platform_video_controller.dart';

/// {@template android_video_controller}
///
/// AndroidVideoController
/// ----------------------
///
/// The [PlatformVideoController] implementation based on native JNI & C/C++ used on Android.
///
/// {@endtemplate}
class AndroidVideoController extends PlatformVideoController {
  /// Whether [AndroidVideoController] is supported on the current platform or not.
  static bool get supported => Platform.isAndroid;

  /// Pointer address to the global object reference of `android.view.Surface` i.e. `(intptr_t)(*android.view.Surface)`.
  final ValueNotifier<int?> wid = ValueNotifier<int?>(null);

  /// Serializes creation, surface updates, size notifications and cleanup.
  final lock = Lock();

  final int _handle;
  bool _disposed = false;
  Future<void>? _disposeFuture;

  NativePlayer get platform => player.platform as NativePlayer;
  bool get _active => !_disposed && !platform.disposed;

  Future<void> setProperty(String key, String value) async {
    await platform.setProperty(key, value, waitForInitialization: false);
  }

  Future<void> setProperties(Map<String, String> properties) async {
    for (final entry in properties.entries) {
      if (!_active) return;
      await setProperty(entry.key, entry.value);
    }
  }

  /// Listener for updating the --wid property.
  void widListener() => _schedule('surface update', _updateSurface);

  // Notifier and stream listeners cannot await work. Observe their Futures
  // explicitly, and never await a nested queue operation from inside the lock.
  void _schedule(String operation, Future<void> Function() callback) {
    if (!_active) return;
    unawaited(
      lock
          .synchronized(() async {
            if (_active) await callback();
          })
          .catchError((Object error, StackTrace stack) {
            if (!_active) return; // Disposal cancels pending native operations.
            FlutterError.reportError(
              FlutterErrorDetails(
                exception: error,
                stack: stack,
                library: 'media_kit_video',
                context: ErrorDescription('during Android video $operation'),
              ),
            );
          }),
    );
  }

  Future<void> _updateSurface() async {
    final width = rect.value?.width.toInt() ?? 1;
    final height = rect.value?.height.toInt() ?? 1;
    final androidSurfaceSizeValue = [width, height].join('x');
    final widValue = wid.value?.toString() ?? '0';
    // When --wid is 0, vo=null is required to avoid SIGSEGV.
    final voValue = widValue == '0' ? 'null' : configuration.vo!;
    final vidValue = widValue == '0' ? 'no' : 'auto';
    // It is important to re-initialize --vo after --android-surface-size.
    await setProperty('vo', 'null');
    if (!_active) return;
    await setProperties({
      // ORDER IS IMPORTANT.
      'android-surface-size': androidSurfaceSizeValue,
      'wid': widValue,
      'vo': voValue,
      // It is important to re-initialize --vid in-case of --vo=mediacodec_embed.
      // Not doing so causes error "Could not open codec." & video never gets rendered.
      if (configuration.vo == 'mediacodec_embed') 'vid': vidValue,
    });
    // Instead of seeking to the start (Duration.zero), seek to the current playback position
    // without jumping the user to the start of the media.
    if (!_active) return;
    // Public seek takes the player's lock and waits for video initialization.
    // Cleanup holds that lock while draining this queue; initialization can
    // also depend on this surface. Use the internal command after media load.
    if (player.state.duration > Duration.zero ||
        player.state.position > Duration.zero) {
      await platform.command([
        'seek',
        (player.state.position.inMilliseconds / 1000).toStringAsFixed(4),
        'absolute',
      ], waitForInitialization: false);
    }
  }

  void _onResize(Rect rectangle, int textureId, int surfaceId) {
    _schedule('resize notification', () async {
      rect.value = rectangle;
      id.value = textureId;
      // widListener appends a separate task, rather than acquiring this lock
      // recursively. Platform channel replies remain free to complete.
      wid.value = surfaceId;
    });
  }

  /// [StreamSubscription] for listening to video [Rect].
  StreamSubscription<VideoParams>? videoParamsSubscription;

  /// {@macro android_video_controller}
  AndroidVideoController._(super.player, super.configuration, this._handle) {
    wid.addListener(widListener);
    videoParamsSubscription = player.stream.videoParams.listen(
      (event) => _schedule('video size update', () async {
        final int width;
        final int height;
        if (event.rotate == 0 || event.rotate == 180) {
          width = event.dw ?? 0;
          height = event.dh ?? 0;
        } else {
          // width & height are swapped for 90 or 270 degrees rotation.
          width = event.dh ?? 0;
          height = event.dw ?? 0;
        }

        final isZero = width == 0 || height == 0;
        final isSame =
            width == rect.value?.width.toInt() &&
            height == rect.value?.height.toInt();
        if (isZero || isSame) {
          return;
        }

        await _channel.invokeMethod('VideoOutputManager.SetSurfaceSize', {
          'handle': _handle.toString(),
          'width': width.toString(),
          'height': height.toString(),
        });

        if (!_active) return;
        rect.value = Rect.fromLTWH(
          0.0,
          0.0,
          width.toDouble(),
          height.toDouble(),
        );

        if (!waitUntilFirstFrameRenderedCompleter.isCompleted) {
          waitUntilFirstFrameRenderedCompleter.complete();
        }
      }),
    );
  }

  /// {@macro android_video_controller}
  static Future<PlatformVideoController> create(
    Player player,
    VideoControllerConfiguration configuration,
  ) async {
    Future<String> getDefaultHwdec() async {
      // Enforce software rendering in emulators.
      bool hw = configuration.enableHardwareAcceleration;
      final bool isEmulator = await _channel.invokeMethod('Utils.IsEmulator');
      if (isEmulator) {
        hw = false;
        debugPrint('media_kit: Emulator detected.');
        debugPrint('media_kit: Enforcing S/W rendering.');
      }
      return hw ? 'auto-safe' : 'no';
    }

    // Update [configuration] to have default values.
    configuration = configuration.copyWith(
      vo: configuration.vo ?? 'gpu',
      hwdec: configuration.hwdec ?? await getDefaultHwdec(),
    );

    // Retrieve the native handle of the [Player].
    final handle = await player.handle;
    // Return the existing [VideoController] if it's already created.
    if (_controllers.containsKey(handle)) {
      return _controllers[handle]!;
    }

    // In case no video-decoders are found, this means media_kit_libs_***_audio is being used.
    // Thus, --vid=no is required to prevent libmpv from trying to decode video (otherwise bad things may happen).
    //
    // Search for common H264 decoder to check if video support is available.
    final decoders = await queryDecoders(handle);
    if ((player.platform as NativePlayer).disposed) {
      throw StateError('Video output creation cancelled');
    }
    if (!decoders.contains('h264')) {
      throw UnsupportedError(
        '[VideoController] is not available.'
        ' '
        'Please use media_kit_libs_***_video instead of media_kit_libs_***_audio.',
      );
    }

    // Creation:
    final controller = AndroidVideoController._(player, configuration, handle);

    // Register [_dispose] for execution upon [Player.dispose].
    player.platform?.releaseCritical.add(controller._dispose);

    // Store the [VideoController] in the [_controllers].
    _controllers[handle] = controller;

    await controller.lock.synchronized(() async {
      if (!controller._active) {
        throw StateError('Video output creation cancelled');
      }
      await _channel.invokeMethod('VideoOutputManager.Create', {
        'handle': handle.toString(),
        'enableSurfaceProducer': configuration.enableAndroidSurfaceProducer,
      });

      if (!controller._active) {
        throw StateError('Video output creation cancelled');
      }
      await controller.setProperties({
        // It is necessary to set vo=null here to avoid SIGSEGV, --wid must be assigned before vo=gpu is set.
        'vo': 'null',
        'hwdec': configuration.hwdec!,
        'vid': 'auto',
        'force-window': 'yes',
        'gpu-api': configuration.vo == 'gpu-next' ? 'vulkan,opengl' : 'auto',
        'sub-use-margins': 'no',
        'sub-font-provider': 'none',
        'sub-scale-with-window': 'yes',
        'hwdec-codecs': 'h264,hevc,mpeg4,mpeg2video,vp8,vp9,av1',
      });
    });
    if (!controller._active) {
      throw StateError('Video output creation cancelled');
    }

    // Return the [PlatformVideoController].
    return controller;
  }

  /// Sets the required size of the video output.
  /// This may yield substantial performance improvements if a small [width] & [height] is specified.
  ///
  /// Remember:
  /// * “Premature optimization is the root of all evil”
  /// * “With great power comes great responsibility”
  @override
  Future<void> setSize({int? width, int? height}) {
    throw UnsupportedError(
      '[AndroidVideoController.setSize] is not available on Android',
    );
  }

  /// Disposes the instance. Releases allocated resources back to the system.
  Future<void> _dispose() => _disposeFuture ??= _disposeOnce();

  Future<void> _disposeOnce() async {
    _disposed = true;
    _controllers.remove(_handle);
    wid.removeListener(widListener);
    try {
      await videoParamsSubscription?.cancel();
    } finally {
      // All earlier work has either finished or observed the disposal gate.
      // Critical release errors propagate to NativePlayer; it must not destroy
      // mpv while the native surface may still be attached.
      await lock.synchronized(() async {
        try {
          _detachSurface();
          await _channel.invokeMethod('VideoOutputManager.Dispose', {
            'handle': _handle.toString(),
          });
        } finally {
          wid.dispose();
          super.dispose();
        }
      });
    }
  }

  void _detachSurface() {
    // NativePlayer marks itself disposed before running critical releases, but
    // keeps this handle alive until they finish. Public setters are unavailable
    // here. Detach synchronously before Java releases the underlying Surface.
    for (final property in const {'vo': 'null', 'wid': '0'}.entries) {
      final name = property.key.toNativeUtf8();
      final value = property.value.toNativeUtf8();
      try {
        final result = platform.mpv.mpv_set_property_string(
          Pointer.fromAddress(_handle),
          name.cast(),
          value.cast(),
        );
        if (result < 0) {
          throw StateError(
            'Android surface detach failed: ${property.key} (mpv error $result)',
          );
        }
      } finally {
        calloc.free(name);
        calloc.free(value);
      }
    }
  }

  /// Currently created [AndroidVideoController]s.
  static final _controllers = HashMap<int, AndroidVideoController>();

  /// [MethodChannel] for invoking platform specific native implementation.
  static final _channel =
      const MethodChannel('com.alexmercerind/media_kit_video')
        ..setMethodCallHandler((MethodCall call) async {
          try {
            debugPrint(call.method.toString());
            debugPrint(call.arguments.toString());
            switch (call.method) {
              case 'VideoOutput.Resize':
                {
                  // Notify about updated texture ID & [Rect].
                  final int handle = call.arguments['handle'];
                  final Rect rect = Rect.fromLTWH(
                    call.arguments['rect']['left'] * 1.0,
                    call.arguments['rect']['top'] * 1.0,
                    call.arguments['rect']['width'] * 1.0,
                    call.arguments['rect']['height'] * 1.0,
                  );
                  final int id = call.arguments['id'];
                  final int wid = call.arguments['wid'];
                  _controllers[handle]?._onResize(rect, id, wid);
                  break;
                }
              case 'VideoOutput.WaitUntilFirstFrameRenderedNotify':
                {
                  // Notify about updated texture ID & [Rect].
                  final int handle = call.arguments['handle'];
                  debugPrint(handle.toString());
                  // Notify about the first frame being rendered.
                  final controller = _controllers[handle];
                  controller?._schedule('first frame notification', () async {
                    final completer =
                        controller.waitUntilFirstFrameRenderedCompleter;
                    if (!completer.isCompleted) completer.complete();
                  });
                  break;
                }
              default:
                {
                  break;
                }
            }
          } catch (exception, stacktrace) {
            debugPrint(exception.toString());
            debugPrint(stacktrace.toString());
          }
        });
}
