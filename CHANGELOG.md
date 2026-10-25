# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 支持网站管理套件部署与 Nginx 配置检查、平滑重载。
- 支持从套件直接打开所在节点的文件管理，并定位到网站目录。
- 套件重装时可显式接管此前保留的网站、证书和配置数据。

## [0.1.0-alpha.1] - 2026-10-14

### Added

- 首次发布 Veydeck 主控服务、分布式节点 Agent 与 `veydeckctl` 命令行工具。
- 提供统一管理一台或多台 Linux 主机的 Web 控制台与主机运维能力。
- 支持通过 `.vsp` 套件包按需扩展平台能力，并同步套件的主题、语言和材质偏好。
- 提供 Docker、文件、进程、磁盘、防火墙、终端、脚本、计划任务、日志与在线升级管理能力。
- 提供基于 VDL Token 和 `Vey*` 组件的界面，支持浅色与深色主题、中英文切换和 Liquid Glass 外观设置。
- 登录页提供 GitHub 项目入口、主题切换和语言选择。
- 提供应用内容区内的创建、导入、部署和确认流程，支持列表状态保留、后台部署进度和键盘焦点恢复。
