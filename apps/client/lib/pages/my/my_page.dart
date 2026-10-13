import 'dart:async';
import 'package:kazumi/services/storage/storage.dart';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_mobx/flutter_mobx.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:image_picker/image_picker.dart';
import 'package:kazumi/bean/card/bangumi_history_card.dart';
import 'package:kazumi/bean/card/network_img_layer.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/pages/menu/menu.dart';
import 'package:kazumi/pages/history/history_controller.dart';
import 'package:kazumi/pages/notifications/update_notification_controller.dart';
import 'package:kazumi/pages/notifications/comment_notification_controller.dart';
import 'package:kazumi/modules/history/history_module.dart';
import 'package:kazumi/repositories/collect_crud_repository.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';
import 'package:kazumi/services/player/syncplay_session_controller.dart';
import 'package:kazumi/utils/root_back_navigation.dart';
import 'package:kazumi/utils/date_time.dart';
import 'package:provider/provider.dart';

class MyPage extends StatefulWidget {
  const MyPage({super.key});

  @override
  State<MyPage> createState() => _MyPageState();
}

class _MyPageState extends State<MyPage> {
  late NavigationBarState navigationBarState;
  int historyCount = 0;
  int collectCount = 0;
  AniWorldUser? user;
  bool loadingUser = false;
  StreamSubscription<void>? _accountSubscription;
  final HistoryController historyController = Modular.get<HistoryController>();
  final UpdateNotificationController notificationController =
      Modular.get<UpdateNotificationController>();
  final CommentNotificationController commentNotificationController =
      Modular.get<CommentNotificationController>();
  final SyncPlaySessionController syncPlaySession =
      Modular.get<SyncPlaySessionController>();

  final emailController = TextEditingController();
  final usernameController = TextEditingController();
  final passwordController = TextEditingController();
  final confirmPasswordController = TextEditingController();
  final codeController = TextEditingController();
  bool registerMode = false;
  bool resetPasswordMode = false;
  bool _authSubmitting = false;
  bool _codeSending = false;
  int _codeCooldown = 0;
  Timer? _codeTimer;
  String? _pendingAvatarPath; // temp file path after image_picker pick

  @override
  void initState() {
    super.initState();
    _accountSubscription = GStorage.accountChanges.listen((_) {
      if (!mounted) return;
      setState(() {
        user = AniWorldApi.cachedUser;
        loadingUser = false;
        _loadStats();
      });
    });
    navigationBarState = Provider.of<NavigationBarState>(
      context,
      listen: false,
    );
    _loadStats();
    user = AniWorldApi.cachedUser;
    _refreshUser();
    unawaited(notificationController.checkForUpdates());
    unawaited(commentNotificationController.refresh());
  }

  @override
  void dispose() {
    _accountSubscription?.cancel();
    emailController.dispose();
    usernameController.dispose();
    passwordController.dispose();
    confirmPasswordController.dispose();
    codeController.dispose();
    _codeTimer?.cancel();
    super.dispose();
  }

  void _loadStats() {
    historyController.init();
    historyCount = historyController.histories.length;
    collectCount =
        Modular.get<ICollectCrudRepository>().getAllCollectibles().length;
  }

  Future<void> _refreshUser() async {
    if (AniWorldApi.token.trim().isEmpty) return;
    final account = AniWorldAccountSnapshot();
    if (!account.isLoggedIn) return;
    setState(() => loadingUser = true);
    final next = await AniWorldApi.fetchMe();
    if (!mounted || !account.isCurrent) return;
    setState(() {
      user = next;
      loadingUser = false;
    });
  }

  void onBackPressed(BuildContext context) {
    if (popMediaOverlayIfPresent(context)) {
      return;
    }
    if (KazumiDialog.observer.hasKazumiDialog) {
      KazumiDialog.dismiss();
      return;
    }
    navigationBarState.updateSelectedIndex(0);
    Modular.to.navigate('/tab/popular/');
  }

  Future<void> submitAuth() async {
    if (_authSubmitting) return;
    final email = emailController.text.trim();
    final password = passwordController.text.trim();
    final confirmPassword = confirmPasswordController.text.trim();
    if (email.isEmpty || password.isEmpty) {
      KazumiDialog.showToast(message: '请填写邮箱和密码');
      return;
    }
    if ((registerMode || resetPasswordMode) && password.length < 6) {
      KazumiDialog.showToast(message: '密码至少6个字符');
      return;
    }
    if ((registerMode || resetPasswordMode) && password != confirmPassword) {
      KazumiDialog.showToast(message: '两次密码不一致');
      return;
    }
    if ((registerMode || resetPasswordMode) &&
        codeController.text.trim().isEmpty) {
      KazumiDialog.showToast(message: '请输入邮箱验证码');
      return;
    }

    setState(() => _authSubmitting = true);
    AniWorldAuthResult result;
    if (resetPasswordMode) {
      result = await AniWorldApi.resetPassword(
        email: email,
        code: codeController.text.trim(),
        newPassword: password,
        confirmPassword: confirmPassword,
      );
    } else if (registerMode) {
      result = await AniWorldApi.register(
        email: email,
        username: usernameController.text.trim(),
        password: password,
        code: codeController.text.trim(),
      );
    } else {
      result = await AniWorldApi.login(email: email, password: password);
    }
    if (!mounted) return;
    setState(() => _authSubmitting = false);
    KazumiDialog.showToast(message: result.message);
    if (result.success) {
      if (resetPasswordMode) {
        _switchAuthMode(register: false, reset: false);
      } else {
        setState(() {
          user = result.user ?? AniWorldApi.cachedUser;
        });
        unawaited(commentNotificationController.refresh(force: true));
      }
    }
  }

  Future<void> sendCode() async {
    if (_codeSending || _codeCooldown > 0) return;
    final email = emailController.text.trim();
    if (email.isEmpty) {
      KazumiDialog.showToast(message: '请先输入邮箱');
      return;
    }
    setState(() => _codeSending = true);
    final msg = resetPasswordMode
        ? await AniWorldApi.sendPasswordResetCode(email)
        : await AniWorldApi.sendRegisterCode(email);
    if (!mounted) return;
    setState(() => _codeSending = false);
    KazumiDialog.showToast(message: msg);
    if (msg.contains('已发送')) _startCodeCooldown();
  }

  void _startCodeCooldown() {
    _codeTimer?.cancel();
    setState(() => _codeCooldown = 60);
    _codeTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted || _codeCooldown <= 1) {
        timer.cancel();
        if (mounted) setState(() => _codeCooldown = 0);
        return;
      }
      setState(() => _codeCooldown--);
    });
  }

  void _switchAuthMode({required bool register, required bool reset}) {
    _codeTimer?.cancel();
    setState(() {
      registerMode = register;
      resetPasswordMode = reset;
      _codeCooldown = 0;
      _codeSending = false;
      _authSubmitting = false;
      passwordController.clear();
      confirmPasswordController.clear();
      codeController.clear();
    });
  }

  Future<void> logout() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('确定要退出当前账号吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('确定退出'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    await AniWorldApi.logout();
    await commentNotificationController.refresh(force: true);
    if (!mounted) return;
    setState(() => user = null);
    KazumiDialog.showToast(message: '已退出登录');
  }

  Future<void> showProfileSettings() async {
    final current = user;
    if (current == null) return;
    final nameController = TextEditingController(text: current.username);
    _pendingAvatarPath = null;
    // Pre-resolve current avatar for display in the modal
    final currentAvatarProvider = AniWorldApi.resolveAvatar(current.avatar);
    Uint8List? pickedAvatarBytes;
    var openPasswordDialog = false;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            return SafeArea(
              child: Padding(
                padding: EdgeInsets.fromLTRB(
                  18,
                  4,
                  18,
                  MediaQuery.viewInsetsOf(context).bottom + 18,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '个人设置',
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                            fontWeight: FontWeight.w800,
                          ),
                    ),
                    const SizedBox(height: 18),
                    // Avatar picker
                    Center(
                      child: GestureDetector(
                        onTap: () async {
                          final picker = ImagePicker();
                          final xFile = await picker.pickImage(
                            source: ImageSource.gallery,
                            maxWidth: 512,
                            maxHeight: 512,
                            imageQuality: 85,
                          );
                          if (xFile != null) {
                            _pendingAvatarPath = xFile.path;
                            final bytes = await xFile.readAsBytes();
                            setModalState(() => pickedAvatarBytes = bytes);
                          }
                        },
                        child: CircleAvatar(
                          radius: 54,
                          backgroundColor: Theme.of(
                            context,
                          ).colorScheme.primaryContainer,
                          foregroundImage: pickedAvatarBytes != null
                              ? MemoryImage(pickedAvatarBytes!)
                              : currentAvatarProvider,
                          child: Icon(
                            Icons.camera_alt_rounded,
                            size: 34,
                            color: Theme.of(
                              context,
                            ).colorScheme.onPrimaryContainer,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Center(
                      child: Text(
                        '点击头像更换',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                          fontSize: 13,
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    TextField(
                      controller: nameController,
                      decoration: const InputDecoration(labelText: '昵称'),
                    ),
                    const SizedBox(height: 18),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton.icon(
                        icon: const Icon(Icons.save_rounded),
                        label: const Text('保存修改'),
                        onPressed: () async {
                          // If a new avatar was picked, upload it first
                          if (_pendingAvatarPath != null) {
                            final avatarResult = await AniWorldApi.uploadAvatar(
                              _pendingAvatarPath!,
                            );
                            if (!mounted) return;
                            KazumiDialog.showToast(
                              message: avatarResult.message,
                            );
                            if (!avatarResult.success) return;
                            setState(
                              () => user =
                                  avatarResult.user ?? AniWorldApi.cachedUser,
                            );
                          }
                          // Then update username if changed
                          final newUsername = nameController.text.trim();
                          if (newUsername.isNotEmpty &&
                              newUsername != current.username) {
                            final result = await AniWorldApi.updateProfile(
                              username: newUsername,
                            );
                            if (!mounted) return;
                            KazumiDialog.showToast(message: result.message);
                            if (result.success) {
                              setState(
                                () => user =
                                    result.user ?? AniWorldApi.cachedUser,
                              );
                            }
                          } else if (_pendingAvatarPath == null) {
                            KazumiDialog.showToast(message: '没有修改内容');
                          }
                          if (context.mounted) {
                            Navigator.of(context).maybePop();
                          }
                        },
                      ),
                    ),
                    const SizedBox(height: 10),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        icon: const Icon(Icons.password_rounded),
                        label: const Text('修改登录密码'),
                        onPressed: () {
                          openPasswordDialog = true;
                          Navigator.of(context).maybePop();
                        },
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
    nameController.dispose();
    if (openPasswordDialog && mounted) {
      await showChangePasswordDialog();
    }
  }

  Future<void> showChangePasswordDialog() async {
    final currentController = TextEditingController();
    final nextController = TextEditingController();
    final confirmController = TextEditingController();
    var submitting = false;
    var obscure = true;
    String? errorText;

    final changed = await showDialog<bool>(
      context: context,
      barrierDismissible: !submitting,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('修改登录密码'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: currentController,
                  obscureText: obscure,
                  enabled: !submitting,
                  autofillHints: const [AutofillHints.password],
                  decoration: const InputDecoration(labelText: '当前密码'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: nextController,
                  obscureText: obscure,
                  enabled: !submitting,
                  autofillHints: const [AutofillHints.newPassword],
                  decoration: const InputDecoration(labelText: '新密码（至少6位）'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: confirmController,
                  obscureText: obscure,
                  enabled: !submitting,
                  textInputAction: TextInputAction.done,
                  decoration: InputDecoration(
                    labelText: '确认新密码',
                    errorText: errorText,
                    suffixIcon: IconButton(
                      onPressed: submitting
                          ? null
                          : () => setDialogState(() => obscure = !obscure),
                      icon: Icon(
                        obscure
                            ? Icons.visibility_rounded
                            : Icons.visibility_off_rounded,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: submitting
                  ? null
                  : () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: submitting
                  ? null
                  : () async {
                      final currentPassword = currentController.text;
                      final newPassword = nextController.text;
                      final confirmPassword = confirmController.text;
                      if (currentPassword.isEmpty ||
                          newPassword.isEmpty ||
                          confirmPassword.isEmpty) {
                        setDialogState(() => errorText = '请填写所有密码字段');
                        return;
                      }
                      if (newPassword.length < 6) {
                        setDialogState(() => errorText = '新密码至少6个字符');
                        return;
                      }
                      if (newPassword != confirmPassword) {
                        setDialogState(() => errorText = '两次新密码不一致');
                        return;
                      }
                      setDialogState(() {
                        submitting = true;
                        errorText = null;
                      });
                      final result = await AniWorldApi.changePassword(
                        currentPassword: currentPassword,
                        newPassword: newPassword,
                        confirmPassword: confirmPassword,
                      );
                      if (!dialogContext.mounted) return;
                      if (result.success) {
                        Navigator.of(dialogContext).pop(true);
                      } else {
                        setDialogState(() {
                          submitting = false;
                          errorText = result.message;
                        });
                      }
                    },
              child: submitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('确认修改'),
            ),
          ],
        ),
      ),
    );

    currentController.dispose();
    nextController.dispose();
    confirmController.dispose();
    if (changed == true && mounted) {
      setState(() => user = null);
      KazumiDialog.showToast(message: '密码修改成功，请使用新密码重新登录');
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop) onBackPressed(context);
      },
      child: Scaffold(
        body: SafeArea(
          child: RefreshIndicator(
            onRefresh: () async {
              setState(_loadStats);
              await Future.wait([
                _refreshUser(),
                notificationController.checkForUpdates(force: true),
                commentNotificationController.refresh(force: true),
              ]);
            },
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(
                parent: BouncingScrollPhysics(),
              ),
              padding: const EdgeInsets.fromLTRB(22, 18, 22, 28),
              children: [
                Align(
                  alignment: Alignment.centerRight,
                  child: buildNotificationEntry(),
                ),
                const SizedBox(height: 4),
                if (user == null)
                  buildLoginCard(colorScheme)
                else
                  buildUserHeader(colorScheme, user!),
                const SizedBox(height: 24),
                buildSyncPlayStatusCard(colorScheme),
                buildStatsCard(colorScheme),
                const SizedBox(height: 24),
                buildShortcutGrid(colorScheme),
                buildContinueWatching(colorScheme),
                if (user != null)
                  FilledButton.tonalIcon(
                    onPressed: logout,
                    icon: const Icon(Icons.logout_rounded),
                    label: const Text('退出登录'),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget buildNotificationEntry() {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        buildCommentNotificationEntry(),
        buildUpdateNotificationEntry(),
      ],
    );
  }

  Widget buildCommentNotificationEntry() {
    return AnimatedBuilder(
      animation: commentNotificationController,
      builder: (context, _) {
        final unread = commentNotificationController.unreadCount;
        final badgeText = unread > 99 ? '99+' : '$unread';
        return IconButton(
          tooltip: unread > 0 ? '消息通知，$unread条未读' : '消息通知',
          onPressed: () {
            if (!AniWorldApi.isLoggedIn) {
              KazumiDialog.showToast(message: '登录后可以查看消息通知');
              return;
            }
            Modular.to.pushNamed('/tab/my/comment-notifications/');
          },
          icon: Badge(
            isLabelVisible: unread > 0,
            label: Text(badgeText),
            child: const Icon(Icons.mail_outline_rounded),
          ),
        );
      },
    );
  }

  Widget buildUpdateNotificationEntry() {
    return AnimatedBuilder(
      animation: notificationController,
      builder: (context, _) {
        final unread = notificationController.unreadCount;
        final badgeText = unread > 99 ? '99+' : '$unread';
        return IconButton(
          tooltip: unread > 0 ? '更新提醒，$unread条未读' : '更新提醒',
          onPressed: () => Modular.to.pushNamed('/tab/my/notifications/'),
          icon: Badge(
            isLabelVisible: unread > 0,
            label: Text(badgeText),
            child: Icon(
              unread > 0
                  ? Icons.notifications_rounded
                  : Icons.notifications_none_rounded,
            ),
          ),
        );
      },
    );
  }

  Widget buildLoginCard(ColorScheme colorScheme) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(24),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            resetPasswordMode
                ? '重置 AniWorld 密码'
                : registerMode
                    ? '注册 AniWorld 账号'
                    : '登录 AniWorld 账号',
            style: Theme.of(
              context,
            ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: emailController,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(labelText: '邮箱'),
          ),
          if (registerMode) ...[
            const SizedBox(height: 8),
            TextField(
              controller: usernameController,
              decoration: const InputDecoration(labelText: '用户名'),
            ),
          ],
          const SizedBox(height: 8),
          TextField(
            controller: passwordController,
            obscureText: true,
            autofillHints: [
              resetPasswordMode || registerMode
                  ? AutofillHints.newPassword
                  : AutofillHints.password,
            ],
            decoration: InputDecoration(
              labelText: resetPasswordMode ? '新密码（至少6位）' : '密码',
            ),
          ),
          if (registerMode || resetPasswordMode) ...[
            const SizedBox(height: 8),
            TextField(
              controller: confirmPasswordController,
              obscureText: true,
              textInputAction: TextInputAction.done,
              decoration: const InputDecoration(labelText: '确认密码'),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: codeController,
                    decoration: const InputDecoration(labelText: '邮箱验证码'),
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed:
                      _codeSending || _codeCooldown > 0 ? null : sendCode,
                  child: Text(
                    _codeSending
                        ? '发送中…'
                        : _codeCooldown > 0
                            ? '${_codeCooldown}s'
                            : '发送验证码',
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: _authSubmitting ? null : submitAuth,
                  child: _authSubmitting
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(
                          resetPasswordMode
                              ? '重置密码'
                              : registerMode
                                  ? '注册并登录'
                                  : '登录',
                        ),
                ),
              ),
              const SizedBox(width: 10),
              TextButton(
                onPressed: () => _switchAuthMode(
                  register: !registerMode && !resetPasswordMode,
                  reset: false,
                ),
                child: Text(
                  registerMode || resetPasswordMode ? '返回登录' : '注册账号',
                ),
              ),
            ],
          ),
          if (!registerMode && !resetPasswordMode)
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () => _switchAuthMode(register: false, reset: true),
                child: const Text('忘记密码？'),
              ),
            ),
        ],
      ),
    );
  }

  Widget buildUserHeader(ColorScheme colorScheme, AniWorldUser user) {
    final avatarProvider = AniWorldApi.resolveAvatar(user.avatar);
    return Row(
      children: [
        CircleAvatar(
          radius: 38,
          backgroundColor: colorScheme.primaryContainer,
          foregroundImage: avatarProvider,
          child: Icon(
            Icons.person_rounded,
            size: 38,
            color: colorScheme.onPrimaryContainer,
          ),
        ),
        const SizedBox(width: 18),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                user.username,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
              ),
              const SizedBox(height: 6),
              Text(
                user.email,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget buildStatsCard(ColorScheme colorScheme) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 22),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(28),
      ),
      child: Row(
        children: [
          Expanded(
            child: buildStatItem(
              value: historyCount.toString(),
              label: '观看数量',
              onTap: () => Modular.to.pushNamed('/tab/my/history/'),
            ),
          ),
          Container(width: 1, height: 52, color: colorScheme.outlineVariant),
          Expanded(
            child: buildStatItem(
              value: collectCount.toString(),
              label: '追番数量',
              onTap: () {
                navigationBarState.updateSelectedIndex(2);
                Modular.to.navigate('/tab/collect/');
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget buildStatItem({
    required String value,
    required String label,
    VoidCallback? onTap,
  }) {
    final content = Column(
      children: [
        Text(
          value,
          style: Theme.of(
            context,
          ).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 6),
        Text(
          label,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontWeight: FontWeight.w500,
          ),
        ),
      ],
    );

    if (onTap == null) {
      return content;
    }

    return InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: content,
      ),
    );
  }

  Widget buildSyncPlayStatusCard(ColorScheme colorScheme) {
    return AnimatedBuilder(
      animation: syncPlaySession,
      builder: (context, _) {
        if (!syncPlaySession.hasSession) return const SizedBox.shrink();
        final room = syncPlaySession.room.trim();
        final role = syncPlaySession.isHost ? '房主' : '参与者';
        return Card(
          clipBehavior: Clip.antiAlias,
          color: colorScheme.primaryContainer,
          child: InkWell(
            onTap: () => Modular.to.pushNamed('/tab/my/syncplay/'),
            child: ListTile(
              leading: Badge(
                smallSize: 9,
                child: Icon(Icons.groups_rounded, color: colorScheme.primary),
              ),
              title: const Text('正在一起看'),
              subtitle: Text('房间 ${room.isEmpty ? '连接中' : room} · $role'),
              trailing: const Icon(Icons.chevron_right_rounded),
            ),
          ),
        );
      },
    );
  }

  Widget buildShortcutGrid(ColorScheme colorScheme) {
    return AnimatedBuilder(
      animation: syncPlaySession,
      builder: (context, _) {
        final connected = syncPlaySession.hasSession;
        final room = syncPlaySession.room.trim();
        final items = [
          const _MyShortcut(
            icon: Icons.history_rounded,
            label: '观看历史',
            route: '/tab/my/history/',
          ),
          _MyShortcut(
            icon: connected ? Icons.groups_rounded : Icons.groups_outlined,
            label: connected && room.isNotEmpty ? '房间 $room' : '一起看',
            route: '/tab/my/syncplay/',
            emphasized: connected,
          ),
          const _MyShortcut(
            icon: Icons.download_rounded,
            label: '离线下载',
            route: '/tab/my/download/',
          ),
          const _MyShortcut(
            icon: Icons.settings_rounded,
            label: '设置中心',
            route: '/settings/',
          ),
        ];
        return GridView.builder(
          itemCount: items.length,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 4,
            mainAxisSpacing: 0,
            crossAxisSpacing: 8,
            mainAxisExtent: 84,
          ),
          itemBuilder: (context, index) {
            final item = items[index];
            return InkWell(
              borderRadius: BorderRadius.circular(20),
              onTap: () => Modular.to.pushNamed(item.route),
              child: Container(
                decoration: BoxDecoration(
                  color: item.emphasized
                      ? colorScheme.primaryContainer
                      : colorScheme.surfaceContainerHighest.withValues(
                          alpha: 0.5,
                        ),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Badge(
                      isLabelVisible: item.emphasized,
                      smallSize: 8,
                      child: Icon(
                        item.icon,
                        color: colorScheme.primary,
                        size: 28,
                      ),
                    ),
                    const SizedBox(height: 7),
                    Text(
                      item.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: colorScheme.onSurfaceVariant,
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget buildContinueWatching(ColorScheme colorScheme) {
    return Observer(
      builder: (context) {
        final histories = historyController.histories.take(3).toList();
        if (histories.isEmpty) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.only(top: 24, bottom: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '继续观看',
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 12),
              for (final history in histories)
                _ContinueWatchingCard(
                  historyItem: history,
                  colorScheme: colorScheme,
                ),
            ],
          ),
        );
      },
    );
  }
}

class _MyShortcut {
  const _MyShortcut({
    required this.icon,
    required this.label,
    required this.route,
    this.emphasized = false,
  });

  final IconData icon;
  final String label;
  final String route;
  final bool emphasized;
}

class _ContinueWatchingCard extends StatelessWidget {
  const _ContinueWatchingCard({
    required this.historyItem,
    required this.colorScheme,
  });

  final History historyItem;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    final title = historyItem.bangumiItem.nameCn.isNotEmpty
        ? historyItem.bangumiItem.nameCn
        : historyItem.bangumiItem.name;
    final episode = historyItem.lastWatchEpisodeName.isNotEmpty
        ? historyItem.lastWatchEpisodeName
        : '第${historyItem.lastWatchEpisode}话';
    final source = historySourceText(historyItem.entryKind);
    final watchedAt = formatTimestampToRelativeTime(
      historyItem.lastWatchTime.millisecondsSinceEpoch ~/ 1000,
    );

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      elevation: 0,
      color: colorScheme.surfaceContainerLow,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => unawaited(resumeHistoryPlayback(historyItem)),
        child: Padding(
          padding: const EdgeInsets.all(10),
          child: Row(
            children: [
              _buildPoster(context),
              const SizedBox(width: 12),
              Expanded(
                child: SizedBox(
                  height: 96,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(
                              fontWeight: FontWeight.w800,
                            ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '看到 $episode',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                              color: colorScheme.onSurfaceVariant,
                            ),
                      ),
                      const Spacer(),
                      Row(
                        children: [
                          _buildTag(context, source),
                          const SizedBox(width: 6),
                          _buildTag(context, historyItem.adapterName),
                          const SizedBox(width: 8),
                          Flexible(
                            child: Text(
                              watchedAt,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Theme.of(context)
                                  .textTheme
                                  .labelMedium
                                  ?.copyWith(color: colorScheme.outline),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPoster(BuildContext context) {
    return SizedBox(
      width: 88,
      height: 96,
      child: Stack(
        fit: StackFit.expand,
        children: [
          NetworkImgLayer(
            src: historyItem.bangumiItem.images['large'] ?? '',
            width: 88,
            height: 96,
          ),
          Center(
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: colorScheme.primary.withValues(alpha: 0.92),
                shape: BoxShape.circle,
              ),
              child: const Padding(
                padding: EdgeInsets.all(9),
                child: Icon(
                  Icons.play_arrow_rounded,
                  color: Colors.white,
                  size: 28,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTag(BuildContext context, String text) {
    return Container(
      constraints: const BoxConstraints(maxWidth: 90),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: colorScheme.secondaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: colorScheme.onSecondaryContainer,
            ),
      ),
    );
  }
}
