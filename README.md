# 投屏助手 Cast Receiver for webOS TV

**简体中文** · [English](README.en.md)

一个面向 **LG webOS TV**（含国行机型）的开源局域网投屏接收器：手机上的视频 / 音乐 / 图片 App 通过标准的 **DLNA / UPnP** 协议把内容投到电视播放，并附带一个手机网页遥控器、扫码连 WiFi 二维码与电视端设置面板。

纯 JavaScript 实现（webOS 网页应用 + 后台 JS 服务），无需 root、无需改动系统组件。

- **DLNA Renderer**：完整的 UPnP MediaRenderer 实现（SSDP 发现 + SOAP 控制 + GENA 事件）
- **手机遥控**：电视待机页出示二维码，扫码即可在手机上遥控播放、推送链接、调节音量
- **扫码连 WiFi**：待机页同时出示 WiFi 入网二维码，iPhone / 安卓通用
- **AirPlay**：国行机型出厂即不支持，应用内主动探测并明确告知（见 [AirPlay 支持情况](#airplay-支持情况)）

## 目录

- [功能特性](#功能特性)
- [系统要求与兼容性](#系统要求与兼容性)
- [工作原理](#工作原理)
- [项目结构](#项目结构)
- [安装使用](#安装使用)
- [开发指南](#开发指南)
- [接口一览](#接口一览)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [AirPlay 支持情况](#airplay-支持情况)
- [参与贡献](#参与贡献)
- [许可证](#许可证)
- [参考](#参考)

## 功能特性

### 投屏播放（DLNA / UPnP MediaRenderer）

- **设备发现**
  - 应答 `M-SEARCH` 探测：支持 `ssdp:all` / `upnp:rootdevice` / `uuid:` / 设备与服务类型查询，随机 MX 延迟、双包应答
  - 周期性 `NOTIFY ssdp:alive` 心跳（30 秒间隔）+ 退出时 `ssdp:byebye`；IP 变化自动重新广播
  - udp/1900 被电视内置 DLNA 栈占用时，自动降级为「仅广播」模式并在界面提示
- **AVTransport 全套控制**：`SetAVTransportURI`、`SetNextAVTransportURI`、`Play`、`Pause`、`Stop`、`Seek`、`Next`、`Previous`、`SetPlayMode`、`GetTransportInfo`、`GetPositionInfo`、`GetMediaInfo`、`GetDeviceCapabilities`、`GetTransportSettings`、`GetCurrentTransportActions`、`GetSearchCapabilities`、`GetSortCapabilities`
- **RenderingControl**：`GetVolume` / `SetVolume` / `GetMute` / `SetMute` / `ListPresets` / `SelectPreset`
- **ConnectionManager**：`GetProtocolInfo` / `GetCurrentConnectionIDs` / `GetCurrentConnectionInfo`
- **GENA 事件**：`SUBSCRIBE` / `UNSUBSCRIBE` / `NOTIFY`，完整 LastChange 变量集、订阅初始通知、过期自动清理
- **播放队列**：视频 App 连续投多个任务自动入队（上限 200 条），支持整队推送、点选切曲、上一曲/下一曲
- **循环模式**：顺序 / 列表循环 / 单曲循环 / 随机，与手机 App 双向同步
- **字幕**：App 推送的 SRT / VTT 字幕自动转换加载；内置字幕代理（`/proxy`）绕过跨域限制
- **错误回报**：播放失败自动上报 `TransportStatus=ERROR`，手机 App 能即时感知；网络错误自动重试一次
- **容错**：畸形请求（把 DIDL 塞进 URI 字段）自动恢复、HTTP 端口冲突自动顺延

### 全屏播放器（电视端）

- **三种呈现模式**：视频（全屏）/ 音乐（封面 + 标题 + 进度）/ 图片（全屏轮显）
- **进度条控制**：
  - 电视遥控器：方向键 ←/→ 快退/快进 10 秒，媒体键 ⏪/⏩ 跳 30 秒
  - 魔术遥控器指针（或鼠标）点击进度条任意位置精确跳转
- **结束投屏**：播放时左上角常驻「结束投屏」按钮，一键清空队列回到待机页
- **退出保护**：遥控器返回键需按两次才退出应用，防止误触中断投屏
- **系统音量**：通过 Luna 调用电视真实系统音量（`luna://com.webos.audio`），电视遥控器音量键的变化也会实时同步给手机 App

### 手机网页遥控器

扫电视待机页二维码直达（`http://电视IP:49153/`），无需安装任何 App：

- 播放/暂停/停止/上一曲/下一曲
- 进度拖动与时间显示
- 音量滑杆与静音
- 循环模式切换
- 粘贴直链（视频/音乐/图片 URL）直接推送到电视
- 播放队列管理（点击切曲）
- 修改电视设备名称、设置 WiFi 名称与密码
- 长轮询实时同步，断线自动重连并提示

### 扫码连 WiFi

待机页出示标准 `WIFI:` 格式二维码，访客扫码即可加入电视所在的局域网：

- **iPhone**：直接用相机扫码 → 自动弹出「加入网络」→ 一键连接
- **安卓**：Android 10+ 在「WiFi 设置 → 扫描」中识别；多数国产手机相机也直接支持
- **SSID 自动识别**：电视以无线方式联网时自动读取当前 SSID（每 60 秒刷新）；有线连接时可手动填写
- **中文支持**：二维码采用 UTF-8 编码（修正了二维码库默认的 Latin-1 编码导致中文乱码的问题），SSID/密码支持中文与特殊字符（按规范转义 `\ ; , : "`）
- **密码安全**：系统不允许应用读取已保存的 WiFi 密码，因此密码需在电视端或手机遥控页填写一次；密码仅保存在电视本地，且**只通过 Luna 通道（本机应用）**返回给电视端绘制二维码，面向局域网的 HTTP 接口只暴露 `hasPassword` 标记，不返回密码明文

### 设置面板（电视端）

待机页「设置」按钮打开，可用电视遥控器完成全部操作：

| 设置项 | 说明 |
| --- | --- |
| 设备名称 | 手机投屏列表显示的名称；默认自动识别电视型号（如「LG OLED77C5PCA」），可自定义，留空保存恢复默认 |
| WiFi 连接二维码 | SSID（自动识别可改）+ 密码；保存后待机页二维码立即更新 |
| 手动推送链接 | 调试用：直接输入媒体 URL 在电视上播放 |
| 使用帮助 | 搜不到设备、支持格式等常见问题 |
| 关于 | 应用信息与 AirPlay 探测结果 |

### 性能与稳定性

- 待机页静态 CSS 背景（无渐变动画 / 毛玻璃），长轮询仅在状态变化时推送数据
- 实测（LG OLED77C5PCA，webOS 10.3.1，待机页）：

  | 指标 | 优化前 | 优化后 |
  | --- | --- | --- |
  | 待机 CPU | 99.2% | ~0.3% |
  | 内存 RSS | 671 MB | 47 MB |

## 系统要求与兼容性

- **电视**：LG webOS TV（国行/海外均可），实测 webOS 10.3.1；代码按 webOS 4.x+ 兼容（ES5 语法、Node 0.12+ API）
- **电视端开启开发者模式**（安装应用需要）
- **手机**：与电视处于同一局域网；任何支持 DLNA 投屏的 App（爱奇艺、腾讯视频、优酷、哔哩哔哩、网易云音乐等），或直接使用网页遥控器
- **支持的媒体格式**（受 webOS 内置浏览器内核限制）：
  - 视频：MP4 (H.264/H.265)、HLS (m3u8)、MKV、TS
  - 音乐：MP3、AAC、FLAC、WAV、OGG
  - 图片：JPG、PNG、GIF、BMP、WebP
  - 字幕：SRT / VTT

## 工作原理

```
手机投屏 App ──SOAP(AVTransport/RenderingControl)──► 后台 JS 服务 ◄──长轮询 /status── 电视端前端
                │                                    │
                └──SSDP 发现 + GENA 事件──────────────┘        电视前端调用 Luna 设置系统音量
```

1. 后台 JS 服务启动，HTTP 从 `49152` 起探测第一个空闲端口（国行机型上 49152 被电视内置 DLNA 占用，实测绑定 **49153**）
2. 加入 SSDP 组播（239.255.255.250:1900），广播 alive；手机 App 发 `M-SEARCH` 即可发现
3. 手机 App 读取 `device-description.xml`，随后发送 `SetAVTransportURI` → `Play` 等 SOAP 指令
4. 电视前端通过 `/status` 长轮询感知变化（毫秒级），将媒体装载到 `<video>/<img>` 播放
5. 前端每秒回报播放进度，控制器 / App 实时显示

## 项目结构

```
├── README.md                       # 中文文档
├── README.en.md                    # 英文文档
├── LICENSE                         # MIT 许可证
├── app/                            # webOS 应用目录
│   ├── appinfo.json                # 应用元数据（版本等）
│   ├── index.html / styles.css / app.js  # 电视端前端（待机页 + 播放器 + 设置面板 + HUD）
│   ├── qr.js                       # 内嵌二维码生成库（MIT, Kazuhiko Arase）
│   └── icon.png / largeIcon.png / bgImage.png  # 应用图标资源（脚本生成）
├── packageinfo.json                # 组合打包信息（应用 + 服务）
├── scripts/
│   ├── gen-assets.js               # 图标生成脚本（node scripts/gen-assets.js）
│   ├── bump-version.js             # 版本号一键更新（见「开发指南」）
│   └── controller-simulator.js     # 手机投屏模拟器（本地端到端测试）
├── dist/                           # ares-package 构建输出
├── docs/AIRPLAY_BRIDGE.md          # AirPlay 桥接方案（root + UxPlay）
└── services/com.castreceiver.tv.service/
    ├── service.js                  # 后台服务（SSDP + UPnP + HTTP + Luna）
    ├── remote.html                 # 手机遥控页（由服务在 HTTP 端口提供）
    ├── services.json               # Luna 服务声明
    └── package.json                # 服务元数据
```

## 安装使用

### 终端用户（开发者模式安装）

1. 电视应用列表打开「开发者模式」App → 登录 LG 账号 → 开启 Dev Mode（保持开启）
2. 电脑安装 LG 官方 CLI 并配置电视：

   ```bash
   npm install -g @webos-tools/cli
   # IP 换成你电视的局域网 IP；新版 webOS 的 Dev SSH 端口是 9922
   # 私钥即开发者模式生成的 SSH 密钥（Passphrase 为 Dev Mode 的 6 位码）
   ares-setup-device --add tv --host 192.168.1.23 --port 9922 --username prisoner --privatekey ~/.ssh/webos_dev_key
   ```

3. 下载本仓库，打包安装：

   ```bash
   ares-package ./app ./services/com.castreceiver.tv.service -o dist
   ares-install --device tv ./dist/com.castreceiver.tv_<版本>_all.ipk
   ares-launch --device tv com.castreceiver.tv
   ```

4. 打开「投屏助手」并保持前台：手机 App 点投屏按钮选本电视，或扫待机页二维码用网页遥控器

> 更新版本后必须**彻底关闭再重开应用**（webOS 会缓存运行中的网页应用）——见 [已知限制](#已知限制)。

## 开发指南

### 环境准备

- Node.js（任意较新版本；`ares-*` 工具链经 npm 安装）
- 真机调试需要电视开启开发者模式并完成 `ares-setup-device`

### 本地测试（无需电视）

**webOS TV 模拟器（图形界面）**

1. 从 LG 开发者网站下载 webOS TV Simulator
2. 主窗口「Open App」选择本项目的 `app/` 目录（含 appinfo.json 的目录即可）
3. 「Open Service」选择 `services/com.castreceiver.tv.service/` 目录
4. 模拟器会自动安装 `webos-service` 垫片，让 JS 服务在桌面运行

**命令行 + 投屏模拟器**

```bash
# 1. 启动后台服务（需要 webos-service 模块或其垫片）
cd services/com.castreceiver.tv.service
node service.js

# 2. 浏览器直接打开 app/index.html 预览电视端 UI

# 3. 运行投屏模拟器（SSDP 发现 → 设备描述 → 推片 → 播放 → 音量 → 暂停 → 切图）
node scripts/controller-simulator.js [电视IP]
```

### 代码约定

- 代码与注释使用**英文**，界面文案使用**中文**（`index.html` / `remote.html` / 提示语）
- 后台服务必须兼容 webOS 旧内核：**ES5 语法**、避免新式 Node API
- 两个 `DEBUG` 开关（`app.js` / `service.js` 顶部）默认 `true`，发布前改为 `false` 即静默

### 版本号管理

版本号同步出现在 6 处（两个 JSON 元数据、`service.js` 的 `VERSION` 常量、`app.js` 页脚、`index.html` 静态页脚）。改动后执行：

```bash
node scripts/bump-version.js 0.0.2
```

### 重新生成图标资源

```bash
node scripts/gen-assets.js
```

### 调试日志

应用与服务默认处于 **DEBUG 模式**，输出分类日志用于排查投屏问题：

- 后台服务：`[ssdp]`（发现广播/M-SEARCH）、`[soap]`（控制器指令）、`[gena]`（事件订阅/通知）、`[state]`（状态机迁移）、`[api]`（前端控制 API）、`[airplay]`（能力探测）、`[boot]`（启动/配置）
- 前端：`[boot]`（服务发现）、`[media]`（换片加载）、`[transport]`（播放/暂停同步）、`[seek]`、`[volume]`、`[player]`（真实播放器事件）、`[remote]`（遥控器按键）、`[poll]`

```bash
# 前端 console（同时附带 DevTools）
ares-inspect --device tv com.castreceiver.tv

# 后台服务日志（经 syslog，也可在电视「开发者模式 → Log Viewer」查看）
ares-inspect --device tv --service com.castreceiver.tv.service
```

## 接口一览

### HTTP（局域网，供前端/遥控页/调试使用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status`（可带 `?rev=N&wait=15` 长轮询、`?light=1` 精简） | 全量状态（媒体/进度/音量/队列/WiFi/AirPlay） |
| GET | `/` | 手机遥控页 |
| GET | `/device-description.xml`、`/scpd/*` | UPnP 设备描述与服务描述 |
| POST | `/upnp/control/*`、`/upnp/event/*` | SOAP 控制与 GENA 订阅 |
| GET | `/proxy?url=…` | 字幕代理（SRT/VTT 转换） |
| GET | `/health` | 健康检查 |
| POST | `/renderer/play` | 播放直链 `{url, title?, mediaType?}` |
| POST | `/renderer/queue` | 整队推送 `{items:[…]}` |
| POST | `/renderer/jump` | 切到队列第 N 项 `{index}` |
| POST | `/renderer/next` / `/renderer/previous` | 上一曲/下一曲 |
| POST | `/renderer/stop` / `/renderer/seek` / `/renderer/state` | 停止 / `{position}` 秒跳 / 播放态回报 |
| POST | `/renderer/volume` / `/renderer/mute` | 音量 `{volume:0-100}` / 静音 `{mute}` |
| POST | `/renderer/repeat` | 循环模式 `{mode:NORMAL\|REPEAT_ALL\|REPEAT_ONE\|SHUFFLE}` |
| POST | `/renderer/device-name` | 设备名 `{name}`（空串恢复默认） |
| POST | `/renderer/wifi` | WiFi 二维码信息 `{ssid?, password?}`（`password:null` 清除） |
| POST/GET | `/renderer/airplay` | 手动触发 AirPlay 探测 |

所有 `/renderer/*` 接口的响应都是最新状态（等同 `/status`）。

### Luna（`luna://com.castreceiver.tv.service/`，仅电视本机）

| 方法 | 说明 |
| --- | --- |
| `status` | 全量状态（可订阅） |
| `play` / `stop` / `next` / `previous` | 播放控制 `{url?}` |
| `volume` / `mute` | 音量与静音 |
| `device-name` | 读取/设置设备名 |
| `wifi` | 读取 WiFi 二维码信息（**唯一会返回密码明文的通道**，仅限本机应用） |
| `airplay` | 触发 AirPlay 探测 |

## 已知限制

在真实电视上迭代时，有几个 webOS 平台行为必须了解：

1. **更新后必须彻底重开应用**：webOS 会缓存运行中的网页应用，`ares-launch` 只把旧页面切到前台，新代码不会生效。更新后先在电视上退出应用（返回键两次）或用命令关闭，再重新启动：

   ```bash
   # 关闭（在电视侧执行，也可用 Dev Manager：Close app）
   luna-send-pub -n 1 luna://com.webos.applicationManager/close '{"appId":"com.castreceiver.tv"}'
   ares-launch --device tv com.castreceiver.tv
   ```

2. **JS 服务需要一次「唤起」**：webOS 的按需服务在应用首次调用 Luna 时启动。本服务启动后会在平台内持有一个常驻 activity，因此之后不会再被 5 秒闲置定时器回收；应用侧同时保留 Luna 订阅作为第二重保活。

3. **Luna 通道**：电视平台对网页应用提供 `PalmServiceBridge` / `navigator.service`，并不自动注入 `webOS.js`（本项目也未打包该文件）。前端内置多级回退（webOS.js（若存在）→ navigator.service → PalmServiceBridge），系统音量/静音、服务保活、型号上报均依赖此通道；可通过 `/status` 的 `appLuna` / `appBridge` 字段确认。

4. **udp/1900 端口**：近年国行机型的 udp/1900 被电视自有 DLNA 栈长期占用，本服务会自动降级为「仅广播（NOTIFY alive）」模式并在界面提示；这是非 root 条件下的平台限制。手机 App 若只发 M-SEARCH 可能搜不到，可改用手机遥控页或手动添加 IP。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 手机搜不到设备 | 确认同一 Wi-Fi；关闭路由器 AP 隔离/访客网络隔离；保持应用前台运行后重开投屏列表 |
| 待机页显示「SSDP 端口被电视占用」 | 电视内置 SmartShare 占用了 1900 端口，服务已自动降级为广播模式；部分只发 M-SEARCH 的 App 可能搜不到，属系统限制 |
| 视频黑屏无声音 | 该格式（如 AVI/WMV/FLV）浏览器内核不支持，换 MP4/H.264 片源 |
| 投屏卡顿 | 检查 Wi-Fi 信号；4K 片源建议 5G 频段或有线回程 |
| 字幕不显示 | 部分链接需校验 Referer 导致字幕取回失败，可尝试直链为 MP4 + 同名 .vtt |
| 扫 WiFi 二维码没反应 | 安卓需在「WiFi 设置 → 扫描」中扫（部分国产相机也可直接扫）；仅填了 SSID 未填密码时，扫码后需手动输入密码 |
| 更新后界面没变化 | webOS 缓存了旧页面——彻底关闭应用（返回键两次或 luna-send-pub close）再启动 |

## AirPlay 支持情况

AirPlay 接收端属于 Apple MFi 授权生态，协议栈私有且需认证，webOS 前端 + JS 服务的形态无法合规实现。国行 LG 电视出厂即未包含 AirPlay 接收端协议栈，**应用无法将其重新打开**——不存在隐藏开关。本项目采取的做法是「主动探测 + 明确告知」：

- 服务启动 4 秒后自动探测，并每 10 分钟复测（也可通过 `GET/POST /renderer/airplay` 或 Luna `airplay` 方法手动触发）
- 三个独立信号：本机 mDNS 对 `_airplay._tcp` / `_raop._tcp` 查询的应答、本机 7000/7001/7100 端口监听、典型接收端特征文件
- 结论（`present` / `partial` / `absent`）通过 `/status` 回传，电视端「设置 → 关于」中展示
- 局域网内发现 AirPlay 应答者时会明确标注「可能属于其他设备（如 iPhone）」，不误报

若探测为 `absent`（国行为常态），请使用 DLNA 投屏路径。

**想彻底解决 AirPlay？** 参见 [docs/AIRPLAY_BRIDGE.md](docs/AIRPLAY_BRIDGE.md)——root 之后移植开源 UxPlay 接收端的完整方案（含音频优先 / MSE 桥 / 原生硬解三条路线与工作量评估）。

## 参与贡献

欢迎 Issue 与 Pull Request：

- 提交前请运行本地测试（见 [开发指南](#开发指南)），并保证 `node --check` 通过
- 遵循现有代码约定（英文代码注释、中文界面文案、服务端 ES5）
- 新功能请同步更新两份 README 与接口一览

## 许可证

[MIT](LICENSE)

## 参考

- LG webOS TV JS services: https://webostv.developer.lge.com/develop/guides/js-service-basics
- LG JS service packaging rules: https://webostv.developer.lge.com/develop/guides/js-service-usage
- UPnP AVTransport / RenderingControl / ConnectionManager specs (UPnP Device Architecture 1.0)
- Apple MFi overview: https://mfi.apple.com/en/how-it-works.html
