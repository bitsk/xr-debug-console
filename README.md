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

## Frame inspector and system capture

`performance.html` imports Shell timeline/summary JSON, shows per-frame CPU
stages, pose validity and optional GPU durations, and exports a Perfetto-compatible
Chrome JSON trace. System JSONL and sched_switch traces are optional; associate
only recordings with the same boot and monotonic clock.

`xr-perf-capture` collects bounded on-device process/system observations; optional
`--trace` uses an owned tracefs instance and `--perf` records CPU stacks. It never
starts XR or opens cameras. The existing OpenVR observer also accepts `--history`
as its fourth argument for per-frame history instead of the default 500ms snapshot.
See [the profiling guide](https://github.com/bitsk/openkylin-xr-docs/blob/main/wiki/frame-profiling.md).

The history observer records driver display timing declarations and decodes
additional predicted frames and throttled frames from the OpenVR flags. The
async flag only identifies the active mode; it does not establish that a frame
was warped or reveal the final warp pose. Shell timeline schema 3 adds separate
input and render view-location spans and paired runtime clocks; the inspector
shows both remaining prediction windows without treating their difference as
a measured sensor-age or optical-latency improvement.

Shell timeline schema 4 separates queue submission (`render_mono_ns`, nine
boundaries) from post-EndFrame fence waiting and cleanup (`retire_mono_ns`,
three boundaries). The inspector accepts both this layout and the older eleven
render boundaries, keeping CPU fence waits distinct from GPU execution.

调试台和本地视频服务从同一软件包安装 systemd 单元，监听所有 IPv4 接口；
网络地址变化后不需要修改地址配置或重启服务。请求目标必须是本机的私有/
回环地址或本机主机名，同源检查按本次连接的 Host 与实际本地端点计算。
视频代理使用回环连接；WebSocket 和视频请求不保存设备 IP。包安装不会
自动启用或启动服务，设备集成需提供原有令牌并启用所需单元。
