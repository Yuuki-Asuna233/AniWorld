import 'package:kazumi/modules/bangumi/bangumi_item.dart';

String searchResultIdentity(BangumiItem item) {
  return (item.nameCn.isNotEmpty ? item.nameCn : item.name)
      .toLowerCase()
      .replaceAll(RegExp(r'\s+'), '')
      .replaceAll('：', ':');
}

List<BangumiItem> deduplicateSearchResults(List<BangumiItem> items) {
  final seen = <String>{};
  return items.where((item) {
    final identity = searchResultIdentity(item);
    return identity.isNotEmpty && seen.add(identity);
  }).toList();
}
