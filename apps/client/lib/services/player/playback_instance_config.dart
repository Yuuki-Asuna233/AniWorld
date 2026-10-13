import 'dart:io';
import 'package:kazumi/services/network/proxy_utils.dart';
import 'package:kazumi/services/platform/platform_environment_service.dart';
import 'package:kazumi/services/storage/storage.dart';

/// Engine/output settings require a new instance. URL, headers,
/// offset, cache mode and playback intent belong to an individual media load.
class PlaybackInstanceConfig {
  const PlaybackInstanceConfig(this.renderer, this.decoder, this.hardware,
      this.audioOutput, this.proxy, this.adBlocker, this.logLevel);
  final String? renderer;
  final String decoder;
  final bool hardware;
  final String audioOutput;
  final String proxy;
  final bool adBlocker;
  final int logLevel;

  static Future<PlaybackInstanceConfig> read(
      {required bool adBlocker,
      required int logLevel,
      String? renderer,
      String? decoder,
      bool? hardware}) async {
    bool useHardware = hardware ?? GStorage.getSetting(SettingsKeys.hAenable);
    String decode =
        decoder ?? GStorage.getSetting(SettingsKeys.hardwareDecoder);
    String? output;
    if (Platform.isAndroid) {
      output =
          renderer ?? GStorage.getSetting(SettingsKeys.androidVideoRenderer);
      if (output == 'auto') {
        output = await PlatformEnvironmentService.getAndroidSdkVersion() >= 34
            ? 'gpu-next'
            : 'gpu';
      }
      if (output == 'mediacodec_embed') {
        useHardware = true;
        decode = 'mediacodec';
      }
    }
    final proxy = GStorage.getSetting(SettingsKeys.proxyEnable)
        ? ProxyUtils.getFormattedProxyUrl(
                GStorage.getSetting(SettingsKeys.proxyUrl)) ??
            ''
        : '';
    return PlaybackInstanceConfig(
        output,
        decode,
        useHardware,
        GStorage.getSetting(SettingsKeys.androidEnableOpenSLES)
            ? 'opensles'
            : 'audiotrack',
        proxy,
        adBlocker,
        logLevel);
  }

  Object get identity =>
      (renderer, decoder, hardware, audioOutput, proxy, adBlocker, logLevel);
}
