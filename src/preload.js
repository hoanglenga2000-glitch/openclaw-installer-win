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

  // Gateway 管理（新增）
  checkInstall: () => ipcRenderer.invoke('check-install'),
  checkGateway: (port) => ipcRenderer.invoke('check-gateway', port),
  startGateway: (info) => ipcRenderer.invoke('start-gateway', info),
  stopGateway: (port) => ipcRenderer.invoke('stop-gateway', port),
  openWebchat: (info) => ipcRenderer.invoke('open-webchat', info),
  getVersion: () => ipcRenderer.invoke('get-version'),

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
