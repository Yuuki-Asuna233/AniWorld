import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:image_picker/image_picker.dart';
import 'package:kazumi/bean/settings/settings_detail_scaffold.dart';
import 'package:kazumi/bean/settings/settings_list.dart';
import 'package:kazumi/request/apis/aniworld_api.dart';

/// Account operations live here instead of being hidden in the My tab.
/// Keeping this page independent also makes it usable on desktop settings
/// layouts where the bottom navigation is not visible.
class PersonalSettingsPage extends StatefulWidget {
  const PersonalSettingsPage({super.key});

  @override
  State<PersonalSettingsPage> createState() => _PersonalSettingsPageState();
}

class _PersonalSettingsPageState extends State<PersonalSettingsPage> {
  AniWorldUser? user;
  bool loading = true;
  bool _loggingOut = false;

  @override
  void initState() {
    super.initState();
    unawaited(_loadUser());
  }

  Future<void> _loadUser() async {
    final cached = AniWorldApi.cachedUser;
    if (mounted) setState(() => user = cached);
    final fresh = await AniWorldApi.fetchMe();
    if (!mounted) return;
    setState(() {
      user = fresh ?? cached;
      loading = false;
    });
  }

  String _formatDate(int timestamp) {
    if (timestamp <= 0) return '暂无数据';
    final date = DateTime.fromMillisecondsSinceEpoch(timestamp * 1000);
    String two(int value) => value.toString().padLeft(2, '0');
    return '${date.year}-${two(date.month)}-${two(date.day)}';
  }

  Future<void> _editProfile() async {
    final current = user;
    if (current == null) return;
    final nameController = TextEditingController(text: current.username);
    XFile? pickedFile;
    bool saving = false;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (sheetContext, setSheetState) {
          final avatar = pickedFile == null
              ? AniWorldApi.resolveAvatar(current.avatar)
              : null;
          return SafeArea(
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                20,
                4,
                20,
                MediaQuery.viewInsetsOf(sheetContext).bottom + 20,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('编辑个人资料',
                      style: Theme.of(sheetContext).textTheme.titleLarge),
                  const SizedBox(height: 18),
                  GestureDetector(
                    onTap: saving
                        ? null
                        : () async {
                            final result = await ImagePicker().pickImage(
                              source: ImageSource.gallery,
                              maxWidth: 512,
                              maxHeight: 512,
                              imageQuality: 85,
                            );
                            if (result != null) {
                              setSheetState(() => pickedFile = result);
                            }
                          },
                    child: CircleAvatar(
                      radius: 48,
                      backgroundColor:
                          Theme.of(sheetContext).colorScheme.primaryContainer,
                      foregroundImage: avatar,
                      child: pickedFile == null
                          ? const Icon(Icons.camera_alt_rounded, size: 30)
                          : const Icon(Icons.image_rounded, size: 30),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text('点击头像选择新图片',
                      style: Theme.of(sheetContext).textTheme.bodySmall),
                  const SizedBox(height: 16),
                  TextField(
                    controller: nameController,
                    enabled: !saving,
                    maxLength: 20,
                    decoration: const InputDecoration(
                      labelText: '名称',
                      prefixIcon: Icon(Icons.badge_outlined),
                    ),
                  ),
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: saving
                          ? null
                          : () async {
                              final name = nameController.text.trim();
                              if (name.isEmpty) return;
                              setSheetState(() => saving = true);
                              AniWorldAuthResult result =
                                  const AniWorldAuthResult(
                                success: false,
                                message: '保存失败',
                              );
                              if (pickedFile != null) {
                                result = await AniWorldApi.uploadAvatar(
                                  pickedFile!.path,
                                );
                                if (!result.success) {
                                  if (sheetContext.mounted) {
                                    setSheetState(() => saving = false);
                                  }
                                  return;
                                }
                              }
                              if (name != current.username) {
                                result = await AniWorldApi.updateProfile(
                                  username: name,
                                );
                              }
                              if (!mounted || !sheetContext.mounted) return;
                              if (result.success ||
                                  pickedFile != null &&
                                      AniWorldApi.cachedUser != null) {
                                setState(() => user =
                                    result.user ?? AniWorldApi.cachedUser);
                                Navigator.of(sheetContext).pop();
                              } else {
                                setSheetState(() => saving = false);
                              }
                            },
                      icon: saving
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.save_rounded),
                      label: const Text('保存资料'),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
    nameController.dispose();
  }

  Future<void> _changePassword() async {
    final currentController = TextEditingController();
    final nextController = TextEditingController();
    final confirmController = TextEditingController();
    String? error;
    bool saving = false;

    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('更换密码'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: currentController,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: '当前密码'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: nextController,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: '新密码（至少6位）'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: confirmController,
                  obscureText: true,
                  decoration: InputDecoration(
                    labelText: '确认新密码',
                    errorText: error,
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(dialogContext),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: saving
                  ? null
                  : () async {
                      if (currentController.text.isEmpty ||
                          nextController.text.length < 6 ||
                          nextController.text != confirmController.text) {
                        setDialogState(() => error = '请检查密码填写是否正确');
                        return;
                      }
                      setDialogState(() => saving = true);
                      final result = await AniWorldApi.changePassword(
                        currentPassword: currentController.text,
                        newPassword: nextController.text,
                        confirmPassword: confirmController.text,
                      );
                      if (!dialogContext.mounted) return;
                      if (result.success) {
                        Navigator.pop(dialogContext);
                        setState(() => user = null);
                      } else {
                        setDialogState(() {
                          saving = false;
                          error = result.message;
                        });
                      }
                    },
              child: const Text('确认修改'),
            ),
          ],
        ),
      ),
    );
    currentController.dispose();
    nextController.dispose();
    confirmController.dispose();
  }

  Future<void> _changeEmail() async {
    final emailController = TextEditingController(text: user?.email ?? '');
    final passwordController = TextEditingController();
    final codeController = TextEditingController();
    String? error;
    String? codeMessage;
    bool sending = false;
    bool saving = false;

    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: const Text('改绑邮箱'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: emailController,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: '新邮箱'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: codeController,
                  decoration: InputDecoration(
                    labelText: '邮箱验证码',
                    errorText: error,
                    suffixIcon: TextButton(
                      onPressed: sending
                          ? null
                          : () async {
                              final email = emailController.text.trim();
                              if (email.isEmpty) return;
                              setDialogState(() {
                                sending = true;
                                error = null;
                              });
                              final message =
                                  await AniWorldApi.sendEmailChangeCode(email);
                              if (!dialogContext.mounted) return;
                              setDialogState(() {
                                sending = false;
                                codeMessage = message;
                              });
                            },
                      child: Text(sending ? '发送中' : '获取验证码'),
                    ),
                  ),
                ),
                if (codeMessage != null) ...[
                  const SizedBox(height: 4),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(codeMessage!,
                        style: Theme.of(dialogContext).textTheme.bodySmall),
                  ),
                ],
                const SizedBox(height: 12),
                TextField(
                  controller: passwordController,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: '当前密码'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(dialogContext),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: saving
                  ? null
                  : () async {
                      if (emailController.text.trim().isEmpty ||
                          codeController.text.trim().isEmpty ||
                          passwordController.text.isEmpty) {
                        setDialogState(() => error = '请填写完整信息');
                        return;
                      }
                      setDialogState(() => saving = true);
                      final result = await AniWorldApi.changeEmail(
                        email: emailController.text.trim(),
                        code: codeController.text.trim(),
                        currentPassword: passwordController.text,
                      );
                      if (!dialogContext.mounted) return;
                      if (result.success) {
                        setState(() => user = result.user ?? user);
                        Navigator.pop(dialogContext);
                      } else {
                        setDialogState(() {
                          saving = false;
                          error = result.message;
                        });
                      }
                    },
              child: const Text('确认改绑'),
            ),
          ],
        ),
      ),
    );
    emailController.dispose();
    passwordController.dispose();
    codeController.dispose();
  }

  Future<void> _logout() async {
    if (_loggingOut) return;
    setState(() => _loggingOut = true);
    await AniWorldApi.logout();
    if (!mounted) return;
    setState(() {
      _loggingOut = false;
      user = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final current = user;
    return SettingsDetailScaffold(
      title: const Text('个人设置'),
      body: loading && current == null
          ? const Center(child: CircularProgressIndicator())
          : current == null
              ? _buildLoggedOut()
              : _buildContent(current),
    );
  }

  Widget _buildLoggedOut() {
    return Center(
      child: FilledButton.tonalIcon(
        onPressed: () => Modular.to.navigate('/tab/my/'),
        icon: const Icon(Icons.login_rounded),
        label: const Text('请先登录 AniWorld 账号'),
      ),
    );
  }

  Widget _buildContent(AniWorldUser current) {
    final colorScheme = Theme.of(context).colorScheme;
    final avatar = AniWorldApi.resolveAvatar(current.avatar);
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
      children: [
        Card(
          elevation: 0,
          color: colorScheme.primaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 34,
                  backgroundColor: colorScheme.surface,
                  foregroundImage: avatar,
                  child: const Icon(Icons.person_rounded, size: 32),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(current.username,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 4),
                      Text(current.email,
                          maxLines: 1, overflow: TextOverflow.ellipsis),
                      const SizedBox(height: 4),
                      Text('注册于 ${_formatDate(current.createdAt)}',
                          style: Theme.of(context).textTheme.bodySmall),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 18),
        SettingsSplitGroup(
          children: [
            SettingsTile.navigation(
              leading: Icons.manage_accounts_rounded,
              title: const Text('编辑个人资料'),
              description: const Text('修改头像和名称'),
              onPressed: (_) => _editProfile(),
            ),
            SettingsTile.navigation(
              leading: Icons.email_outlined,
              title: const Text('改绑邮箱'),
              description: const Text('验证新邮箱并更新登录账号'),
              onPressed: (_) => _changeEmail(),
            ),
            SettingsTile.navigation(
              leading: Icons.password_rounded,
              title: const Text('更换密码'),
              description: const Text('修改登录密码，修改后需要重新登录'),
              onPressed: (_) => _changePassword(),
            ),
          ],
        ),
        const SizedBox(height: 18),
        SettingsSplitGroup(
          children: [
            SettingsTile.navigation(
              leading: Icons.logout_rounded,
              title: const Text('退出登录'),
              description: const Text('退出当前 AniWorld 账号'),
              onPressed: _loggingOut ? null : (_) => _logout(),
            ),
          ],
        ),
      ],
    );
  }
}
