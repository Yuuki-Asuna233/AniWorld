import 'dart:io';
import 'dart:convert';
import 'dart:async';
import 'dart:typed_data';
import 'package:webdav_client/webdav_client.dart' as webdav;
import 'package:path_provider/path_provider.dart';
import 'package:kazumi/modules/history/history_sync.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/modules/collect/collect_module.dart';
import 'package:kazumi/modules/collect/collect_change_module.dart';
import 'package:kazumi/services/sync/history_sync_service.dart';
import 'package:kazumi/services/sync/webdav_document_store.dart';

class WebDav {
  String get _syncRootPath => GStorage.isLegacyAccount
      ? '/kazumiSync'
      : '/kazumiSync/${GStorage.accountStorageOwner}';
  String get _historyRootPath => '$_syncRootPath/history';
  String get _historyChangesPath => '$_historyRootPath/changes';
  String get _historySnapshotPath => '$_historyRootPath/snapshot.json';

  late String webDavURL;
  late String webDavUsername;
  late String webDavPassword;
  late Directory webDavLocalTempDirectory;
  late webdav.Client client;

  bool initialized = false;
  bool isHistorySyncing = false;
  Future<void> _webDavOperationQueue = Future.value();

  WebDav._internal();
  static final WebDav _instance = WebDav._internal();
  factory WebDav() => _instance;

  Future<void> init() async {
    var directory = await getApplicationSupportDirectory();
    webDavLocalTempDirectory = Directory('${directory.path}/webdavTemp');
    webDavURL = GStorage.getSetting(SettingsKeys.webDavURL);
    webDavUsername = GStorage.getSetting(SettingsKeys.webDavUsername);
    webDavPassword = GStorage.getSetting(SettingsKeys.webDavPassword);
    if (webDavURL.isEmpty) {
      //KazumiLogger().log(Level.warning, 'WebDAV URL is not set');
      throw Exception('请先填写WebDAV URL');
    }
    client = webdav.newClient(
      webDavURL,
      user: webDavUsername,
      password: webDavPassword,
      debug: false,
    );
    client.setHeaders({'accept-charset': 'utf-8'});
    client.c.options.contentType = 'application/octet-stream';
    try {
      await client.ping();
      await _ensureRemoteDirectory('/kazumiSync');
      await _ensureRemoteDirectory(_syncRootPath);
      await _ensureLocalTempDirectory();
      initialized = true;
      KazumiLogger().i('WebDav: webDav backup directory ready');
    } catch (e) {
      KazumiLogger().e('WebDav: WebDAV ping failed', error: e);
      rethrow;
    }
  }

  Future<T> _runWebDavExclusive<T>(Future<T> Function() action) =>
      GStorage.runAccountTask(() => _enqueueWebDav(action));

  Future<T> _enqueueWebDav<T>(Future<T> Function() action) {
    final previousOperation = _webDavOperationQueue;
    final completer = Completer<T>();
    _webDavOperationQueue = (() async {
      try {
        await previousOperation;
      } catch (_) {}
      try {
        completer.complete(await action());
      } catch (e, stackTrace) {
        completer.completeError(e, stackTrace);
      }
    })();
    return completer.future;
  }

  Future<void> _updateBox(String boxName) async {
    var directory = await getApplicationSupportDirectory();
    final storageName = GStorage.accountBoxName(boxName);
    final localFilePath = '${directory.path}/hive/$storageName.hive';
    final tempFilePath = '${webDavLocalTempDirectory.path}/$boxName.tmp';
    final webDavPath = '$_syncRootPath/$boxName.tmp';
    await File(localFilePath).copy(tempFilePath);
    try {
      await client.remove('$webDavPath.cache');
    } catch (_) {}
    await client.writeFromFile(tempFilePath, '$webDavPath.cache');
    try {
      await client.remove(webDavPath);
    } catch (_) {
      KazumiLogger().w('WebDav: former backup file not exist');
    }
    await client.rename('$webDavPath.cache', webDavPath, true);
    try {
      await File(tempFilePath).delete();
    } catch (_) {}
  }

  Future<void> syncHistory() async {
    if (isHistorySyncing) {
      KazumiLogger().w('WebDav: History is currently syncing');
      throw Exception('History is currently syncing');
    }
    isHistorySyncing = true;
    try {
      await _runWebDavExclusive(_syncHistory);
    } catch (e) {
      KazumiLogger().e('WebDav: history sync failed', error: e);
      rethrow;
    } finally {
      isHistorySyncing = false;
    }
  }

  Future<void> updateCollectibles() async {
    try {
      await _runWebDavExclusive(() async {
        await _updateBox('collectibles');
        if (GStorage.collectChanges.isNotEmpty) {
          await _updateBox('collectchanges');
        }
      });
    } catch (e) {
      KazumiLogger().e('WebDav: update collectibles failed', error: e);
      rethrow;
    }
  }

  Future<void> _downloadBox(String boxName) async {
    String fileName = '$boxName.tmp';
    final existingFile = File('${webDavLocalTempDirectory.path}/$fileName');
    if (await existingFile.exists()) {
      await existingFile.delete();
    }
    await client.read2File('$_syncRootPath/$fileName', existingFile.path);
  }

  Future<void> syncCollectibles() async {
    return _runWebDavExclusive(_syncCollectibles);
  }

  Future<void> _syncCollectibles() async {
    await _ensureRemoteDirectory('/kazumiSync');
    await _ensureRemoteDirectory(_syncRootPath);
    List<CollectedBangumi> remoteCollectibles = [];
    List<CollectedBangumiChange> remoteChanges = [];

    final files = await client.readDir(_syncRootPath);
    final collectiblesExists =
        files.any((file) => file.name == 'collectibles.tmp');
    final changesExists =
        files.any((file) => file.name == 'collectchanges.tmp');
    if (!collectiblesExists && !changesExists) {
      await _updateBox('collectibles');
      if (GStorage.collectChanges.isNotEmpty) {
        await _updateBox('collectchanges');
      }
      return;
    }

    List<Future<void>> downloadFutures = [];
    if (collectiblesExists) {
      downloadFutures.add(_downloadBox('collectibles').catchError((e) {
        KazumiLogger().e('WebDav: download collectibles failed', error: e);
        throw Exception('WebDav: download collectibles failed');
      }));
    }
    if (changesExists) {
      downloadFutures.add(_downloadBox('collectchanges').catchError((e) {
        KazumiLogger().e('WebDav: download collectchanges failed', error: e);
        throw Exception('WebDav: download collectchanges failed');
      }));
    }
    if (downloadFutures.isNotEmpty) {
      await Future.wait(downloadFutures);
    }
    try {
      if (collectiblesExists) {
        remoteCollectibles = await GStorage.getCollectiblesFromFile(
            '${webDavLocalTempDirectory.path}/collectibles.tmp');
      }
      if (changesExists) {
        remoteChanges = await GStorage.getCollectChangesFromFile(
            '${webDavLocalTempDirectory.path}/collectchanges.tmp');
      }
    } catch (e) {
      KazumiLogger().e('WebDav: get collectibles failed', error: e);
      throw Exception('WebDav: get collectibles from file failed');
    }
    if (remoteChanges.isNotEmpty || remoteCollectibles.isNotEmpty) {
      await GStorage.patchCollectibles(remoteCollectibles, remoteChanges);
    }
    await _updateBox('collectibles');
    if (GStorage.collectChanges.isNotEmpty) {
      await _updateBox('collectchanges');
    }
  }

  Future<void> _syncHistory() async {
    await _ensureHistoryStorage();
    final historySync = HistorySyncService();
    final documents = WebDavDocumentStore(client);
    var remoteDocument = await documents.read(_historySnapshotPath);
    var remoteSnapshot = _decodeHistorySnapshot(remoteDocument);
    final remoteEvents = await _readRemoteHistoryEvents();

    if (remoteSnapshot.histories.isEmpty &&
        remoteSnapshot.itemVersions.isEmpty &&
        remoteEvents.isEmpty &&
        await _tryImportLegacyHistory()) {
      remoteSnapshot = await historySync
          .withLocalLock(() async => historySync.buildSnapshotFromLocal());
      await documents.commit(_historySnapshotPath,
          utf8.encode(jsonEncode(remoteSnapshot.toJson())), remoteDocument);
      remoteDocument = await documents.read(_historySnapshotPath);
      remoteSnapshot = _decodeHistorySnapshot(remoteDocument);
    }

    final localBatch = await historySync.withLocalLock(() async {
      // Refresh local state after all network awaits; playback may have changed it.
      final localEvents = await historySync.readLocalEvents();
      final localStateEvents = await _eventsFromLocalHistories();
      final merged = HistorySyncMerger.merge(
        snapshot: remoteSnapshot,
        events: [...remoteEvents, ...localStateEvents, ...localEvents],
      );
      await historySync.applySnapshotToLocal(merged);
      return (snapshot: merged, events: localEvents);
    });
    if (localBatch.events.isNotEmpty) {
      await _writeDeviceHistoryChanges(localBatch.events);
    }

    final snapshotInitialized =
        GStorage.getAccountSetting(SettingsKeys.historySyncSnapshotInitialized);
    if (snapshotInitialized != true ||
        await historySync.shouldCompactLocalLog()) {
      await documents.commit(
          _historySnapshotPath,
          utf8.encode(jsonEncode(localBatch.snapshot.toJson())),
          remoteDocument);
      final acknowledged =
          localBatch.events.map((event) => event.eventId).toSet();
      final remaining = await historySync.withLocalLock(() async {
        final current = await historySync.readLocalEvents();
        final pending = current
            .where((event) => !acknowledged.contains(event.eventId))
            .toList();
        await historySync.replaceLocalEvents(pending);
        return pending;
      });
      await _writeDeviceHistoryChanges(remaining);
      await GStorage.putAccountSetting(
        SettingsKeys.historySyncSnapshotInitialized,
        true,
      );
    }
  }

  Future<void> _ensureHistoryStorage() async {
    await _ensureLocalTempDirectory();
    await _ensureRemoteDirectory('/kazumiSync');
    await _ensureRemoteDirectory(_syncRootPath);
    await _ensureRemoteDirectory(_historyRootPath);
    await _ensureRemoteDirectory(_historyChangesPath);
  }

  Future<void> _ensureLocalTempDirectory() async {
    if (!await webDavLocalTempDirectory.exists()) {
      await webDavLocalTempDirectory.create(recursive: true);
    }
  }

  Future<void> _ensureRemoteDirectory(String path) async {
    try {
      await client.mkdir(path);
    } catch (e) {
      if (!await _remoteEntryExists(path)) {
        rethrow;
      }
    }
  }

  Future<bool> _remoteEntryExists(String path) async {
    final normalized = path.endsWith('/') && path.length > 1
        ? path.substring(0, path.length - 1)
        : path;
    final index = normalized.lastIndexOf('/');
    final parent = index <= 0 ? '/' : normalized.substring(0, index);
    final name = normalized.substring(index + 1);
    try {
      final files = await client.readDir(parent);
      return files.any((file) => file.name == name);
    } catch (_) {
      rethrow;
    }
  }

  HistorySyncSnapshot _decodeHistorySnapshot(RemoteDocument document) {
    if (!document.exists) return HistorySyncSnapshot.empty();
    final value = jsonDecode(utf8.decode(document.bytes!));
    if (value is! Map ||
        value['schemaVersion'] != 1 ||
        value['histories'] is! List ||
        value['itemVersions'] is! Map ||
        value['progressVersions'] is! Map ||
        value['deletedVersions'] is! Map) {
      throw const FormatException('Invalid WebDAV history snapshot');
    }
    return HistorySyncSnapshot.fromJson(Map<String, dynamic>.from(value));
  }

  Future<List<HistorySyncEvent>> _readRemoteHistoryEvents() async {
    final events = <HistorySyncEvent>[];
    final files = await client.readDir(_historyChangesPath);
    for (final file in files) {
      final name = file.name ?? '';
      if (!name.endsWith('.jsonl')) continue;
      final content = await _readRemoteText('$_historyChangesPath/$name');
      events.addAll(HistorySyncCodec.eventsFromJsonLines(content));
    }
    return events;
  }

  Future<List<HistorySyncEvent>> _eventsFromLocalHistories() async {
    return HistorySyncService.buildStateEventsFromHistories(
      GStorage.histories.values,
    );
  }

  Future<bool> _tryImportLegacyHistory() async {
    try {
      final fileName = 'histories.tmp';
      final existingFile = File('${webDavLocalTempDirectory.path}/$fileName');
      if (await existingFile.exists()) {
        await existingFile.delete();
      }
      await client.read2File('$_syncRootPath/$fileName', existingFile.path);
      await HistorySyncService()
          .withLocalLock(() => GStorage.patchHistory(existingFile.path));
      KazumiLogger().i('WebDav: imported legacy history backup');
      return true;
    } catch (e) {
      if (await _remoteEntryExists('$_syncRootPath/histories.tmp')) rethrow;
      return false;
    }
  }

  Future<void> _writeDeviceHistoryChanges(
    Iterable<HistorySyncEvent> events,
  ) async {
    final deviceId = await HistorySyncService().getDeviceId();
    final remotePath = '$_historyChangesPath/$deviceId.jsonl';
    final content = HistorySyncCodec.eventsToJsonLines(events);
    if (content.isEmpty) {
      try {
        await client.remove(remotePath);
      } catch (_) {
        if (await _remoteEntryExists(remotePath)) rethrow;
      }
      return;
    }
    await _writeRemoteText(remotePath, content);
  }

  Future<String> _readRemoteText(String remotePath) async {
    final document = await WebDavDocumentStore(client).read(remotePath);
    if (!document.exists) throw StateError('远端历史日志已变化，请重新同步');
    return utf8.decode(document.bytes!);
  }

  Future<void> _writeRemoteText(String remotePath, String content) async {
    final bytes = Uint8List.fromList(utf8.encode(content));
    final response = await client.c.req(
      client,
      'PUT',
      remotePath,
      data: bytes,
      optionsHandler: (options) {
        options.contentType = 'application/octet-stream';
      },
    );
    final statusCode = response.statusCode;
    if (statusCode == 200 || statusCode == 201 || statusCode == 204) {
      return;
    }
    throw Exception('WebDav: PUT $remotePath failed with $statusCode');
  }

  Future<void> ping() async {
    try {
      await client.ping();
    } catch (e) {
      KazumiLogger().e('WebDav: WebDav ping failed', error: e);
      rethrow;
    }
  }
}
