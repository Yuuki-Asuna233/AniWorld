# AniWorld 客户端

AniWorld 的 Flutter 客户端，基于 [Predidit/Kazumi](https://github.com/Predidit/Kazumi) 改造，接入本仓库的目录、账户、观看进度、白羽 Agent 和更新服务。

[从零部署与首次播放](../../docs/getting-started.md) · [返回项目首页](../../README.md) · [服务端与部署](../../docs/development.md) · [Agent 实现](../../baiyu_agent/README.md)

## 支持范围

当前正式构建目标是 **Android 和 Windows**。其他平台保留的上游工程文件不代表已完成 AniWorld 适配，也没有在本仓库提供对应的正式发布流程。

- Android 发布脚本当前生成 arm64 APK。
- Windows 发布脚本生成 ZIP，包含程序、DLL、data 和其他运行资源。
- 番剧源、投屏、外部播放器、超分辨率等能力还受平台及源站条件影响。

公开源码使用平台系统字体，不单独分发 MiSans 字体文件；截图可能来自使用原字体的私人构建。MiSans 的使用条款见 [官方许可说明](https://hyperos.mi.com/font/zh/download/)。

界面截图见[项目首页](../../README.md#界面预览)，图片位于 [static/screenshot](static/screenshot)。

## 安装与连接

安装部署者提供的 **AniWorld** 安装包。上游 Kazumi 的 Releases、F-Droid、Flathub 等渠道不提供本项目的安装包。

Windows 将 ZIP 完整解压到可写目录后运行；更新时使用完整的新包，不要只替换 exe。

Windows 系统需具备 [Visual C++ x64 运行库](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) 和 [WebView2 Runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)；包内 README 提供缺少依赖时的安装说明。

公开版默认使用本地服务地址，不附带维护者的私人服务权限。首次打开可设置自己的服务端地址，无门禁的服务器连接后直接进入：

- 电脑本地开发可使用 `http://localhost:3000`。
- 真机使用电脑的局域网 IP 或自己的 HTTPS 服务域名；手机的 localhost 指向手机自身。
- Android 模拟器访问宿主机通常使用 `http://10.0.2.2:3000`。
- 确认防火墙和监听端口允许设备连接。使用不同网络时，服务地址必须能跨网络访问。

需要同步云端个人数据时注册登录。若服务器开启门禁，还需部署者提供的访问密码。公开 Android 包使用 com.aniworld.community，Windows 使用独立的 AniWorld Community 数据目录，可与私人版分别使用。

## 构建环境

- Flutter **3.44.3**，Dart SDK 范围以 [pubspec.yaml](pubspec.yaml) 为准。
- Android SDK Platform 36、稳定版 Build-Tools、JDK 17 和 NDK 28.2.13676358；正式 APK 还需自己的签名。
- Windows 需要 Visual Studio C++ 桌面开发组件、Flutter Windows Desktop 工具链与符号链接支持。
- 完整仓库：客户端引用根目录 [packages](../../packages) 下的播放器 path dependencies，不能只复制 `apps/client`。
- 发布脚本默认在线准备依赖，并发现标准 Pub cache；可设置 `ANIWORLD_PUB_CACHE` 或 `PUB_CACHE`。Windows 构建缓存默认在 LOCALAPPDATA 下，可通过 `ANIWORLD_BUILD_CACHE` 指定。

签名字段参考 [key.properties.example](android/key.properties.example)，复制为私有 key.properties 后填入自己的配置。

Android debug 构建使用调试签名，不要求私有 `key.properties`；release 构建必须配置自己的正式签名。发布脚本校验签名证书和 APK 指纹，生成及配置步骤见 [入门指南](../../docs/getting-started.md#6-生成自己的正式签名)。同一发行渠道后续升级需保持签名一致。

## 本地运行

以下命令在**仓库根目录**执行：

```powershell
npm run app:install
npm run app:run:android
```

Android 运行需要已连接设备。Windows 使用 `npm run pc:run`。两种平台共用同一 Flutter 工程，`pc:install` 和 `app:install` 均执行 `flutter pub get`。

## 正式发布

以下包装脚本在 Windows PowerShell 中运行，SDK 从 ANDROID_HOME、ANDROID_SDK_ROOT、Flutter 本地配置或标准目录发现，JDK 工具从 JAVA_HOME、PATH 或 Android Studio 标准目录发现。首次使用在线模式；`-Offline` 只用于已有依赖与原生库缓存。Android 签名校验可加 `-ValidateOnly`，两种平台都可加 `-ServerUrl "https://自己的服务域名"` 指定默认服务。


以下版本号只是示例，实际发布应递增版本，并在仓库根目录执行：

```powershell
npm run app:release -- -Version 2.2.9
npm run pc:release -- -Version 2.2.9
```

| 平台 | 输出 |
|---|---|
| Android | `data/releases/AniWorld_android_2.2.9.apk` |
| Windows | `data/releases/AniWorld_windows_2.2.9.zip` |

脚本将版本写入 Flutter 构建参数和 `APP_VERSION`。当前 [pubspec.yaml](pubspec.yaml) 的默认版本仍是 `2.1.10+20110`，直接执行普通 `flutter build` 不等于生成最新版发布包；根 `package.json` 的 `1.0.0` 也不是客户端版本。

发布安装包到服务端是独立步骤：将产物放入 `APP_RELEASE_DIR`，再检查平台更新接口。修改客户端代码需要重新打包安装，仅更新 API 不会更新本地播放器、缓存和 UI。

## 代码入口

| 路径 | 职责 |
|---|---|
| [lib/pages](lib/pages) | 发现、详情、搜索、播放、设置、白羽等页面及页面状态 |
| [lib/modules](lib/modules) | 番剧、追番、历史与其他共享模块 |
| [lib/request](lib/request) | API 地址、网络请求和接口封装 |
| [lib/services](lib/services) | 访问控制、播放及其他独立服务 |
| [lib/bean](lib/bean) | 数据模型 |
| [assets](assets) | 规则、着色器、图像与声明资源 |
| [../../packages](../../packages) | 定制播放器与平台插件 |

## 播放与反馈

公开版内置 AGE、DM84、enlie 三种规则，由客户端搜索站点、解析集数和媒体地址，本地播放器请求媒体。后端目录提供元数据，不代表所选规则有对应作品。特定源可能需要请求头、验证码或清单适配。缓存效果受媒体格式、源站速度、链接有效期和本地存储影响。

反馈问题请同时提供平台、安装包来源、发生时间、番剧与集数、源与线路、网络类型，以及转圈、闪退或画面掉帧等具体表现。不同构建即使使用同一版本号，也可能包含不同修改。

## 数据与外部服务

本项目存在账户、观看记录、对话记忆、播放诊断和 Agent 遥测功能，不能沿用上游“完全不收集用户数据”的声明。使用白羽时，按功能需要发送的上下文会交给部署者配置的模型服务；外部检索也可能访问配置的第三方服务。数据保留与服务配置由部署者管理。

## 致谢与许可证

感谢 [Kazumi](https://github.com/Predidit/Kazumi) 和 media-kit 及其相关 fork。客户端保留 [GPL-3.0 许可证](LICENSE)，播放器组件以其各自许可证为准。上游的签名资助、素材授权和发行渠道不能自动视为 AniWorld 的授权或发行安排。
