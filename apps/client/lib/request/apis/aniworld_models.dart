class AniWorldUser {
  const AniWorldUser({
    required this.id,
    required this.email,
    required this.username,
    required this.avatar,
    this.createdAt = 0,
  });

  final int id;
  final String email;
  final String username;
  final String avatar;
  final int createdAt;

  factory AniWorldUser.fromJson(Map<String, dynamic> json) {
    return AniWorldUser(
      id: int.tryParse('${json['id'] ?? 0}') ?? 0,
      email: '${json['email'] ?? ''}',
      username: '${json['username'] ?? ''}',
      avatar: '${json['avatar'] ?? ''}',
      createdAt: int.tryParse(
            '${json['createdAt'] ?? json['created_at'] ?? 0}',
          ) ??
          0,
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'email': email,
        'username': username,
        'avatar': avatar,
        'createdAt': createdAt,
      };
}

class AniWorldAuthResult {
  const AniWorldAuthResult({
    required this.success,
    required this.message,
    this.user,
  });

  final bool success;
  final String message;
  final AniWorldUser? user;
}

class AniWorldAgentSession {
  const AniWorldAgentSession({
    required this.id,
    required this.title,
    required this.updatedAt,
  });

  final String id;
  final String title;
  final int updatedAt;

  factory AniWorldAgentSession.fromJson(Map<String, dynamic> json) {
    return AniWorldAgentSession(
      id: '${json['id'] ?? ''}',
      title: '${json['title'] ?? '新对话'}',
      updatedAt:
          int.tryParse('${json['updated_at'] ?? json['updatedAt'] ?? 0}') ?? 0,
    );
  }
}

class AniWorldAgentMessage {
  const AniWorldAgentMessage({
    required this.role,
    required this.content,
    required this.createdAt,
    this.cards = const [],
  });

  final String role;
  final String content;
  final int createdAt;
  final List<AniWorldAgentCard> cards;

  factory AniWorldAgentMessage.fromJson(Map<String, dynamic> json) {
    return AniWorldAgentMessage(
      role: '${json['role'] ?? ''}',
      content: '${json['content'] ?? ''}',
      createdAt:
          int.tryParse('${json['createdAt'] ?? json['created_at'] ?? 0}') ?? 0,
      cards: (json['cards'] is List ? json['cards'] as List : const [])
          .whereType<Map>()
          .map(
            (item) =>
                AniWorldAgentCard.fromJson(Map<String, dynamic>.from(item)),
          )
          .toList(),
    );
  }
}

class AniWorldAgentCard {
  const AniWorldAgentCard({
    required this.anilistId,
    required this.title,
    required this.image,
    required this.score,
    required this.year,
    required this.status,
    required this.reason,
    required this.href,
  });

  final int anilistId;
  final String title;
  final String image;
  final double score;
  final String year;
  final String status;
  final String reason;
  final String href;

  factory AniWorldAgentCard.fromJson(Map<String, dynamic> json) {
    return AniWorldAgentCard(
      anilistId: int.tryParse('${json['anilistId'] ?? 0}') ?? 0,
      title: '${json['title'] ?? ''}',
      image: '${json['image'] ?? ''}',
      score: double.tryParse('${json['score'] ?? 0}') ?? 0,
      year: '${json['year'] ?? ''}',
      status: '${json['status'] ?? ''}',
      reason: '${json['reason'] ?? ''}',
      href: '${json['href'] ?? ''}',
    );
  }
}

class AniWorldAgentChatResult {
  const AniWorldAgentChatResult({
    required this.answer,
    required this.sessionId,
    this.cards = const [],
    this.suggestions = const [],
    this.actions = const [],
    this.plan = const [],
  });

  final String answer;
  final String sessionId;
  final List<AniWorldAgentCard> cards;
  final List<String> suggestions;
  final List<Map<String, dynamic>> actions;
  final List<String> plan;
}
