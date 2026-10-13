import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_modular/flutter_modular.dart';
import 'package:kazumi/bean/widget/embedded_native_control_area.dart';
import 'package:kazumi/pages/notifications/update_notification_controller.dart';
import 'package:kazumi/pages/router.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';

class ScaffoldMenu extends StatefulWidget {
  const ScaffoldMenu({super.key});

  @override
  State<ScaffoldMenu> createState() => _ScaffoldMenu();
}

class NavigationBarState extends ChangeNotifier {
  late int _selectedIndex = getDefaultSelectedIndex();
  bool _isHide = false;
  bool _isBottom = false;

  int get selectedIndex => _selectedIndex;

  bool get isHide => _isHide;

  bool get isBottom => _isBottom;

  int getDefaultSelectedIndex() {
    final defaultPage = GStorage.getSetting(SettingsKeys.defaultStartupPage);

    switch (defaultPage) {
      case "/tab/shiraha/":
        return 1;
      case "/tab/collect/":
        return 2;
      case "/tab/my/":
        return 3;
      case "/tab/popular/":
      default:
        return 0;
    }
  }

  void updateSelectedIndex(int pageIndex) {
    _selectedIndex = pageIndex;
    notifyListeners();
  }

  void hideNavigate() {
    _isHide = true;
    notifyListeners();
  }

  void showNavigate() {
    _isHide = false;
    notifyListeners();
  }
}

class _ScaffoldMenu extends State<ScaffoldMenu> {
  final PageController _page = PageController();
  final UpdateNotificationController _notificationController =
      Modular.get<UpdateNotificationController>();

  @override
  void dispose() {
    _page.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (context) => NavigationBarState(),
      child: Consumer<NavigationBarState>(
        builder: (context, state, _) {
          return OrientationBuilder(
            builder: (context, orientation) {
              // Keep desktop window controls in the rail, even in a narrow window.
              state._isBottom =
                  !Platform.isWindows && orientation == Orientation.portrait;
              return state.isBottom
                  ? bottomMenuWidget(context, state)
                  : sideMenuWidget(context, state);
            },
          );
        },
      ),
    );
  }

  Widget bottomMenuWidget(BuildContext context, NavigationBarState state) {
    return Scaffold(
      body: Container(
        color: Theme.of(context).colorScheme.primaryContainer,
        child: PageView.builder(
          physics: const NeverScrollableScrollPhysics(),
          controller: _page,
          itemCount: menu.size,
          itemBuilder: (_, __) => const RouterOutlet(),
        ),
      ),
      bottomNavigationBar: state.isHide
          ? const SizedBox(height: 0)
          : NavigationBar(
              destinations: <Widget>[
                const NavigationDestination(
                  selectedIcon: Icon(Icons.explore),
                  icon: Icon(Icons.explore_outlined),
                  label: '发现',
                ),
                const NavigationDestination(
                  selectedIcon: Icon(Icons.auto_awesome),
                  icon: Icon(Icons.auto_awesome_outlined),
                  label: '白羽',
                ),
                const NavigationDestination(
                  selectedIcon: Icon(Icons.favorite_rounded),
                  icon: Icon(Icons.favorite_border_rounded),
                  label: '追番',
                ),
                NavigationDestination(
                  selectedIcon: _buildMyNavigationIcon(selected: true),
                  icon: _buildMyNavigationIcon(selected: false),
                  label: '我的',
                ),
              ],
              selectedIndex: state.selectedIndex,
              onDestinationSelected: (int index) {
                state.updateSelectedIndex(index);
                Modular.to.navigate("/tab${menu.getPath(index)}/");
              },
            ),
    );
  }

  Widget sideMenuWidget(BuildContext context, NavigationBarState state) {
    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.surfaceContainer,
      body: Row(
        children: [
          EmbeddedNativeControlArea(
            child: Visibility(
              visible: !state.isHide,
              child: NavigationRail(
                backgroundColor: Theme.of(context).colorScheme.surfaceContainer,
                groupAlignment: 1.0,
                leading: _buildRailActions(context),
                labelType: NavigationRailLabelType.selected,
                destinations: <NavigationRailDestination>[
                  const NavigationRailDestination(
                    selectedIcon: Icon(Icons.explore),
                    icon: Icon(Icons.explore_outlined),
                    label: Text('发现'),
                  ),
                  const NavigationRailDestination(
                    selectedIcon: Icon(Icons.auto_awesome),
                    icon: Icon(Icons.auto_awesome_outlined),
                    label: Text('白羽'),
                  ),
                  const NavigationRailDestination(
                    selectedIcon: Icon(Icons.favorite_rounded),
                    icon: Icon(Icons.favorite_border_rounded),
                    label: Text('追番'),
                  ),
                  NavigationRailDestination(
                    selectedIcon: _buildMyNavigationIcon(selected: true),
                    icon: _buildMyNavigationIcon(selected: false),
                    label: const Text('我的'),
                  ),
                ],
                selectedIndex: state.selectedIndex,
                onDestinationSelected: (int index) {
                  state.updateSelectedIndex(index);
                  Modular.to.navigate("/tab${menu.getPath(index)}/");
                },
              ),
            ),
          ),
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.primaryContainer,
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(16.0),
                  bottomLeft: Radius.circular(16.0),
                ),
              ),
              child: ClipRRect(
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(16.0),
                  bottomLeft: Radius.circular(16.0),
                ),
                child: PageView.builder(
                  physics: const NeverScrollableScrollPhysics(),
                  itemCount: menu.size,
                  itemBuilder: (_, __) => const RouterOutlet(),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildRailActions(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final windowButtonStyle = IconButton.styleFrom(
      fixedSize: const Size.square(56),
      backgroundColor: colors.surfaceContainerHighest,
      foregroundColor: colors.onSurfaceVariant,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    );
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        FloatingActionButton(
          elevation: 0,
          heroTag: null,
          tooltip: '搜索',
          onPressed: () => Modular.to.pushNamed('/search/'),
          child: const Icon(Icons.search),
        ),
        if (Platform.isWindows &&
            !GStorage.getSetting(SettingsKeys.showWindowButton)) ...[
          const SizedBox(height: 8),
          IconButton.filledTonal(
            tooltip: '最小化',
            style: windowButtonStyle,
            onPressed: windowManager.minimize,
            icon: const Icon(Icons.remove),
          ),
          const SizedBox(height: 8),
          IconButton.filledTonal(
            tooltip: '退出 AniWorld',
            style: windowButtonStyle,
            onPressed: windowManager.close,
            icon: const Icon(Icons.close),
          ),
        ],
      ],
    );
  }

  Widget _buildMyNavigationIcon({required bool selected}) {
    return AnimatedBuilder(
      animation: _notificationController,
      builder: (context, _) {
        return Badge(
          isLabelVisible: _notificationController.unreadCount > 0,
          smallSize: 8,
          child: Icon(selected ? Icons.person : Icons.person_outline),
        );
      },
    );
  }
}
