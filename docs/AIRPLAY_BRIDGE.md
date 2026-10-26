# AirPlay 桥接方案（国行 LG webOS TV · root 路线）

> 结论先行：**可以做到**。国行电视不是"有隐藏开关被屏蔽"，而是出厂就没有 Apple 授权的
> AirPlay 接收端协议栈，任何应用都无法凭空打开它。root 之后能做的是**移植安装开源
> AirPlay 接收端**（UxPlay 内核），这是社区已验证的路线（Android 侧有成熟先例，
> webOS 侧的硬解/渲染基建 ss4s 已经存在）。

## 1. 边界与诚实的预期

| 能力 | 可行性 | 说明 |
| --- | --- | --- |
| 屏幕镜像（iPhone/iPad/Mac 镜像投屏） | ✅ 可实现 | UxPlay 含 FairPlay 握手的开源实现，iOS 15~17 实测可用 |
| 音频 AirPlay（音乐 App 推流） | ✅ 可实现，工作量最小 | RAOP 音频无 FairPlay DRM，开源协议栈完整 |
| App 内视频直推（爱奇艺 App 点 AirPlay 图标） | ❌ 不可行 | 走 FairPlay DRM 加密 HLS，开源接收端无法解密。但这类 App 自带 DLNA 通道，本项目已覆盖 |
| DRM 内容（Apple TV+ 等） | ❌ 永久不可行 | 协议 + 法律双重限制 |
| 游戏级低延迟镜像 | ⚠️ 不建议 | 软解/重编码路径延迟 300~800ms；硬解直通路径可到 100~200ms 但工程量大 |

## 2. 第一步：root（2026 年现状）

| 漏洞 | 适用范围 | 状态 |
| --- | --- | --- |
| faultmanager-autoroot | webOS 4.0 ~ 10.0 | webOS 4.0/4.5 基本未修补（老机型可用）；webOS 5/6/7/9 最新固件大多已修补 |
| dejavuln-autoroot | webOS 3.5+ | 各机型陆续修补中，老固件可用 |
| RootMyTV v1/v2 | webOS 3~6 | 2022 年已修补，别指望 |

- 自查入口：**https://cani.rootmy.tv** 输入型号 + 固件版本（电视端 设置 → 支持 → 软件信息）
- root 流程：开发者模式 → SSH 上电视 → `sh /tmp/autoroot.sh` → 自动安装 Homebrew Channel
- 注意事项（社区共识）：
  - root 前先**关闭 Quick Start+**（快速开机）
  - root 后**卸载开发者模式 App**（防止 jail 配置更新锁死漏洞）
  - 固件更新可能使 root 失效（ faultmanager 在 webOS 4.x 无修补压力）
  - 风险总体低（exploit 失败不损伤系统），但乱改系统可能变砖

## 3. 第二步：移植 UxPlay（三条路线）

### 路线 A：音频 AirPlay 优先（最快落地，1~2 周）
- 内核：`shairplay` 或 `UxPlay`（关掉镜像功能）
- 输出：root 后直接 ALSA 设备写入，或经 ss4s 音频接口
- iOS 上 Apple Music / 网易云 / QQ 音乐 均可直接推送
- mDNS 广播 `_raop._tcp`（用 UxPlay 自带 avahi 兼容逻辑）
- 与本项目集成：`service.js` 探测到 airplay 桥运行时，在待机页显示"AirPlay 音频已就绪"

### 路线 B：镜像 + MSE 浏览器桥（中等工程量，2~4 周，推荐先做）
架构：

```
iPhone ──AirPlay镜像──▶ uxplay-daemon (C, 常驻)
                          │ H.264 NALUs (无容器裸流)
                          ▼
                     remux → fragmented MP4
                          │ WebSocket (ws://tv:port/mirror)
                          ▼
                  投屏助手 web app
                  MediaSource Extensions → <video>
```
- 优点：完全复用本项目现有前端（全屏播放器/HUD/待机页），镜像时 UI 自动切换
- 延迟：~300~500ms（MSE 缓冲），看视频/演示完全够用
- 风险点：fMP4 封装需处理 SPS/PPS 变化（分辨率切换）；webOS 浏览器 MSE 支持良好（Chromium）

### 路线 C：原生硬解直通（效果最好，4~8 周）
- 参考 `moonlight-tv` 的 **ss4s**（Sunshine Streaming SDK for webOS）：
  - 视频硬解：VPU（NVDEC 类硬件）+ Wayland surface 直接渲染
  - 音频：webOS audio service
- UxPlay 的 H.264/H.265 ES 直接喂 ss4s，绕过浏览器
- 延迟 100~200ms，支持 4K 镜像
- 这条路就是社区给 webOS 原生 App 的"标准管线"，moonlight-tv 已把整条链路开源

## 4. "稳定"清单（root 才能做到的）

1. **开机自启**：`/var/lib/webosbrew/startup.sh` 注册 daemon（Homebrew 机制），不依赖 Dev Mode 1000 小时续期
2. **看门狗**：systemd/`respawn` 自动拉起 uxplay-daemon
3. **常驻窗口**：原生路线用 Wayland surface 常驻合成器顶层；MSE 路线用本项目常驻
4. **网络层**（和 root 无关但决定体验）：
   - 关闭路由器 AP 隔离 / IGMP Snooping 对 mDNS 的影响排查
   - 5G Wi-Fi 优先；iPhone 与电视同一 SSID
   - mDNS 名字冲突处理（Bonjour 去重）

## 5. 与本项目的整合

- `service.js` 已内置 AirPlay 能力探测（mDNS `_airplay/_raop` + 端口 7000/7001/7100 + 特征文件）
- 桥接 daemon 运行后探测即变 `present`，前端待机页会提示"AirPlay 已就绪"
- 后续可在 `/status` 增加 `airplaySession`（连接中的 iPhone 名称）展示

## 6. 参考

- root 判定：https://cani.rootmy.tv · https://github.com/throwaway96/faultmanager-autoroot · https://github.com/throwaway96/dejavuln-autoroot
- UxPlay（AirPlay/RAOP 内核）：https://github.com/FDH2/UxPlay
- webOS 硬解/渲染基建：https://github.com/mariotaku/moonlight-tv （ss4s）
- Android 同类先例：https://github.com/jqssun/android-airplay-server · https://github.com/flymop/airplay-tv
- 协议文档：https://openairplay.github.io/airplay-spec/
- 社区讨论：https://github.com/webosbrew/apps-repo/issues/84
