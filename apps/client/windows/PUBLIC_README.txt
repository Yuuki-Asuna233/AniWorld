AniWorld 通用版 {{VERSION}}（Windows x64）

完整解压后运行 AniWorld.exe，保留同目录 DLL 和 data 文件夹。

默认服务器地址：http://127.0.0.1:3000。
首次打开点击“服务器连接设置”，填入自己部署的 AniWorld 地址。
跨设备连接需要使用可访问的局域网 IP 或服务器域名。

服务器设置 ACCESS_GATE_ENABLED=false 后无需访问密码。
账户登录与门禁分开，云端个人数据同步需要注册登录。
安装包不包含维护者的私人服务权限、模型密钥或用户数据。
模型、邮件和弹幕凭据在自己的服务器上配置；播放源为 AGE、DM84、enlie。
通用版使用独立的 AniWorld Community 数据目录，不导入私人版的设置。

系统依赖：
- Microsoft Visual C++ x64 运行库。缺少 vcruntime140.dll 或 msvcp140.dll
  时，请从微软官方安装对应的运行库：
  https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist
- Microsoft Edge WebView2 Runtime，用于播放源网页解析；WebView2Loader.dll
  不等同于完整运行时。安装说明：
  https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution

源码与部署说明：
https://github.com/Yuuki-Asuna233/AniWorld
https://github.com/Yuuki-Asuna233/AniWorld/blob/main/docs/getting-started.md

客户端遵循 GPL-3.0。组件许可及来源见 GPL-3.0.txt、LICENSING.md、
THIRD_PARTY_NOTICES.txt 和应用内的开源许可证页面。
