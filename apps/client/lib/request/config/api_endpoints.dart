class ApiEndpoints {
  static const String version = String.fromEnvironment(
    'APP_VERSION',
    defaultValue: '2.1.10',
  );

  static const int apiLevel = 7;

  static const String defaultSelfBackend = String.fromEnvironment(
    'ANIWORLD_SERVER_URL',
    defaultValue: 'http://127.0.0.1:3000',
  );
  static String _selfBackend = defaultSelfBackend;

  static String get selfBackend => _selfBackend;

  static void configureServer(String address) {
    final value = address.trim();
    _selfBackend = value.isEmpty
        ? defaultSelfBackend
        : value.replaceFirst(RegExp(r'/+$'), '');
  }

  static const String projectUrl = 'https://github.com/Yuuki-Asuna233/AniWorld';
  static const String sourceUrl = projectUrl;
  static const String iconUrl = '$sourceUrl/tree/main/apps/web/assets/app';
  static const String pluginShop =
      'https://raw.githubusercontent.com/Predidit/KazumiRules/main/';
  static const String latestApp =
      'https://api.github.com/repos/Yuuki-Asuna233/AniWorld/releases/latest';
  static const String gitMirror = 'https://ghfast.top/';

  static String get bangumiMirrorDomain => selfBackend;
  static String get latestAppMirror =>
      '$bangumiMirrorDomain/kazumi/v1/app/latest';

  static const String dandanIndex = 'https://www.dandanplay.com/';
  static const String bangumiIndex = 'https://bangumi.tv/';
  static const String telegramGroup = 'https://t.me/kazumi_app';

  static String get bangumiAPIDomain => '$selfBackend/kazumi';
  // The local compatibility backend has no Bangumi OAuth/collection adapter.
  static const bool bangumiAccountSyncAvailable = false;

  static String get bangumiAuthAPIMirrorDomain => '$selfBackend/kazumi';
  static String get bangumiAPINextDomain => '$selfBackend/kazumi';

  static const String bangumiInfoByID = '/v0/subjects/{0}';
  static const String bangumiRankSearch =
      '/v0/search/subjects?limit={0}&offset={1}';
  static const String bangumiCharacterByID = '/v0/subjects/{0}/characters';
  static const String bangumiEpisodeByID = '/v0/episodes';
  static const String bangumiUsernameByToken = '/v0/me';
  static const String bangumiSetCollection = '/v0/users/-/collections/{0}';
  static const String bangumiGetCollection =
      '/v0/users/{0}/collections?subject_type=2&limit={1}&offset={2}&type={3}';

  static const String bangumiCalendar = '/p1/calendar';
  static const String bangumiTrendsNext = '/p1/trending/subjects';
  static const String bangumiMirrorPopularSubjects =
      '/kazumi/v1/popular/subjects';
  static const String bangumiMirrorSeasonCalendar =
      '/kazumi/v1/calendar/season';
  static const String bangumiInfoByIDNext = '/p1/subjects/{0}';
  static const String bangumiCommentsByIDNext =
      '/p1/subjects/{0}/comments?limit={1}&offset={2}';
  static const String bangumiEpisodeCommentsByIDNext =
      '/p1/episodes/{0}/comments';
  static const String bangumiCharacterInfoByCharacterIDNext =
      '/p1/characters/{0}';
  static const String bangumiCharacterCommentsByIDNext =
      '/p1/characters/{0}/comments';
  static const String bangumiStaffByIDNext = '/p1/subjects/{0}/staffs/persons';

  static const String dandanAPIDomain = 'https://api.dandanplay.net';
  static const String dandanAPIComment = '/api/v2/comment/';
  static const String dandanAPISearch = '/api/v2/search/anime';
  static const String dandanAPIInfo = '/api/v2/bangumi/';
  static const String dandanAPIInfoByBgmBangumiId = '/api/v2/bangumi/bgmtv/{0}';
  static const String traceApi = 'https://api.trace.moe/search';

  static String formatUrl(String url, List<dynamic> params) {
    for (var index = 0; index < params.length; index++) {
      url = url.replaceAll('{$index}', params[index].toString());
    }
    return url;
  }
}
