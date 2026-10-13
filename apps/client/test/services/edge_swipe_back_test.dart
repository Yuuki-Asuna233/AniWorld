import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/bean/widget/android_edge_swipe_back.dart';
import 'package:flutter/material.dart';

void main() {
  test('accepts an inward swipe from the left edge', () {
    final tracker = EdgeSwipeBackTracker();
    tracker.start(const Offset(8, 100), 400);
    expect(tracker.finish(const Offset(100, 108)), isTrue);
  });

  test('accepts an inward swipe from the right edge', () {
    final tracker = EdgeSwipeBackTracker();
    tracker.start(const Offset(394, 100), 400);
    expect(tracker.finish(const Offset(300, 106)), isTrue);
  });

  test('rejects content swipes and mostly vertical edge swipes', () {
    final tracker = EdgeSwipeBackTracker();
    tracker.start(const Offset(100, 100), 400);
    expect(tracker.finish(const Offset(200, 102)), isFalse);

    tracker.start(const Offset(8, 100), 400);
    expect(tracker.finish(const Offset(85, 210)), isFalse);
  });

  test('rejects short edge swipes', () {
    final tracker = EdgeSwipeBackTracker();
    tracker.start(const Offset(8, 100), 400);
    expect(tracker.finish(const Offset(60, 102)), isFalse);
  });

  testWidgets('widget invokes back only for a completed edge swipe',
      (tester) async {
    var backCount = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: AndroidEdgeSwipeBack(
          enabled: true,
          onBack: () async {
            backCount += 1;
            return true;
          },
          child: const SizedBox.expand(),
        ),
      ),
    );

    await tester.dragFrom(const Offset(8, 200), const Offset(100, 4));
    await tester.pump();
    expect(backCount, 1);

    await tester.dragFrom(const Offset(100, 200), const Offset(100, 4));
    await tester.pump();
    expect(backCount, 1);
  });
}
