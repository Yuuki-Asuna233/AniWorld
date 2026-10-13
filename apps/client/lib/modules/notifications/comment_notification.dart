import 'package:kazumi/modules/comments/comment_item.dart';

class CommentNotification {
  const CommentNotification({
    required this.id,
    required this.type,
    required this.actor,
    required this.createdAt,
    required this.commentId,
    required this.eventCommentId,
    required this.animeId,
    required this.animeTitle,
    required this.episodeNumber,
    required this.targetContent,
    required this.eventContent,
    required this.isRead,
  });

  final int id;
  final String type;
  final User actor;
  final int createdAt;
  final int commentId;
  final int eventCommentId;
  final String animeId;
  final String animeTitle;
  final String episodeNumber;
  final String targetContent;
  final String eventContent;
  final bool isRead;

  bool get isLike => type == 'like';

  CommentNotification copyWith({bool? isRead}) {
    return CommentNotification(
      id: id,
      type: type,
      actor: actor,
      createdAt: createdAt,
      commentId: commentId,
      eventCommentId: eventCommentId,
      animeId: animeId,
      animeTitle: animeTitle,
      episodeNumber: episodeNumber,
      targetContent: targetContent,
      eventContent: eventContent,
      isRead: isRead ?? this.isRead,
    );
  }

  factory CommentNotification.fromJson(Map<String, dynamic> json) {
    return CommentNotification(
      id: _asInt(json['id']),
      type: '${json['type'] ?? ''}',
      actor: User.fromJson(
        Map<String, dynamic>.from(json['actor'] as Map? ?? const {}),
      ),
      createdAt: _asInt(json['createdAt']),
      commentId: _asInt(json['commentId']),
      eventCommentId: _asInt(json['eventCommentId']),
      animeId: '${json['animeId'] ?? ''}',
      animeTitle: '${json['animeTitle'] ?? ''}',
      episodeNumber: '${json['episodeNumber'] ?? ''}',
      targetContent: '${json['targetContent'] ?? ''}',
      eventContent: '${json['eventContent'] ?? ''}',
      isRead: json['isRead'] == true,
    );
  }

  static int _asInt(dynamic value) {
    return value is num ? value.toInt() : int.tryParse('$value') ?? 0;
  }
}

class CommentNotificationResult {
  const CommentNotificationResult({
    required this.notifications,
    required this.unreadCount,
  });

  final List<CommentNotification> notifications;
  final int unreadCount;
}
