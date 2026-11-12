# xr-debug-console

同仓的调试前端、Rust 后端与视频 helpers。


构建入口和依赖见下方；工程 Wiki/Blog 与跨仓库规划集中在 [openkylin-xr-docs](https://github.com/bitsk/openkylin-xr-docs)。

## 目录与构建

- frontend/: 现有 HTML/CSS/JavaScript。
- backend/: Rust HTTP/WebSocket、遥测、视频控制和 WebRTC；Cargo.lock 固定依赖。
- video/ 与 helpers/: 原生采集/编码、GPU 转换、相机与 OpenVR 观测工具。
- api/: 从现有实现整理的接口索引，生产者 wire 合同由对应仓库维护。

`python3 tools/build.py --sysroot /path/to/arm64/gstreamer/sysroot --output /new/build`

生成的 debug/ 包把前端与服务放在一起，后端通过 XR_DEBUG_WEB_ROOT 指定开发目录的资源路径。离线验证使用 `xr-debug-server --offline --listen 127.0.0.1 --token-file /private/generated/token`；密钥按现有方式在本地生成，不进入 Git。摄像头来自生产者 tap；当前硬件编码、采集/解码/呈现统计边界保留。

相机/VR 时序观测 helper 可单独构建：`python3 tools/build_helpers.py --openvr-include /path/to/openvr/headers --output /new/helpers`，消费相邻 device-service 的采集 tap 头文件。`video/` 保留其原生编码/转换源码与历史配方，尚未统一成同一个便携构建入口。

## openKylin 打包

本仓库包含独立的 `debian/` 配方。使用目标发行线的干净构建环境运行 `dpkg-buildpackage -us -uc -b`，预先准备 Build-Depends 和离线构建输入。包构建、目标系统安装和设备验收分别记录。

当前迁移不自动启用竞争采集、切换活动运行时或写设备启动分区；已有验证基线继续保留。

依赖准备：设置专用 CARGO_HOME 后运行 tools/prepare-dependencies.sh；包构建复用同一缓存并使用 offline 模式。开发目录直接运行后端时，XR_DEBUG_WEB_ROOT 指定 frontend/；安装包默认读取 /usr/share/xr/debug。

## 光学手追状态

`GET /api/hands`、`/api/state.hand_tracking` 和 `/ws/state` 复用同一只读快照。
后端仅启动已安装组件的 `xr-hand-status --follow`，不复制手追的二进制协议，
不打开相机、不启动或控制手追。缺少可选观察器时返回 observer_unavailable。
状态区分连接、新鲜度及左右手的有效姿态；过期或断连后清空手势和位置，
浏览器再结合传输年龄上界执行本地失效。`detected` 仅表示最后一帧的来源标志，
`valid` 才是当前有效性。软件延迟为曝光到状态发布，不含屏幕扫描或完整有效手检测保证。
发布率按实际收到的去重状态包计数，不能把相机帧序号跳跃当成手追推理帧率。

页面在“空间与输入”显示左右手捏合/抓握状态、位置、软件延迟、年龄、序号，
并在原有三维空间叠加有效的 21 个模型关键点；不会声称这些是从 OpenXR 回读的 26 关节。
`openxr_joint_count=26` 说明已集成的标准接口布局，五掌骨的几何估计来源保持明确。

仅更新服务端和网页时可使用标准构建 profile `pkg.xr-debug.server-only`，
复用已准备的目标 GStreamer sysroot 和 Cargo 缓存，不重建未修改的视频/native helpers。
`XR_DEBUG_CARGO_TARGET_DIR`、`XR_DEBUG_TARGET_RUSTFLAGS`、`XR_CROSS_LIBDIR` 和
`XR_CROSS_SHLIBS` 可提供交叉编译输入；默认完整构建仍包含原生工具。

## openKylin WebRTC 插件

`xr-debug-gstreamer` 从 `dependencies/gstreamer-webrtc/source.lock.json` 固定的官方 ARM64 包中选择 5 个原样插件：WebRTC、DTLS、SRTP、SCTP 和 H264/H265 parser，保留完整上游版权说明。构建环境通过 `XR_GST_RUNTIME_DEB` 提供校验后的官方包。后端只在本进程注册私有插件目录，不修改全局 GStreamer 搜索路径。原生视频包依赖该组件及发行版的 nice/base/good 插件，不引入公共源依赖不齐的整个 bad 插件集合。
