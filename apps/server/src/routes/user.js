/**
 * User routes - favorites and watch history.
 */

function mountUserRoutes(app, deps) {
  const { database, requireAuth } = deps;

  function publicOrigin(req) {
    const proto = req.protocol || 'http';
    return `${proto}://${req.get('host')}`;
  }

  function mapEpisodeComment(row, req) {
    let avatar = row.avatar || '';
    if (avatar && avatar.startsWith('/')) avatar = `${publicOrigin(req)}${avatar}`;
    return {
      id: row.id,
      content: row.deleted_at ? '' : row.content,
      createdAt: row.created_at,
      isDeleted: Boolean(row.deleted_at),
      canDelete: Boolean(!row.deleted_at && req.user &&
        Number(req.user.id) === Number(row.user_id)),
      likeCount: Number(row.like_count) || 0,
      dislikeCount: Number(row.dislike_count) || 0,
      myReaction: Number(row.my_reaction) || 0,
      replyCount: Number(row.reply_count) || 0,
      replies: Array.isArray(row.replies)
        ? row.replies.map(reply => mapEpisodeComment(reply, req))
        : [],
      user: {
        id: row.user_id || 0,
        username: row.username || 'AniWorld用户',
        nickname: row.username || 'AniWorld用户',
        sign: '',
        joinedAt: 0,
        avatar: {
          large: avatar,
          medium: avatar,
          small: avatar
        }
      }
    };
  }

  function mapEpisodeCommentNotification(row, req) {
    let avatar = row.actor_avatar || '';
    if (avatar && avatar.startsWith('/')) avatar = `${publicOrigin(req)}${avatar}`;
    return {
      id: row.id,
      type: row.type,
      createdAt: row.created_at,
      readAt: row.read_at,
      isRead: Boolean(row.read_at),
      commentId: row.target_comment_id,
      eventCommentId: row.comment_id,
      animeId: row.anime_id,
      animeTitle: row.anime_title || '',
      episodeNumber: row.episode_number || '',
      targetContent: row.target_content || '',
      eventContent: row.event_content || '',
      actor: {
        id: row.actor_id || 0,
        username: row.actor_username || 'AniWorld用户',
        nickname: row.actor_username || 'AniWorld用户',
        sign: '',
        joinedAt: 0,
        avatar: {
          large: avatar,
          medium: avatar,
          small: avatar
        }
      }
    };
  }

  // GET /api/user/favorites
  app.get('/api/user/favorites', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const favorites = database.getFavorites(req.user.id);
    res.json({ results: favorites, total: favorites.length });
  });

  // POST /api/user/favorites
  app.post('/api/user/favorites', requireAuth, (req, res) => {
    const { anilist_id, anime_id, anime_title, anime_image, anime_msg, anime_n, oi_index } = req.body;
    if (!anime_id || !anime_title) {
      return res.status(400).json({ error: '缺少动漫信息' });
    }
    const result = database.addFavorite(req.user.id, {
      anilist_id, anime_id, anime_title, anime_image, anime_msg, anime_n, oi_index
    });
    if (result.already) return res.json({ success: true, message: '已经追番了' });
    if (result.error) return res.status(500).json({ error: result.error });
    res.json({ success: true, message: '追番成功' });
  });

  // DELETE /api/user/favorites/clear
  app.delete('/api/user/favorites/clear', requireAuth, (req, res) => {
    try {
      const result = database.clearFavorites(req.user.id);
      if (result && result.success) {
        res.json({ success: true, message: '追番列表已清空' });
      } else {
        res.status(500).json({ success: false, error: result?.error || '清空失败' });
      }
    } catch (e) {
      console.error('[favorites/clear]', e.message, e.stack);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/user/favorites/:animeId
  app.delete('/api/user/favorites/:animeId', requireAuth, (req, res) => {
    const animeId = req.params.animeId;
    const result = database.removeFavorite(req.user.id, animeId);
    if (result.error) return res.status(500).json({ error: result.error });
    res.json({ success: true, message: '取消追番' });
  });

  // GET /api/user/favorites/check/:animeId
  app.get('/api/user/favorites/check/:animeId', requireAuth, (req, res) => {
    const animeId = req.params.animeId;
    const favorited = database.isFavorited(req.user.id, animeId);
    res.json({ favorited });
  });

  // GET /api/user/history
  app.get('/api/user/history', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const limit = parseInt(req.query.limit) || 50;
    const history = database.getHistory(req.user.id, limit);
    res.json({ results: history, total: history.length });
  });

  // POST /api/user/history
  app.post('/api/user/history', requireAuth, (req, res) => {
    const { anilist_id, anime_id, anime_title, anime_image, anime_msg, anime_n, episode_number, episode_title, progress, position_seconds, duration_seconds, video_url } = req.body;
    if (!anime_id || !anime_title) {
      return res.status(400).json({ error: '缺少动漫信息' });
    }
    const result = database.saveHistory(req.user.id, {
      anilist_id, anime_id, anime_title, anime_image, anime_msg, anime_n,
      episode_number: episode_number || '',
      episode_title: episode_title || '',
      progress: progress || 0, position_seconds, duration_seconds,
      video_url: video_url || ''
    });
    if (result.error) return res.status(500).json({ error: result.error });
    res.json({ success: true });
  });

  // GET /api/user/history/progress/:animeId
  app.get('/api/user/history/progress/:animeId', requireAuth, (req, res) => {
    const animeId = req.params.animeId;
    const progress = database.getHistoryProgress(req.user.id, animeId);
    res.json(progress || { episode_number: null, progress: 0 });
  });

  // DELETE /api/user/history/clear
  app.delete('/api/user/history/clear', requireAuth, (req, res) => {
    try {
      const result = database.clearHistory(req.user.id);
      if (result && result.success) {
        res.json({ success: true, message: '观看历史已清空' });
      } else {
        res.status(500).json({ success: false, error: result?.error || '清空失败' });
      }
    } catch (e) {
      console.error('[history/clear]', e.message, e.stack);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/user/history/:animeId
  app.delete('/api/user/history/:animeId', requireAuth, (req, res) => {
    const animeId = req.params.animeId;
    const result = database.removeHistory(req.user.id, animeId);
    if (result.error) return res.status(500).json({ success: false, error: result.error });
    res.json({ success: true, message: 'history_deleted' });
  });

  // GET /api/comments/episode?anime_id=xxx&episode_number=1
  app.get('/api/comments/episode', (req, res) => {
    const animeId = String(req.query.anime_id || '').trim();
    const episodeNumber = String(req.query.episode_number || '').trim();
    if (!animeId || !episodeNumber) {
      return res.json({ results: [], total: 0 });
    }
    const rows = database.getEpisodeComments(
      animeId,
      episodeNumber,
      req.query.limit || 80,
      req.user?.id || null
    );
    const results = rows.map(row => mapEpisodeComment(row, req));
    res.json({ results, total: results.length });
  });

  // POST /api/comments/episode
  app.post('/api/comments/episode', requireAuth, (req, res) => {
    const { anime_id, anime_title, episode_number, content, parent_id } = req.body || {};
    const trimmed = String(content || '').trim();
    if (!anime_id || !episode_number || !trimmed) {
      return res.status(400).json({ error: '评论内容不能为空' });
    }
    if (trimmed.length > 1000) {
      return res.status(400).json({ error: '评论太长了，最多 1000 字' });
    }
    const result = database.addEpisodeComment(req.user.id, {
      anime_id,
      anime_title,
      episode_number,
      content: trimmed,
      parent_id
    });
    if (result.error) {
      const badRequest = new Set([
        'invalid_parent',
        'parent_not_found',
        'parent_mismatch',
        'parent_deleted'
      ]);
      return res.status(badRequest.has(result.error) ? 400 : 500)
        .json({ error: result.error });
    }
    res.json({ success: true, message: '评论已发布' });
  });

  // GET /api/comments/episode/:commentId/replies?page=1&limit=10
  app.get('/api/comments/episode/:commentId/replies', (req, res) => {
    const result = database.getEpisodeCommentReplies(
      Number(req.params.commentId),
      req.query.page || 1,
      req.query.limit || 10,
      req.user?.id || null
    );
    if (result.error) {
      return res.status(result.error === 'comment_not_found' ? 404 : 500)
        .json({ error: result.error });
    }
    const results = result.results.map(row => mapEpisodeComment(row, req));
    res.json({
      results,
      page: result.page,
      total: result.total,
      totalPages: result.total_pages
    });
  });

  // POST /api/comments/episode/:commentId/reaction
  // reaction: 1 = like, -1 = dislike, 0 = clear current reaction
  app.post('/api/comments/episode/:commentId/reaction', requireAuth, (req, res) => {
    const commentId = Number(req.params.commentId);
    const reaction = Number(req.body?.reaction);
    const result = database.setEpisodeCommentReaction(
      req.user.id,
      commentId,
      reaction
    );
    if (result.error) {
      const status = result.error === 'comment_not_found' ? 404
        : result.error === 'comment_deleted' ? 410
          : 400;
      return res.status(status).json({ error: result.error });
    }
    res.json(result);
  });

  // DELETE /api/comments/episode/:commentId
  // Soft-delete the comment. Only the comment author may delete it.
  app.delete('/api/comments/episode/:commentId', requireAuth, (req, res) => {
    const result = database.deleteEpisodeComment(
      req.user.id,
      Number(req.params.commentId)
    );
    if (result.error) {
      const status = result.error === 'comment_not_found' ? 404
        : result.error === 'comment_forbidden' ? 403
          : 400;
      return res.status(status).json({ error: result.error });
    }
    res.json({ ...result, message: '评论已删除' });
  });

  // GET /api/comments/notifications?type=all|like|reply
  app.get('/api/comments/notifications', requireAuth, (req, res) => {
    const type = String(req.query.type || 'all').toLowerCase();
    const result = database.getEpisodeCommentNotifications(
      req.user.id,
      type,
      req.query.limit || 100
    );
    const results = result.results.map(row => mapEpisodeCommentNotification(row, req));
    res.json({
      results,
      total: results.length,
      unreadCount: result.unreadCount
    });
  });

  // POST /api/comments/notifications/read
  app.post('/api/comments/notifications/read', requireAuth, (req, res) => {
    const type = String(req.body?.type || 'all').toLowerCase();
    const result = database.markEpisodeCommentNotificationsRead(req.user.id, type);
    if (result.error) return res.status(500).json({ error: result.error });
    res.json(result);
  });
}

module.exports = { mountUserRoutes };
