import 'dart:async';
import 'dart:io';

import 'package:dlna_dart/dlna.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/request/config/api_endpoints.dart';
import 'package:kazumi/services/logging/logger.dart';

String buildDirectCastUrl({
  required String video,
  required String backendUrl,
}) {
  final backend = Uri.tryParse(backendUrl);
  var source = Uri.tryParse(video);
  if (backend == null || source == null) return video;

  // Playback may already be using AniWorld's /api/video compatibility proxy.
  // A DLNA renderer should receive the original CDN URL, otherwise every byte
  // is relayed through the bandwidth-limited cloud server. Unwrap a few levels
  // defensively in case a proxy URL was accidentally nested.
  for (var depth = 0; depth < 3; depth++) {
    final isBackendProxy = source!.scheme == backend.scheme &&
        source.host == backend.host &&
        source.port == backend.port &&
        source.path == '/api/video';
    if (!isBackendProxy) break;

    final upstream = Uri.tryParse(source.queryParameters['url'] ?? '');
    if (upstream == null ||
        !(upstream.scheme == 'http' || upstream.scheme == 'https')) {
      break;
    }
    source = upstream;
  }
  return source.toString();
}

class RemotePlay {
  static const MethodChannel _networkChannel = MethodChannel(
    'com.predidit.kazumi/network',
  );

  Future<bool> castVideo({
    required String video,
    required String title,
    Duration position = Duration.zero,
  }) async {
    final source = Uri.tryParse(video);
    if (source == null ||
        !(source.scheme == 'http' || source.scheme == 'https')) {
      KazumiDialog.showToast(message: '本地文件或无效地址无法投屏');
      return false;
    }

    final castUrl = buildDirectCastUrl(
      video: video,
      backendUrl: ApiEndpoints.selfBackend,
    );
    try {
      await _setAndroidMulticastLock(true);
      final result = await KazumiDialog.show<bool>(
        builder: (_) => _RemoteCastDialog(
          castUrl: castUrl,
          title: title.trim().isEmpty ? 'AniWorld' : title.trim(),
          position: position,
        ),
      );
      return result == true;
    } catch (error) {
      KazumiLogger().e('RemotePlay: failed to open cast dialog', error: error);
      KazumiDialog.showToast(message: '投屏启动失败：$error');
      return false;
    } finally {
      await _setAndroidMulticastLock(false);
    }
  }

  Future<void> _setAndroidMulticastLock(bool enabled) async {
    if (!Platform.isAndroid) return;
    try {
      await _networkChannel.invokeMethod<void>(
        enabled ? 'acquireMulticastLock' : 'releaseMulticastLock',
      );
    } catch (error) {
      KazumiLogger().w(
        'RemotePlay: failed to ${enabled ? "acquire" : "release"} multicast lock',
        error: error,
      );
    }
  }
}

class _RemoteCastDialog extends StatefulWidget {
  const _RemoteCastDialog({
    required this.castUrl,
    required this.title,
    required this.position,
  });

  final String castUrl;
  final String title;
  final Duration position;

  @override
  State<_RemoteCastDialog> createState() => _RemoteCastDialogState();
}

class _RemoteCastDialogState extends State<_RemoteCastDialog> {
  DLNAManager? _manager;
  StreamSubscription<Map<String, DLNADevice>>? _subscription;
  Timer? _searchTimer;
  final Map<String, DLNADevice> _devices = {};
  bool _searching = true;
  bool _casting = false;
  String _message = '正在搜索设备，请确保手机与投屏设备在同一局域网';
  int _searchGeneration = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _startDiscovery());
  }

  Future<void> _startDiscovery() async {
    final generation = ++_searchGeneration;
    await _stopDiscovery();
    if (!mounted) return;
    setState(() {
      _devices.clear();
      _searching = true;
      _message = '正在搜索设备，请确保手机与投屏设备在同一局域网';
    });

    final manager = DLNAManager();
    _manager = manager;
    try {
      final deviceManager = await manager
          .start(reusePort: true)
          .timeout(const Duration(seconds: 8));
      if (!mounted || generation != _searchGeneration) {
        manager.stop();
        return;
      }
      _subscription = deviceManager.devices.stream.listen(
        (devices) {
          if (!mounted || generation != _searchGeneration) return;
          setState(() {
            _devices
              ..clear()
              ..addAll(devices);
            _searching = false;
            _message = _devices.isEmpty ? '暂未发现可投屏设备' : '';
          });
        },
        onError: (Object error) {
          if (!mounted || generation != _searchGeneration) return;
          setState(() {
            _searching = false;
            _message = '设备搜索失败：$error';
          });
        },
      );
      _searchTimer = Timer(const Duration(seconds: 15), () {
        if (!mounted ||
            generation != _searchGeneration ||
            _devices.isNotEmpty) {
          return;
        }
        setState(() {
          _searching = false;
          _message = '未发现设备，请检查电视投屏功能和局域网后重试';
        });
      });
    } catch (error) {
      KazumiLogger().e('RemotePlay: DLNA discovery failed', error: error);
      if (!mounted || generation != _searchGeneration) return;
      setState(() {
        _searching = false;
        _message = '投屏搜索失败：$error';
      });
    }
  }

  Future<void> _castTo(DLNADevice device) async {
    if (_casting) return;
    setState(() => _casting = true);
    try {
      KazumiDialog.showToast(message: '正在连接 ${device.info.friendlyName}...');
      await device
          .setUrl(widget.castUrl, title: widget.title)
          .timeout(const Duration(seconds: 12));
      await Future<void>.delayed(const Duration(milliseconds: 250));
      await device.play().timeout(const Duration(seconds: 8));
      if (widget.position > const Duration(seconds: 2)) {
        try {
          await device
              .seek(_formatDlnaPosition(widget.position))
              .timeout(const Duration(seconds: 5));
        } catch (error) {
          KazumiLogger().w(
            'RemotePlay: renderer does not support initial seek',
            error: error,
          );
        }
      }
      KazumiDialog.showToast(message: '已投屏至 ${device.info.friendlyName}');
      KazumiDialog.dismiss(popWith: true);
    } catch (error) {
      KazumiLogger().e('RemotePlay: failed to cast', error: error);
      if (mounted) setState(() => _casting = false);
      KazumiDialog.showToast(message: '投屏失败：$error');
    }
  }

  String _formatDlnaPosition(Duration value) {
    final hours = value.inHours.toString().padLeft(2, '0');
    final minutes = (value.inMinutes % 60).toString().padLeft(2, '0');
    final seconds = (value.inSeconds % 60).toString().padLeft(2, '0');
    return '$hours:$minutes:$seconds';
  }

  Future<void> _stopDiscovery() async {
    _searchTimer?.cancel();
    _searchTimer = null;
    await _subscription?.cancel();
    _subscription = null;
    _manager?.stop();
    _manager = null;
  }

  @override
  void dispose() {
    _searchGeneration++;
    unawaited(_stopDiscovery());
    super.dispose();
  }

  String _deviceType(DLNADevice device) {
    final parts = device.info.deviceType.split(':');
    return parts.isEmpty ? 'DLNA 设备' : parts.last;
  }

  IconData _deviceIcon(DLNADevice device) {
    switch (_deviceType(device)) {
      case 'MediaRenderer':
      case 'MediaServer':
        return Icons.cast_connected;
      case 'InternetGatewayDevice':
        return Icons.router;
      case 'Printer':
        return Icons.print;
      default:
        return Icons.tv_rounded;
    }
  }

  @override
  Widget build(BuildContext context) {
    final devices = _devices.values.toList()
      ..sort((a, b) => a.info.friendlyName.compareTo(b.info.friendlyName));
    return AlertDialog(
      title: const Text('远程投屏'),
      content: SizedBox(
        width: 420,
        child: devices.isEmpty
            ? Padding(
                padding: const EdgeInsets.symmetric(vertical: 28),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (_searching) const CircularProgressIndicator(),
                    if (_searching) const SizedBox(height: 18),
                    Text(_message, textAlign: TextAlign.center),
                  ],
                ),
              )
            : ListView.separated(
                shrinkWrap: true,
                itemCount: devices.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (_, index) {
                  final device = devices[index];
                  return ListTile(
                    enabled: !_casting,
                    leading: Icon(_deviceIcon(device)),
                    title: Text(device.info.friendlyName),
                    subtitle: Text(_deviceType(device)),
                    trailing:
                        _casting ? const CircularProgressIndicator() : null,
                    onTap: () => _castTo(device),
                  );
                },
              ),
      ),
      actions: [
        TextButton(
          onPressed:
              _casting ? null : () => KazumiDialog.dismiss(popWith: false),
          child: const Text('取消'),
        ),
        TextButton.icon(
          onPressed: _casting ? null : _startDiscovery,
          icon: const Icon(Icons.refresh_rounded),
          label: const Text('重新搜索'),
        ),
      ],
    );
  }
}
