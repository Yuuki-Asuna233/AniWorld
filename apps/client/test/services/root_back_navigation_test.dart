import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/utils/root_back_navigation.dart';

void main() {
  setUp(RootBackNavigationGuard.reset);

  test('recognizes only details and player root routes', () {
    expect(isMediaOverlayRoute('/info/'), isTrue);
    expect(isMediaOverlayRoute('/info/?id=1'), isTrue);
    expect(isMediaOverlayRoute('/video/'), isTrue);
    expect(isMediaOverlayRoute('/tab/popular/'), isFalse);
    expect(isMediaOverlayRoute('/tab/my/history/'), isFalse);
  });

  testWidgets('a shell context pops the visible root media page',
      (tester) async {
    late BuildContext shellContext;

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) {
            shellContext = context;
            return const Scaffold(body: Text('发现'));
          },
        ),
      ),
    );

    Navigator.of(shellContext).push(
      MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Text('动漫详情')),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('动漫详情'), findsOneWidget);

    final consumed = popMediaOverlayIfPresent(
      shellContext,
      // Modular may still expose the underlying tab path when its PopScope
      // receives Android's back callback. The visible root route must win.
      currentPath: '/tab/popular/',
    );
    expect(consumed, isTrue);
    await tester.pumpAndSettle();

    expect(find.text('动漫详情'), findsNothing);
    expect(find.text('发现'), findsOneWidget);
  });

  testWidgets('one Android back gesture can pop only one route',
      (tester) async {
    late BuildContext shellContext;

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) {
            shellContext = context;
            return const Scaffold(body: Text('shell'));
          },
        ),
      ),
    );

    final navigator = Navigator.of(shellContext);
    navigator.push(MaterialPageRoute<void>(builder: (_) => const Text('one')));
    navigator.push(MaterialPageRoute<void>(builder: (_) => const Text('two')));
    await tester.pumpAndSettle();

    expect(popMediaOverlayIfPresent(shellContext), isTrue);
    // Simulates the same platform event reaching the tab below the player.
    expect(popMediaOverlayIfPresent(shellContext), isTrue);
    await tester.pumpAndSettle();

    expect(find.text('two'), findsNothing);
    expect(find.text('one'), findsOneWidget);
  });
}
