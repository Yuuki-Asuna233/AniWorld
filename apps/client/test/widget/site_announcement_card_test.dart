import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/bean/widget/site_announcement_card.dart';

void main() {
  testWidgets('opens the full announcement and can close it', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: SiteAnnouncementCard(
            title: '测试公告',
            summary: '点击查看详情',
            content: '这里是完整公告内容',
          ),
        ),
      ),
    );

    await tester.tap(find.text('点击查看详情'));
    await tester.pumpAndSettle();

    expect(find.text('测试公告'), findsOneWidget);
    expect(find.text('这里是完整公告内容'), findsOneWidget);

    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    expect(find.text('这里是完整公告内容'), findsNothing);
  });
}
