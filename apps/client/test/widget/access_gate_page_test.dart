import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/pages/access/access_gate_page.dart';

void main() {
  testWidgets('hides protected content until access is granted', (
    tester,
  ) async {
    Widget app({required bool checking, required bool granted}) {
      return MaterialApp(
        home: AccessGateView(
          checking: checking,
          granted: granted,
          onUnlocked: () {},
          child: const Text('protected home'),
        ),
      );
    }

    await tester.pumpWidget(app(checking: true, granted: false));
    expect(find.text('AniWorld 正在验证访问权限'), findsOneWidget);
    expect(find.text('protected home'), findsNothing);

    await tester.pumpWidget(app(checking: false, granted: false));
    expect(find.text('访问验证'), findsOneWidget);
    expect(find.text('protected home'), findsNothing);

    await tester.pumpWidget(app(checking: false, granted: true));
    expect(find.text('protected home'), findsOneWidget);
    expect(find.text('访问验证'), findsNothing);
  });

  testWidgets('shows the app access form before protected content', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: AccessGatePage(onUnlocked: () {}),
      ),
    );

    expect(find.text('访问验证'), findsOneWidget);
    expect(find.text('访问密码'), findsOneWidget);
    expect(find.text('解锁 AniWorld'), findsOneWidget);
    expect(find.text('服务器连接设置'), findsOneWidget);
  });

  testWidgets('opens server settings from access page', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: AccessGatePage(onUnlocked: () {}),
      ),
    );

    await tester.tap(find.text('服务器连接设置'));
    await tester.pumpAndSettle();

    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.text('服务器地址'), findsWidgets);
    expect(find.text('测试连接'), findsOneWidget);
  });

  testWidgets('opens server settings when gate replaces MaterialApp child', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) {
          return AccessGateView(
            checking: false,
            granted: false,
            onUnlocked: () {},
            child: child ?? const SizedBox.shrink(),
          );
        },
        home: const Text('protected home'),
      ),
    );

    expect(find.text('protected home'), findsNothing);
    await tester.tap(find.text('服务器连接设置'));
    await tester.pumpAndSettle();

    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.text('服务器地址'), findsWidgets);
    expect(find.text('测试连接'), findsOneWidget);
  });

  testWidgets('password field uses editable visible text input',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: AccessGatePage(onUnlocked: () {}),
      ),
    );

    final passwordField = find.byType(TextField).first;
    await tester.enterText(passwordField, 'xyz');
    expect(find.text('xyz'), findsOneWidget);

    await tester.enterText(passwordField, 'xy');
    expect(find.text('xy'), findsOneWidget);
    expect(find.text('xyz'), findsNothing);

    await tester.enterText(passwordField, 'xyx');
    expect(find.text('xyx'), findsOneWidget);
    expect(find.text('xyzx'), findsNothing);
  });

  testWidgets('password field removes stale IME text after deletion', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: AccessGatePage(onUnlocked: () {}),
      ),
    );

    final passwordField = find.byType(TextField).first;
    await tester.enterText(passwordField, 'xyz');
    await tester.enterText(passwordField, 'xy');

    await tester.showKeyboard(passwordField);
    tester.testTextInput.updateEditingValue(
      const TextEditingValue(
        text: 'xyzx',
        selection: TextSelection.collapsed(offset: 4),
      ),
    );
    await tester.pump();

    expect(find.text('xyx'), findsOneWidget);
    expect(find.text('xyzx'), findsNothing);
  });
}
