
## [Unreleased]
### Changed
- 恢复 4/1 历史商业版 UI/逻辑（从历史 exe/asar 反向提取）
- 对齐 index.html / main.js / preload.js 三件套，修复版本混装
- 接入并修正 new-styles.css 覆盖顺序，提升商业化 UI 完成度
### Fixed
- 修复日志导出为真实功能
- 阻止删除当前默认模型正在使用的 provider
- 修复模型切换后按钮文案与真实行为不一致，现会自动重启 Gateway
- 补全已安装识别与 get-install-info 返回信息，提升管理面板直达稳定性

