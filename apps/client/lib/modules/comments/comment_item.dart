class UserAvatar {
  final String small;
  final String medium;
  final String large;

  UserAvatar({
    required this.small,
    required this.medium,
    required this.large,
  });

  factory UserAvatar.fromJson(Map<String, dynamic> json) {
    return UserAvatar(
      small: json['small'] ?? '',
      medium: json['medium'] ?? '',
      large: json['large'] ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'small': small,
      'medium': medium,
      'large': large,
    };
  }
}

class User {
  final int id;
  final String username;
  final String nickname;
  final UserAvatar avatar;
  final String sign;
  final int joinedAt;

  User({
    required this.id,
    required this.username,
    required this.nickname,
    required this.avatar,
    required this.sign,
    required this.joinedAt,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'] ?? 0,
      username: json['username'] ?? '',
      nickname: json['nickname'] ?? '',
      avatar: UserAvatar.fromJson(json['avatar'] as Map<String, dynamic>),
      sign: json['sign'] ?? '',
      joinedAt: json['joinedAt'] ?? 0,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'username': username,
      'nickname': nickname,
      'avatar': avatar.toJson(),
      'sign': sign,
      'joinedAt': joinedAt,
    };
  }
}

class Comment {
  final int rate;
  final String comment;
  final int updatedAt;

  Comment({
    required this.rate,
    required this.comment,
    required this.updatedAt,
  });

  factory Comment.fromJson(Map<String, dynamic> json) {
    return Comment(
      rate: json['rate'] ?? 0,
      comment: json['comment'] ?? '',
      updatedAt: json['updatedAt'] ?? 0,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'rate': rate,
      'comment': comment,
      'updatedAt': updatedAt,
    };
  }
}

class CommentItem {
  final User user;
  final Comment comment;

  CommentItem({
    required this.user,
    required this.comment,
  });

  factory CommentItem.fromJson(Map<String, dynamic> json) {
    return CommentItem(
      user: User.fromJson(json['user']),
      comment: Comment.fromJson(json),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'user': user.toJson(),
      'comment': comment.toJson(),
    };
  }
}

class EpisodeComment {
  final int id;
  final User user;
  final String comment;
  final int createdAt;
  final int likeCount;
  final int dislikeCount;
  final int myReaction;
  final bool isDeleted;
  final bool canDelete;

  EpisodeComment({
    required this.id,
    required this.user,
    required this.comment,
    required this.createdAt,
    this.likeCount = 0,
    this.dislikeCount = 0,
    this.myReaction = 0,
    this.isDeleted = false,
    this.canDelete = false,
  });

  factory EpisodeComment.fromJson(Map<String, dynamic> json) {
    return EpisodeComment(
      id: json['id'] is num ? (json['id'] as num).toInt() : 0,
      user: User.fromJson(json['user']),
      comment: json['content'] ?? '',
      createdAt: json['createdAt'] ?? 0,
      likeCount: json['likeCount'] is num
          ? (json['likeCount'] as num).toInt()
          : 0,
      dislikeCount: json['dislikeCount'] is num
          ? (json['dislikeCount'] as num).toInt()
          : 0,
      myReaction: json['myReaction'] is num
          ? (json['myReaction'] as num).toInt()
          : 0,
      isDeleted: json['isDeleted'] == true,
      canDelete: json['canDelete'] == true,
    );
  }

  EpisodeComment copyWith({
    String? comment,
    int? likeCount,
    int? dislikeCount,
    int? myReaction,
    bool? isDeleted,
    bool? canDelete,
  }) {
    return EpisodeComment(
      id: id,
      user: user,
      comment: comment ?? this.comment,
      createdAt: createdAt,
      likeCount: likeCount ?? this.likeCount,
      dislikeCount: dislikeCount ?? this.dislikeCount,
      myReaction: myReaction ?? this.myReaction,
      isDeleted: isDeleted ?? this.isDeleted,
      canDelete: canDelete ?? this.canDelete,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'user': user.toJson(),
      'content': comment,
      'createdAt': createdAt,
      'likeCount': likeCount,
      'dislikeCount': dislikeCount,
      'myReaction': myReaction,
      'isDeleted': isDeleted,
      'canDelete': canDelete,
    };
  }
}

class EpisodeCommentItem {
  final EpisodeComment comment;
  final List<EpisodeComment> replies;
  final int replyCount;

  EpisodeCommentItem({
    required this.comment,
    required this.replies,
    this.replyCount = 0,
  });

  factory EpisodeCommentItem.fromJson(Map<String, dynamic> json) {
    final list = json['replies'] is List ? json['replies'] as List : const [];
    List<EpisodeComment> tempList =
        list.map((i) => EpisodeComment.fromJson(i)).toList();
    return EpisodeCommentItem(
      comment: EpisodeComment.fromJson(json),
      replies: tempList,
      replyCount: json['replyCount'] is num
          ? (json['replyCount'] as num).toInt()
          : tempList.length,
    );
  }

  EpisodeCommentItem copyWith({
    EpisodeComment? comment,
    List<EpisodeComment>? replies,
    int? replyCount,
  }) {
    return EpisodeCommentItem(
      comment: comment ?? this.comment,
      replies: replies ?? this.replies,
      replyCount: replyCount ?? this.replyCount,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'comment': comment.toJson(),
      'list': replies,
      'replyCount': replyCount,
    };
  }
}

class EpisodeCommentRepliesPage {
  const EpisodeCommentRepliesPage({
    required this.replies,
    required this.page,
    required this.total,
    required this.totalPages,
  });

  final List<EpisodeComment> replies;
  final int page;
  final int total;
  final int totalPages;
}

class CharacterComment {
  final User user;
  final String comment;
  final int createdAt;

  CharacterComment({
    required this.user,
    required this.comment,
    required this.createdAt,
  });

  factory CharacterComment.fromJson(Map<String, dynamic> json) {
    return CharacterComment(
      user: User.fromJson(json['user']),
      comment: json['content'] ?? '',
      createdAt: json['createdAt'] ?? 0,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'user': user.toJson(),
      'content': comment,
      'createdAt': createdAt,
    };
  }
}

class CharacterCommentItem {
  final CharacterComment comment;
  final List<CharacterComment> replies;

  CharacterCommentItem({required this.comment, required this.replies});

  factory CharacterCommentItem.fromJson(Map<String, dynamic> json) {
    var list = json['replies'] as List;
    List<CharacterComment> tempList =
        list.map((i) => CharacterComment.fromJson(i)).toList();
    return CharacterCommentItem(
        comment: CharacterComment.fromJson(json), replies: tempList);
  }

  Map<String, dynamic> toJson() {
    return {
      'comment': comment.toJson(),
      'list': replies,
    };
  }
}
