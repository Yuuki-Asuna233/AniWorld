class CharacterFullItem {
  final int id;
  final String name;
  final String nameCN;
  final String info;
  final String summary;
  final String image;

  CharacterFullItem({
    required this.id,
    required this.name,
    required this.nameCN,
    required this.info,
    required this.summary,
    required this.image,
  });

  factory CharacterFullItem.fromJson(Map<String, dynamic> json) {
    final rawImages = json['images'];
    final images = rawImages is Map ? Map<String, dynamic>.from(rawImages) : const <String, dynamic>{};
    final rawInfobox = json['infobox'];
    final infobox = rawInfobox is List ? rawInfobox : const [];
    final infoboxText = infobox.whereType<Map>().map((item) {
      final key = '${item['key'] ?? ''}'.trim();
      final value = '${item['value'] ?? ''}'.trim();
      if (key.isEmpty) return value;
      if (value.isEmpty) return key;
      return '$key：$value';
    }).where((item) => item.isNotEmpty).join('\n');
    final rawInfo = '${json['info'] ?? ''}'.trim().isNotEmpty
        ? json['info']
        : infoboxText;
    final rawSummary = json['summary'] ?? '';
    return CharacterFullItem(
      id: int.tryParse('${json['id'] ?? 0}') ?? 0,
      name: '${json['name'] ?? ''}',
      nameCN: '${json['nameCN'] ?? json['name_cn'] ?? ''}',
      info: '$rawInfo',
      summary: '$rawSummary',
      image: '${images['large'] ?? images['medium'] ?? json['image'] ?? ''}',
    );
  }

  factory CharacterFullItem.fromTemplate() {
    return CharacterFullItem(
      id: 0,
      name: '',
      nameCN: '',
      info: '',
      summary: '',
      image: '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'nameCN': nameCN,
      'info': info,
      'summary': summary,
    };
  }
}
