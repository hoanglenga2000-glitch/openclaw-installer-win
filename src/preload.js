const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 安装流程
  startInstall: (config) => ipcRenderer.send('start-install', config),
  onProgress: (cb) => ipcRenderer.on('install-progress', (_, data) => cb(data)),
  testApi: (config) => ipcRenderer.invoke('test-api', config),
  fetchModels: (config) => ipcRenderer.invoke('fetch-models', config),
  detectEnvironment: () => ipcRenderer.invoke('detect-environment'),
  selectDirectory: (defaultPath) => ipcRenderer.invoke('select-directory', defaultPath),
  validateInstallDir: (dir) => ipcRenderer.invoke('validate-install-dir', dir),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  // Gateway 管理
  checkInstall: () => ipcRenderer.invoke('check-install'),
  getInstallInfo: () => ipcRenderer.invoke('get-install-info'),
  checkGateway: (port) => ipcRenderer.invoke('check-gateway', port),
  startGateway: (info) => ipcRenderer.invoke('start-gateway', info),
  stopGateway: (port) => ipcRenderer.invoke('stop-gateway', port),
  openWebchat: (info) => ipcRenderer.invoke('open-webchat', info),
  getVersion: () => ipcRenderer.invoke('get-version'),

  // 模型 / 配置 / 状态
  getConfig: (installDir) => ipcRenderer.invoke('get-config', installDir),
  switchModel: (args) => ipcRenderer.invoke('switch-model', args),
  fetchModelsFromConfig: (installDir) => ipcRenderer.invoke('fetch-models-from-config', installDir),
  getGatewayLogs: (installDir) => ipcRenderer.invoke('get-gateway-logs', installDir),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  restartGateway: (info) => ipcRenderer.invoke('restart-gateway', info),
  diagnoseAndRepair: (installDir) => ipcRenderer.invoke('diagnose-and-repair', installDir),

  // Provider 管理
  saveProvider: (args) => ipcRenderer.invoke('save-provider', args),
  deleteProvider: (args) => ipcRenderer.invoke('delete-provider', args),

  // Channel 集成
  runOpenclawCmd: (args) => ipcRenderer.invoke('run-openclaw-cmd', args),
  loadChannelConfig: (installDir) => ipcRenderer.invoke('load-channel-config', installDir),
  saveChannelConfig: (args) => ipcRenderer.invoke('save-channel-config', args),
  testChannelConnection: (args) => ipcRenderer.invoke('test-channel-connection', args),
  installWeixinPlugin: (installDir) => ipcRenderer.invoke('install-weixin-plugin', installDir),
  loginWeixinChannel: (args) => ipcRenderer.invoke('login-weixin-channel', args),

  // License（兼容旧 UI，若主进程无实现则返回占位结果，避免前端直接炸）
  licenseCheck: async () => ({ activated: true, skipped: true }),
  licenseActivate: async () => ({ success: true, skipped: true }),

  // 日志导出
  exportLogs: (installDir) => ipcRenderer.invoke('export-logs', installDir),

  // 预置 provider 常量，兼容旧前端引用
  openai: 'openai',
  anthropic: 'anthropic',
  deepseek: 'deepseek',
  siliconflow: 'siliconflow',
  moonshot: 'moonshot',
  groq: 'groq',
  together: 'together',

  // 外部操作
  openUrl: (url) => ipcRenderer.send('open-url', url),
  openFolder: (p) => ipcRenderer.send('open-folder', p),
  openFile: (p) => ipcRenderer.send('open-file', p),

  // 窗口控制
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  isMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  onMaximized: (cb) => ipcRenderer.on('win-maximized', (_, v) => cb(v)),
  close: () => ipcRenderer.send('win-close')
})
