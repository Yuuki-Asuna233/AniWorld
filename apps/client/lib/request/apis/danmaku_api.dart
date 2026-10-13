import 'package:kazumi/request/config/api_endpoints.dart';
import 'package:kazumi/request/clients/danmaku_client.dart';
import 'package:kazumi/services/logging/logger.dart';
import 'package:kazumi/modules/danmaku/danmaku_module.dart';
import 'package:kazumi/modules/danmaku/danmaku_search_response.dart';
import 'package:kazumi/modules/danmaku/danmaku_episode_response.dart';
import 'package:kazumi/utils/string_similarity.dart';

String normalizeDanmakuTitle(String value) {
  return value
      .toLowerCase()
      .replaceAll('：', ':')
      .replaceAll(RegExp(r'[\s　]+'), '')
      .replaceAll(RegExp(r'[【】「」『』《》（）()\[\]，。！？、；;,.!?·・~～—–_-]'), '');
}

int extractDanmakuSeason(String value) {
  final normalized = value.replaceAll('：', ':');
  final chinese =
      RegExp(r'第\s*([一二三四五六七八九十\d]+)\s*[季期]').firstMatch(normalized);
  if (chinese != null) {
    const numbers = <String, int>{
      '一': 1,
      '二': 2,
      '三': 3,
      '四': 4,
      '五': 5,
      '六': 6,
      '七': 7,
      '八': 8,
      '九': 9,
      '十': 10,
      '十一': 11,
      '十二': 12,
    };
    return int.tryParse(chinese.group(1) ?? '') ??
        numbers[chinese.group(1)] ??
        0;
  }
  final seasonFirst = RegExp(r'\bseason\s*(\d+)\b', caseSensitive: false)
      .firstMatch(normalized);
  if (seasonFirst != null) return int.parse(seasonFirst.group(1)!);
  final seasonLast = RegExp(
    r'\b(\d+)(?:st|nd|rd|th)?\s*season\b',
    caseSensitive: false,
  ).firstMatch(normalized);
  return int.tryParse(seasonLast?.group(1) ?? '') ?? 0;
}

String danmakuFranchiseBase(String value) {
  return normalizeDanmakuTitle(
    value
        .replaceAll(
          RegExp(r'\s*第\s*[一二三四五六七八九十\d]+\s*[季期].*$'),
          '',
        )
        .replaceAll(
          RegExp(
            r'\s*(?:season\s*\d+|\d+(?:st|nd|rd|th)?\s*season).*$',
            caseSensitive: false,
          ),
          '',
        )
        .replaceAll(
          RegExp(r'\s*part\s*[.\-]?\s*\d+.*$', caseSensitive: false),
          '',
        ),
  );
}

DanmakuAnime? selectDanmakuAnime(
  String requestedTitle,
  List<DanmakuAnime> candidates,
) {
  final requested = normalizeDanmakuTitle(requestedTitle);
  final requestedBase = danmakuFranchiseBase(requestedTitle);
  final requestedSeason = extractDanmakuSeason(requestedTitle);
  DanmakuAnime? best;
  double bestScore = 0;

  for (final anime in candidates) {
    if (anime.animeId < 2) continue;
    final candidate = normalizeDanmakuTitle(anime.animeTitle);
    final candidateBase = danmakuFranchiseBase(anime.animeTitle);
    final candidateSeason = extractDanmakuSeason(anime.animeTitle);
    if (requestedSeason > 0 &&
        candidateSeason > 0 &&
        requestedSeason != candidateSeason) {
      continue;
    }
    if (requestedSeason == 0 && candidateSeason > 1) continue;
    if (candidateSeason == 0 && requestedSeason > 1) continue;

    if (candidate == requested) return anime;
    final sameBase = requestedBase.isNotEmpty &&
        candidateBase.isNotEmpty &&
        (requestedBase == candidateBase ||
            (requestedBase.length >= 6 &&
                candidateBase.length >= 6 &&
                (requestedBase.contains(candidateBase) ||
                    candidateBase.contains(requestedBase))));
    final similarity = calculateSimilarity(candidate, requested);
    if (!sameBase && similarity < 0.72) continue;

    var score = similarity;
    if (sameBase) score += 0.7;
    if (requestedSeason > 0 && candidateSeason == requestedSeason) {
      score += 0.2;
    }
    if (score > bestScore) {
      best = anime;
      bestScore = score;
    }
  }
  return bestScore >= 0.72 ? best : null;
}

int selectDanmakuEpisodeId(
  DanmakuEpisodeResponse response,
  int episode,
) {
  if (episode <= 0 || response.episodes.isEmpty) return 0;
  final episodePatterns = <RegExp>[
    RegExp(r'第\s*(\d+(?:\.\d+)?)\s*(?:话|話|集)', caseSensitive: false),
    RegExp(
      r'\b(?:episode|ep)\s*[.\-]?\s*(\d+(?:\.\d+)?)\b',
      caseSensitive: false,
    ),
    RegExp(
      r'^\s*(\d+(?:\.\d+)?)\s*(?:话|話|集)?\b',
      caseSensitive: false,
    ),
  ];
  for (final item in response.episodes) {
    for (final pattern in episodePatterns) {
      final match = pattern.firstMatch(item.episodeTitle);
      final number = double.tryParse(match?.group(1) ?? '');
      if (number != null && number == episode.toDouble()) {
        return item.episodeId;
      }
    }
  }
  final index = episode - 1;
  return index >= 0 && index < response.episodes.length
      ? response.episodes[index].episodeId
      : 0;
}

class DanmakuApi {
  static final DanmakuClient _client = DanmakuClient.instance;

  // 从BgmBangumiID获取DanDanBangumiID
  static Future<int> getDanDanBangumiIDByBgmBangumiID(int bgmBangumiID) async {
    var path = ApiEndpoints.formatUrl(
        ApiEndpoints.dandanAPIInfoByBgmBangumiId, [bgmBangumiID]);
    var endPoint = ApiEndpoints.dandanAPIDomain + path;
    final jsonData = await _client.get(endPoint);
    DanmakuEpisodeResponse danmakuEpisodeResponse =
        DanmakuEpisodeResponse.fromJson(jsonData);
    return danmakuEpisodeResponse.bangumiId;
  }

  // 从标题获取DanDanBangumiID
  static Future<int> getBangumiIDByTitle(String title) async {
    DanmakuSearchResponse danmakuSearchResponse =
        await getDanmakuSearchResponse(title);

    final best = selectDanmakuAnime(title, danmakuSearchResponse.animes);
    if (best == null) {
      KazumiLogger().w('Danmaku: no safe title match for $title');
      return 0;
    }
    KazumiLogger().i(
      'Danmaku: matched $title -> ${best.animeTitle} (${best.animeId})',
    );
    return best.animeId;
  }

  // 从BangumiID获取分集ID
  static Future<DanmakuEpisodeResponse> getDanmakuEpisodesByBangumiID(
      int bangumiID) async {
    var path = ApiEndpoints.formatUrl(
        ApiEndpoints.dandanAPIInfoByBgmBangumiId, [bangumiID]);
    var endPoint = ApiEndpoints.dandanAPIDomain + path;
    final jsonData = await _client.get(endPoint);
    DanmakuEpisodeResponse danmakuEpisodeResponse =
        DanmakuEpisodeResponse.fromJson(jsonData);
    return danmakuEpisodeResponse;
  }

  // 从DanDanBangumiID获取分集ID
  static Future<DanmakuEpisodeResponse> getDanDanEpisodesByDanDanBangumiID(
      int bangumiID) async {
    var path = ApiEndpoints.dandanAPIInfo + bangumiID.toString();
    var endPoint = ApiEndpoints.dandanAPIDomain + path;
    final jsonData = await _client.get(endPoint);
    DanmakuEpisodeResponse danmakuEpisodeResponse =
        DanmakuEpisodeResponse.fromJson(jsonData);
    return danmakuEpisodeResponse;
  }

  // 从标题检索DanDan番剧数据库
  static Future<DanmakuSearchResponse> getDanmakuSearchResponse(
      String title) async {
    var path = ApiEndpoints.dandanAPISearch;
    var endPoint = ApiEndpoints.dandanAPIDomain + path;
    Map<String, String> keywordMap = {
      'keyword': title,
    };

    final jsonData = await _client.get(endPoint, queryParameters: keywordMap);
    DanmakuSearchResponse danmakuSearchResponse =
        DanmakuSearchResponse.fromJson(jsonData);
    return danmakuSearchResponse;
  }

  static Future<List<DanmakuEntry>> getDanDanmaku(
      int bangumiID, int episode) async {
    List<DanmakuEntry> danmakus = [];
    if (bangumiID == 0) {
      return danmakus;
    }
    final episodeResponse = await getDanDanEpisodesByDanDanBangumiID(bangumiID);
    final episodeId = selectDanmakuEpisodeId(episodeResponse, episode);
    if (episodeId <= 0) {
      KazumiLogger().w(
        'Danmaku: episode $episode is unavailable for anime $bangumiID',
      );
      return danmakus;
    }
    return getDanDanmakuByEpisodeID(episodeId);
  }

  static Future<List<DanmakuEntry>> getDanDanmakuByEpisodeID(
      int episodeID) async {
    var path = ApiEndpoints.dandanAPIComment + episodeID.toString();
    var endPoint = ApiEndpoints.dandanAPIDomain + path;
    List<DanmakuEntry> danmakus = [];
    Map<String, String> withRelated = {
      'withRelated': 'true',
    };
    final jsonData = await _client.get(endPoint, queryParameters: withRelated);
    List<dynamic> comments = jsonData['comments'];

    for (var comment in comments) {
      DanmakuEntry danmaku = DanmakuEntry.fromJson(comment);
      danmakus.add(danmaku);
    }
    return danmakus;
  }
}
