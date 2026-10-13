import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kazumi/pages/settings/server_settings_dialog.dart';
import 'package:kazumi/services/access/access_gate_service.dart';
import 'package:kazumi/services/server/server_config_service.dart';

class AccessGateView extends StatelessWidget {
  const AccessGateView({
    required this.checking,
    required this.granted,
    required this.onUnlocked,
    required this.child,
    super.key,
  });

  final bool checking;
  final bool granted;
  final VoidCallback onUnlocked;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (checking) return const AccessGateLoadingPage();
    if (!granted) {
      return Navigator(
        key: const ValueKey('access-gate-navigator'),
        onGenerateRoute: (_) {
          return MaterialPageRoute<void>(
            builder: (_) => AccessGatePage(onUnlocked: onUnlocked),
          );
        },
      );
    }
    return child;
  }
}

class AccessGatePage extends StatefulWidget {
  const AccessGatePage({required this.onUnlocked, super.key});

  final VoidCallback onUnlocked;

  @override
  State<AccessGatePage> createState() => _AccessGatePageState();
}

class _AccessGatePageState extends State<AccessGatePage> {
  final TextEditingController _passwordController = TextEditingController();
  bool _unlocking = false;
  String _error = '';
  String _lastPasswordText = '';
  bool _lastPasswordEditWasDeletion = false;
  bool _normalizingPasswordInput = false;

  @override
  void initState() {
    super.initState();
    _error = AccessGateService.lastError;
    _passwordController.addListener(_normalizePasswordInput);
  }

  void _normalizePasswordInput() {
    if (_normalizingPasswordInput) return;

    final currentText = _passwordController.text;
    if (currentText == _lastPasswordText) return;

    if (currentText.length < _lastPasswordText.length) {
      _lastPasswordText = currentText;
      _lastPasswordEditWasDeletion = true;
      return;
    }

    final looksLikeStaleImeAppend = _lastPasswordEditWasDeletion &&
        _lastPasswordText.isNotEmpty &&
        currentText.startsWith(_lastPasswordText) &&
        currentText.length > _lastPasswordText.length + 1;

    if (looksLikeStaleImeAppend) {
      final normalizedText =
          _lastPasswordText + currentText.substring(currentText.length - 1);
      _normalizingPasswordInput = true;
      _passwordController.value = TextEditingValue(
        text: normalizedText,
        selection: TextSelection.collapsed(offset: normalizedText.length),
      );
      _normalizingPasswordInput = false;
      _lastPasswordText = normalizedText;
      _lastPasswordEditWasDeletion = false;
      return;
    }

    _lastPasswordText = currentText;
    _lastPasswordEditWasDeletion = false;
  }

  Future<void> _unlock() async {
    if (_unlocking) return;
    FocusScope.of(context).unfocus();
    setState(() {
      _unlocking = true;
      _error = '';
    });

    final result = await AccessGateService.unlock(_passwordController.text);
    if (!mounted) return;
    if (!result.success) {
      setState(() {
        _unlocking = false;
        _error = result.message;
      });
      return;
    }

    widget.onUnlocked();
  }

  Future<void> _configureServer() async {
    FocusScope.of(context).unfocus();
    await Future<void>.delayed(const Duration(milliseconds: 120));
    if (!mounted) return;
    final changed = await showServerSettingsDialog(context);
    if (!mounted || changed == null) return;
    _passwordController.clear();
    _lastPasswordText = '';
    _lastPasswordEditWasDeletion = false;
    setState(() {
      _unlocking = false;
      _error = '';
    });
    await _connect();
  }

  Future<void> _connect() async {
    if (_unlocking) return;
    setState(() {
      _unlocking = true;
      _error = '';
    });
    final connected = await AccessGateService.checkAccess();
    if (!mounted) return;
    if (connected) {
      widget.onUnlocked();
      return;
    }
    setState(() {
      _unlocking = false;
      _error = AccessGateService.lastError;
    });
  }

  @override
  void dispose() {
    _passwordController.removeListener(_normalizePasswordInput);
    _passwordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final requiresPassword = AccessGateService.requiresPassword;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 430),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Container(
                      width: 62,
                      height: 62,
                      decoration: BoxDecoration(
                        color: colorScheme.primary,
                        borderRadius: BorderRadius.circular(19),
                      ),
                      child: Icon(
                        requiresPassword
                            ? Icons.lock_rounded
                            : Icons.dns_rounded,
                        color: colorScheme.onPrimary,
                        size: 30,
                      ),
                    ),
                  ),
                  const SizedBox(height: 28),
                  Text(
                    requiresPassword ? '访问验证' : '连接 AniWorld',
                    style: Theme.of(context)
                        .textTheme
                        .headlineMedium
                        ?.copyWith(fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    requiresPassword
                        ? '此服务器需要访问密码，请输入后继续。'
                        : '设置自己部署的 AniWorld 服务器地址，连接后即可使用。',
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                          color: colorScheme.onSurfaceVariant,
                          height: 1.55,
                        ),
                  ),
                  const SizedBox(height: 18),
                  Text(ServerConfigService.currentAddress,
                      style: Theme.of(context).textTheme.bodyMedium),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    onPressed: _unlocking ? null : _configureServer,
                    icon: const Icon(Icons.dns_outlined),
                    label: const Text('服务器连接设置'),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                    ),
                  ),
                  const SizedBox(height: 18),
                  if (requiresPassword)
                    TextField(
                      controller: _passwordController,
                      obscureText: true,
                      enabled: !_unlocking,
                      autofocus: false,
                      keyboardType: TextInputType.text,
                      maxLengthEnforcement: MaxLengthEnforcement.enforced,
                      inputFormatters: [
                        FilteringTextInputFormatter.allow(RegExp(r'[ -~]')),
                        LengthLimitingTextInputFormatter(18),
                      ],
                      autocorrect: false,
                      enableSuggestions: false,
                      enableIMEPersonalizedLearning: false,
                      textCapitalization: TextCapitalization.none,
                      smartDashesType: SmartDashesType.disabled,
                      smartQuotesType: SmartQuotesType.disabled,
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => _unlock(),
                      decoration: InputDecoration(
                        labelText: '访问密码',
                        helperText: '由服务器部署者设置，与账户登录密码不同。',
                        counterText: '',
                        prefixIcon: const Icon(Icons.key_rounded),
                        border: const OutlineInputBorder(),
                      ),
                    ),
                  const SizedBox(height: 18),
                  if (_error.isNotEmpty) ...[
                    Text(_error, style: TextStyle(color: colorScheme.error)),
                    const SizedBox(height: 12),
                  ],
                  FilledButton.icon(
                    onPressed: _unlocking
                        ? null
                        : (requiresPassword ? _unlock : _connect),
                    icon: _unlocking
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.2,
                            ),
                          )
                        : const Icon(Icons.lock_open_rounded),
                    label: Text(_unlocking
                        ? '正在连接…'
                        : (requiresPassword ? '验证并进入' : '连接服务器')),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(54),
                    ),
                  ),
                  if (requiresPassword)
                    TextButton(
                        onPressed: _unlocking ? null : _connect,
                        child: const Text('重新检查服务器连接')),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class AccessGateLoadingPage extends StatelessWidget {
  const AccessGateLoadingPage({super.key});

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: ColoredBox(
        color: colorScheme.surface,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.auto_awesome_rounded,
                size: 48,
                color: colorScheme.primary,
              ),
              const SizedBox(height: 18),
              Text(
                'AniWorld 正在连接服务器',
                style: Theme.of(context)
                    .textTheme
                    .titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 14),
              const SizedBox(
                width: 120,
                child: LinearProgressIndicator(minHeight: 3),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
