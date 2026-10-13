import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/card/network_img_layer.dart';
import 'package:kazumi/bean/dialog/dialog_helper.dart';
import 'package:kazumi/modules/bangumi/bangumi_item.dart';
import 'package:kazumi/utils/device.dart';

// 视频卡片 - 垂直布局
class BangumiCardV extends StatelessWidget {
  const BangumiCardV({
    super.key,
    required this.bangumiItem,
    this.canTap = true,
    this.enableHero = true,
    this.onTap,
  });

  final BangumiItem bangumiItem;
  final bool canTap;
  final bool enableHero;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      clipBehavior: Clip.antiAlias,
      margin: EdgeInsets.zero,
      child: GestureDetector(
        child: InkWell(
          onTap: () {
            if (!canTap) {
              KazumiDialog.showToast(
                message: '编辑模式',
              );
              return;
            }
            final customOnTap = onTap;
            if (customOnTap != null) {
              customOnTap();
              return;
            }
            Modular.to.pushNamed('/info/', arguments: bangumiItem);
          },
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AspectRatio(
                aspectRatio: 0.65,
                child: LayoutBuilder(builder: (context, boxConstraints) {
                  final double maxWidth = boxConstraints.maxWidth;
                  final double maxHeight = boxConstraints.maxHeight;
                  final cover = BangumiCover(
                    bangumiItem: bangumiItem,
                    width: maxWidth,
                    height: maxHeight,
                  );
                  return enableHero
                      ? Hero(
                          transitionOnUserGestures: true,
                          flightShuttleBuilder:
                              NetworkImgLayer.heroFlightShuttleBuilder,
                          tag: bangumiItem.heroTag,
                          child: cover,
                        )
                      : cover;
                }),
              ),
              BangumiContent(bangumiItem: bangumiItem)
            ],
          ),
        ),
      ),
    );
  }
}

class BangumiCover extends StatelessWidget {
  const BangumiCover({
    super.key,
    required this.bangumiItem,
    required this.width,
    required this.height,
  });

  final BangumiItem bangumiItem;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final progress = bangumiItem.releaseProgressText;
    return Stack(
      fit: StackFit.expand,
      children: [
        NetworkImgLayer(
          src: bangumiItem.images['large'] ?? '',
          fallbackSrc: bangumiItem.images['fallback'],
          width: width,
          height: height,
        ),
        if (progress.isNotEmpty)
          Positioned(
            right: 5,
            bottom: 5,
            child: Container(
              constraints: BoxConstraints(maxWidth: width - 10),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.72),
                borderRadius: BorderRadius.circular(5),
              ),
              child: Text(
                progress,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 10,
                  height: 1.05,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class BangumiContent extends StatelessWidget {
  const BangumiContent({super.key, required this.bangumiItem});

  final BangumiItem bangumiItem;

  @override
  Widget build(BuildContext context) {
    final ts = MediaQuery.textScalerOf(context);

    final int maxTextLines = isDesktop()
        ? 3
        : (isTablet() &&
                MediaQuery.of(context).orientation == Orientation.landscape)
            ? 3
            : 2;

    return Expanded(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(5, 3, 5, 1),
        child: Text(
          bangumiItem.nameCn,
          textAlign: TextAlign.start,
          style: const TextStyle(
            fontWeight: FontWeight.w500,
            letterSpacing: 0.3,
          ),
          textScaler: ts.clamp(maxScaleFactor: 1.1),
          maxLines: maxTextLines,
          overflow: TextOverflow.ellipsis,
        ),
      ),
    );
  }
}
