import 'package:flutter/material.dart';
import 'package:kazumi/services/server/server_config_service.dart';

Future<bool?> showServerSettingsDialog(BuildContext context) {
  return showDialog<bool>(
    context: context,
    useRootNavigator: true,
    barrierDismissible: false,
    builder: (_) => const ServerSettingsDialog(),
  );
}

class ServerSettingsDialog extends StatefulWidget {
  const ServerSettingsDialog({super.key});

  @override
  State<ServerSettingsDialog> createState() => _ServerSettingsDialogState();
}

class _ServerSettingsDialogState extends State<ServerSettingsDialog> {
  late final TextEditingController _controller;
  ServerTestResult? _result;
  bool _testing = false;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(
      text: ServerConfigService.currentAddress,
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<ServerTestResult> _test() async {
    setState(() {
      _testing = true;
      _result = null;
    });
    final result = await ServerConfigService.testAddress(_controller.text);
    if (mounted) {
      setState(() {
        _testing = false;
        _result = result;
        if (result.success && result.normalizedAddress != null) {
          _controller.text = result.normalizedAddress!;
          _controller.selection = TextSelection.collapsed(
            offset: _controller.text.length,
          );
        }
      });
    }
    return result;
  }

  Future<void> _save() async {
    if (_testing || _saving) return;
    setState(() => _saving = true);
    final result = await _test();
    if (!mounted) return;
    if (!result.success || result.normalizedAddress == null) {
      setState(() => _saving = false);
      return;
    }

    try {
      final changed = await ServerConfigService.applyAddress(
        result.normalizedAddress!,
      );
      if (!mounted) return;
      Navigator.of(context).pop(changed);
    } on FormatException catch (error) {
      setState(() {
        _saving = false;
        _result = ServerTestResult.failure(error.message);
      });
    } catch (error) {
      setState(() {
        _saving = false;
        _result = ServerTestResult.failure('保存失败：$error');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final busy = _testing || _saving;
    return AlertDialog(
      title: const Text('服务器地址'),
      content: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '支持 IP、域名和端口。只填写 IP 时默认使用 http:// 和 3000 端口。',
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _controller,
              enabled: !busy,
              keyboardType: TextInputType.url,
              textInputAction: TextInputAction.done,
              autocorrect: false,
              enableSuggestions: false,
              onChanged: (_) {
                if (_result != null) setState(() => _result = null);
              },
              onSubmitted: (_) => _save(),
              decoration: const InputDecoration(
                labelText: '服务器 IP 或地址',
                hintText: 'http://1.2.3.4:3000',
                prefixIcon: Icon(Icons.dns_outlined),
                border: OutlineInputBorder(),
              ),
            ),
            if (_result != null) ...[
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    _result!.success
                        ? Icons.check_circle_rounded
                        : Icons.error_outline_rounded,
                    color: _result!.success
                        ? colorScheme.primary
                        : colorScheme.error,
                    size: 20,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _result!.message,
                      style: TextStyle(
                        color: _result!.success
                            ? colorScheme.primary
                            : colorScheme.error,
                      ),
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 10),
            Text(
              '保存前会自动测试。切换服务器后，需要重新输入访问密码并重新登录账号。',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        OutlinedButton.icon(
          onPressed: busy ? null : _test,
          icon: _testing
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.network_check_rounded),
          label: const Text('测试连接'),
        ),
        FilledButton(
          onPressed: busy ? null : _save,
          child: _saving
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('保存并切换'),
        ),
      ],
    );
  }
}
