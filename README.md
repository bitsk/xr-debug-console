# xr-debug-console

同仓的调试前端、Rust 后端与视频 helpers。


构建入口和依赖见下方；工程 Wiki/Blog 与跨仓库规划集中在 [openkylin-xr-docs](https://gitee.com/bigbits/openkylin-xr-docs)。

## 目录与构建

- frontend/: 现有 HTML/CSS/JavaScript。
- backend/: Rust HTTP/WebSocket、遥测、视频控制和 WebRTC；Cargo.lock 固定依赖。
- video/ 与 helpers/: 原生采集/编码、GPU 转换、相机与 OpenVR 观测工具。
- api/: 从现有实现整理的接口索引，生产者 wire 合同由对应仓库维护。

`python3 tools/build.py --sysroot /path/to/arm64/gstreamer/sysroot --output /new/build`

生成的 debug/ 包把前端与服务放在一起，适配后端既有资源加载规则。离线验证使用 `xr-debug-server --offline --listen 127.0.0.1 --token-file /private/generated/token`；密钥按现有方式在本地生成，不进入 Git。摄像头来自生产者 tap；当前硬件编码、采集/解码/呈现统计边界保留。

相机/VR 时序观测 helper 可单独构建：`python3 tools/build_helpers.py --openvr-include /path/to/openvr/headers --output /new/helpers`，消费相邻 device-service 的采集 tap 头文件。`video/` 保留其原生编码/转换源码与历史配方，尚未统一成同一个便携构建入口。

## openKylin 打包

本仓库包含独立的 `debian/` 配方。使用目标发行线的干净构建环境运行 `dpkg-buildpackage -us -uc -b`，预先准备 Build-Depends 和离线构建输入。包构建、目标系统安装和设备验收分别记录。

当前迁移不自动启用竞争采集、切换活动运行时或写设备启动分区；已有验证基线继续保留。
