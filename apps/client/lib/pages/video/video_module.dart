import 'package:kazumi/pages/video/video_page.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/pages/video/video_controller.dart';

class VideoModule extends Module {
  @override
  void routes(r) {
    r.child("/", child: (_) {
      final argument = Modular.args.data;
      return VideoPage(
        videoPageController: argument is VideoPageController
            ? argument
            : Modular.get<VideoPageController>(),
      );
    });
  }
}
