# 从零部署服务并构建 Android APK

[项目首页](../README.md) · [客户端说明](../apps/client/README.md) · [进阶部署](development.md)

本指南以 Windows 电脑构建 APK、Android 手机连接自建服务为主线。服务端也可以部署在 Linux；构建和服务端运行不必在同一台机器上。下列命令除明确说明外，都在仓库根目录执行。

如果直接使用 [Android 安装包](https://github.com/Yuuki-Asuna233/AniWorld/releases/tag/android-v2.2.10) 或 [Windows 安装包](https://github.com/Yuuki-Asuna233/AniWorld/releases/tag/windows-v2.2.10)，服务端只需 Git、Node.js 和 npm，完成下面第 2—4 步后即可安装并填写服务器地址，不必准备 Flutter、Android Studio 或自己的签名。

公开版内置 **AGE、DM84、enlie** 三个客户端播放规则，不提供维护者的私人服务，也不需要配置额外的内置播放源账号。自建 API 负责门禁、目录、账户、进度和可选白羽；客户端查询所选规则的站点，通过本地 WebView 解析，再由本地播放器加载媒体。第三方站点的可达性、规则有效性、验证码和媒体速度仍会影响播放。

## 1. 准备环境并下载完整源码

- 安装 Git、Node.js 20.9+ 与 npm。
- 按 [Flutter 安装文档](https://docs.flutter.dev/install) 安装 **Flutter 3.44.3**，将 Flutter 的 `bin` 目录加入 PATH。本项目固定此版本，避免直接用另一版本替代后产生依赖或插件差异。
- 安装 Android Studio。在 SDK Manager 中安装 Android SDK Platform 36、稳定版 Build-Tools、Platform-Tools、Command-line Tools，以及 NDK **28.2.13676358**。需要查看具体版本时开启 Show Package Details，参考 [Android SDK Manager 文档](https://developer.android.com/studio/intro/update#sdk-manager)。
- 使用 JDK 17 构建，设置 `JAVA_HOME` 并将其 `bin` 加入 PATH；如果 Flutter 使用了另一 JDK，可用 `flutter config --jdk-dir "你的 JDK 17 目录"` 指定。
- 设置 `ANDROID_HOME` 指向 SDK 目录。Android Studio 的常见路径是 `%LOCALAPPDATA%\Android\Sdk`，以自己的 SDK Manager 显示为准。

设置 PATH 或环境变量后，重新打开 PowerShell，再执行：

```powershell
git clone https://github.com/Yuuki-Asuna233/AniWorld.git
cd AniWorld
node --version
flutter --version
flutter doctor -v
flutter doctor --android-licenses
```

处理 `flutter doctor` 中 Android toolchain 的问题。只构建 Android 时不要求修复 Windows Desktop / Visual Studio 项。客户端引用仓库根 `packages/`，不能只下载 `apps/client/`。

## 2. 创建自己的服务配置

```powershell
npm ci
npm run setup:env
```

第二条命令从模板生成私有 `.env` 和随机密钥，已有文件时拒绝覆盖。公开模板默认 `ACCESS_GATE_ENABLED=false`，连接服务不需要访问密码。需要限制访问时改为 true，并使用生成的 `ACCESS_GATE_PASSWORD`；未设置开关的旧部署仍保持门禁。不要将 `.env` 上传到 GitHub 或贴到反馈里。

首次只验证基础功能时，可以留空 LLM、Embedding、SMTP、Tavily 和弹幕服务凭据。它们分别影响白羽模型、向量检索、邮件发送、网页检索和弹幕，**不作为三个客户端规则播放的前置条件**。需要这些功能再按 [进阶指南](development.md) 配置。

## 3. 首次同步番剧资料，再启动 API

```powershell
npm run sync-full -- --start-year 2010 --end-year 2026
npm start
```

让这个终端保持运行。看到监听端口的启动日志后，在电脑浏览器打开 `http://127.0.0.1:3000`，默认可直接进入；开启门禁时输入 `.env` 中的访问密码。能够进入页面，说明服务已连通；页面内容齐全与播放是否可用还要继续检查。

首次推荐先同步 **2010—2026 年各季度**的番剧资料。同步需要访问 AniList，并尝试通过 OIAPI 补充中文名称，耗时较长；每季度最多读取 250 条候选记录，且会筛选地区、格式和内容，并非所有作品都会导入。结束时检查数据库条目数与上游网络错误，再运行 `npm start`。当前 `--batch` 只覆盖到 2026 年春季，不能代替这里的年份参数。

服务启动 60 秒后会后台同步近期季度，后续默认每 12 小时同步。观察日志中的 `[sync] Completed ... total upserted: ...`，结合首页内容判断；出现 Completed 但数量为 0 或有网络错误，不算导入成功。

后续只想更新近期番剧时，先在 API 终端按 Ctrl+C，确认服务退出，再运行：

```powershell
npm run sync
npm start
```

普通同步只更新近期季度，历史范围仍使用上面的年份命令。**不要同时运行 API 和同步脚本写同一个数据库，不要删除锁文件强行绕过，也不要加 `--clear` 清空已有目录。**

## 4. 先在手机上检查连接

电脑和手机连接同一局域网，在电脑执行 `ipconfig`，找到实际联网网卡的 IPv4，例如 `192.168.1.20`。在手机浏览器打开 `http://192.168.1.20:3000`，应该能看到首页或服务器开启的门禁页。

- 手机的 `127.0.0.1` / `localhost` 指向手机，不能用来访问电脑。
- 若手机打不开而电脑能打开，检查 Windows 防火墙是否允许 Node 服务在当前网络访问 TCP 3000，以及 Wi-Fi 是否开启客户端隔离或访客网络。
- Android Studio 常用模拟器访问宿主机使用 `http://10.0.2.2:3000`，它不是手机真机地址。
- 跨网络使用需要可达的服务器地址或 HTTPS 域名；电脑局域网地址不能直接跨公网使用。

先完成这一步再构建，能将网络问题与安装包问题区分开。

## 5. 获取 Flutter 依赖

```powershell
npm run app:install
```

首次需要访问 pub.dev 和 GitHub，部分插件使用固定 Git commit。默认使用 Flutter 标准 Pub cache；发布脚本也使用相同默认目录。若希望指定缓存，在安装依赖和发布前都设置同一值：

```powershell
$env:PUB_CACHE = "E:/Caches/Pub"
npm run app:install
```

发布脚本优先使用 `ANIWORLD_PUB_CACHE`，其次 `PUB_CACHE`，否则 `%LOCALAPPDATA%\Pub\Cache`。不要给安装和发布指定两个不同的空缓存。

只想调试时，连接开启 USB 调试的设备后可执行 `npm run app:run:android`；debug 使用调试签名，不需要下一步的正式签名。调试安装不能作为正式发行包。

## 6. 生成自己的正式签名

以下步骤只在首次创建签名时执行；已有自己维护的签名时复用原文件。签名和密码需要自行备份，后续更新继续使用同一签名。参见 [Flutter Android 签名文档](https://docs.flutter.dev/deployment/android#sign-the-app)。

```powershell
keytool -genkeypair -v -keystore apps/client/android/aniworld-release.jks -storetype JKS -keyalg RSA -keysize 3072 -validity 10000 -alias aniworld
```

按提示填写密码及证书信息。再读取证书 SHA-256 指纹，命令会提示输入 keystore 密码：

```powershell
keytool '-J-Duser.language=en' '-J-Duser.country=US' -list -v -keystore apps/client/android/aniworld-release.jks -alias aniworld
Copy-Item apps/client/android/key.properties.example apps/client/android/key.properties
```

编辑 `apps/client/android/key.properties`：

```properties
storeFile=aniworld-release.jks
storePassword=填写自己设置的密钥库密码
keyAlias=aniworld
keyPassword=填写自己设置的别名密码
expectedCertSha256=填写上一条命令输出的完整SHA256指纹
```

`storeFile` 相对 `apps/client/android/` 解析；绝对路径建议使用正斜杠，例如 `E:/Private/aniworld-release.jks`。指纹可以保留冒号，脚本会统一处理。模板中的提示文字必须替换为真实值。Java properties 中密码若包含反斜杠，需要转义为 `\\`。签名文件和配置已被 Git 忽略。

先检查环境和签名配置：

```powershell
npm run app:release -- -Version 2.2.10 -ValidateOnly
```

这只验证 SDK 签名工具及证书配置，不代表 APK 已构建或能播放。

## 7. 构建 APK 并安装

```powershell
npm run app:release -- -Version 2.2.10
```

默认在线解析依赖，从 GitHub 官方 release 下载播放器原生库，并核对 SHA-256；构建后检查 APK 签名及指纹。成功产物：`data/releases/AniWorld_android_2.2.10.apk`。目前发布脚本只生成 **arm64**，适合相应架构手机，不是 x86 模拟器安装包。

可以在构建时指定自己的默认服务地址：

```powershell
npm run app:release -- -Version 2.2.10 -ServerUrl "http://192.168.1.20:3000"
```

未指定时默认 `http://127.0.0.1:3000`，安装后仍可在门禁页修改。局域网 IP 可能变化；向其他人发行时应使用其能访问的地址，或让其手动配置自建服务。安装包不包含模型 Key 和门禁密码。

将 APK 传到手机安装，或开启 USB 调试后执行 `adb install -r data/releases/AniWorld_android_2.2.10.apk`。如果手机已安装同 applicationId、另一签名的包，Android 不能直接覆盖；先备份本地数据再决定是否卸载旧包。

原生库下载失败时，先检查 GitHub 连接。需要镜像时自行选择可信的 URL 前缀，设置 `ANIWORLD_DOWNLOAD_MIRROR`；脚本会先请求官方地址，再将完整官方 URL 拼接到该前缀之后，并仍校验固定哈希。仓库不强制使用某个镜像。

`-Offline` 供已有 Pub 和原生库缓存时使用；首次不要加这个参数。Gradle / Maven 等其他工具链仍可能需要联网，不应将其当作整套构建的完全离线保证。

## 8. 连接、选源并检查首次播放

1. 打开 App，在门禁页点击 **服务器连接设置**，填入步骤 4 验证过的地址。
2. 无门禁的服务器连接后直接进入。仅开启门禁时输入 `ACCESS_GATE_PASSWORD`，它与账户登录密码不同。
3. 打开有数据的首页或搜索作品，进入详情，点击 **开始观看**。
4. 在 **AGE、DM84、enlie** 中选择有匹配结果的源，确认作品和季度，再选择集数播放。站内搜索结果是目录资料，不表示三个源都收录了这部作品。
5. 确认画面、声音、播放进度和缓冲进度正常；再尝试暂停继续、切换集数和拖动进度。能看到首页不等于媒体线路已经验证通过。

连接后，本地追番和历史可以先用；云端个人数据同步需要注册登录。SMTP 未配置时验证码只写在服务端控制台，正式向他人提供注册应配置邮件服务。白羽未配置模型时不会提供完整模型对话。

白羽发起播放会打开同一个客户端选源面板，保留指定集数或续播意图。旧记录若指向已移除的内置源，需要重新选源；已完成的本地下载不依赖该在线源。

## 常见问题

| 现象 | 排查方向 |
|---|---|
| API 启动报密钥或门禁错误 | 首次用 `npm run setup:env`；已有配置按模板要求修改，不要覆盖旧密钥 |
| 首页为空 | 检查同步日志和上游连通性，必要时停止 API 后主动同步 |
| 手机无法连接服务 | 先用手机浏览器检查同一地址；核对网卡 IP、防火墙、端口和网络隔离 |
| keytool / apksigner 找不到 | 检查 JDK PATH / JAVA_HOME、ANDROID_HOME、SDK Build-Tools |
| pub get / 原生库下载失败 | 检查 pub.dev、GitHub 网络和自定义缓存设置；首次使用在线构建 |
| 签名指纹不符 | 核对别名、keystore 和 expectedCertSha256，不要临时换钥匙绕过 |
| 某个源无结果、要求验证码或转圈 | 区分站内目录与客户端源查询；检查规则、源站连接，完成验证码或换源 |
| 旧内置源记录不能续播 | 返回详情重新选择三个源之一，不需要配置旧源凭据 |

网页版保留目录、账户和白羽等服务；旧内置播放接口已移除，本指南的播放流程以 Android / Windows 客户端三种规则为准。不要把旧网页播放入口当作部署成功的验收项。

Windows ZIP 的构建说明见 [客户端 README](../apps/client/README.md)，公网 HTTPS、Nginx 流式代理、数据备份和单实例运行见 [进阶部署](development.md)。
