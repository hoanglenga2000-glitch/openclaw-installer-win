const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, execSync } = require('child_process')
const os = require('os')
const crypto = require('crypto')

const APP_VERSION = '1.0.0'
let mainWindow

function createWindow() {
  const iconPath = path.join(__dirname, '../assets/icon.ico')
  const winOpts = {
    width: 680,
    height: 860,
    minWidth: 560,
    minHeight: 700,
    resizable: true,
    frame: false,
    transparent: false,
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  }
  if (fs.existsSync(iconPath)) winOpts.icon = iconPath
  mainWindow = new BrowserWindow(winOpts)
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
}

// ─── 文件权限加固 ───
function secureFile(filePath) {
  try {
    execSync(`icacls "${filePath}" /inheritance:r /grant:r "%USERNAME%:(F)" /q`, { stdio: 'ignore', timeout: 5000 })
  } catch {}
}

// ─── 安装日志 ───
let installLogFd = null
function writeInstallLog(text) {
  try {
    if (!installLogFd) return
    fs.writeSync(installLogFd, `[${new Date().toISOString()}] ${text}\n`)
  } catch {}
}

// ─── 杀掉占用端口的进程 ───
function killPortProcess(port) {
  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf8', timeout: 5000 })
    const lines = out.trim().split(/\r?\n/)
    const pids = new Set()
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      const pid = parts[parts.length - 1]
      if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
    }
    for (const pid of pids) {
      try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 5000 }) } catch {}
    }
    return pids.size > 0
  } catch { return false }
}

// ─── 检测已安装 ───
function findInstallInfo() {
  const searchDirs = [
    path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'openclaw'),
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), 'openclaw'),
  ]
  for (const dir of searchDirs) {
    const accessPath = path.join(dir, 'access.json')
    if (fs.existsSync(accessPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(accessPath, 'utf8'))
        info.installDir = info.installDir || dir
        info.accessPath = accessPath
        return info
      } catch {}
    }
  }
  return null
}

// ─── 检测 Gateway 是否运行 ───
function checkGatewayRunning(port) {
  return new Promise((resolve) => {
    const http = require('http')
    const req = http.get(`http://127.0.0.1:${port}`, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(3000, () => { req.destroy(); resolve(false) })
  })
}

// ─── 启动 Gateway ───
async function doStartGateway(installInfo) {
  const workDir = installInfo.installDir
  const port = installInfo.port || 18789
  const configPath = path.join(workDir, 'openclaw.json')

  // 检查是否已在运行
  if (await checkGatewayRunning(port)) return { success: true, alreadyRunning: true }

  // 找 node 和 openclaw.mjs
  const localNodeExe = path.join(workDir, 'node-win', 'node.exe')
  const nodeExe = fs.existsSync(localNodeExe) ? localNodeExe : 'node'
  const ocEntry = path.join(workDir, 'openclaw-pkg', 'openclaw.mjs')
  if (!fs.existsSync(ocEntry)) return { success: false, error: '找不到 OpenClaw 核心文件，请重新安装' }

  const gwEnv = { ...process.env }
  gwEnv.OPENCLAW_HOME = workDir
  gwEnv.OPENCLAW_STATE_DIR = workDir
  gwEnv.OPENCLAW_CONFIG_PATH = configPath
  if (fs.existsSync(path.join(workDir, 'node-win'))) {
    gwEnv.PATH = path.join(workDir, 'node-win') + path.delimiter + (gwEnv.PATH || '')
  }

  const logFile = path.join(workDir, 'gateway-startup.log')
  const logFd = fs.openSync(logFile, 'w')
  const proc = spawn(nodeExe, [ocEntry, 'gateway', '--port', String(port)], {
    detached: true, stdio: ['ignore', logFd, logFd], shell: false,
    env: gwEnv, cwd: workDir
  })
  proc.unref()
  fs.closeSync(logFd)

  // 等待就绪
  const start = Date.now()
  while (Date.now() - start < 20000) {
    await new Promise(r => setTimeout(r, 1500))
    if (await checkGatewayRunning(port)) return { success: true, alreadyRunning: false }
  }
  return { success: false, error: 'Gateway 启动超时' }
}

// ─── IPC: 检测安装 ───
ipcMain.handle('check-install', async () => {
  const info = findInstallInfo()
  if (!info) return { installed: false }
  const running = await checkGatewayRunning(info.port || 18789)
  return { installed: true, ...info, running, version: APP_VERSION }
})

// ─── IPC: 检测 Gateway 状态 ───
ipcMain.handle('check-gateway', async (event, port) => {
  return { running: await checkGatewayRunning(port || 18789) }
})

// ─── IPC: 启动 Gateway ───
ipcMain.handle('start-gateway', async (event, installInfoOverride) => {
  const info = installInfoOverride || findInstallInfo()
  if (!info) return { success: false, error: '未找到安装信息' }
  return await doStartGateway(info)
})

// ─── IPC: 停止 Gateway ───
ipcMain.handle('stop-gateway', async (event, port) => {
  const killed = killPortProcess(port || 18789)
  return { success: true, killed }
})

// ─── IPC: 打开 WebChat ───
ipcMain.handle('open-webchat', async (event, installInfoOverride) => {
  const info = installInfoOverride || findInstallInfo()
  if (!info) return { success: false, error: '未找到安装信息' }
  const port = info.port || 18789
  const token = info.token || ''

  // 确保 Gateway 运行
  if (!(await checkGatewayRunning(port))) {
    const result = await doStartGateway(info)
    if (!result.success) return result
  }

  const url = `http://127.0.0.1:${port}/#token=${token}`
  shell.openExternal(url)
  return { success: true, url }
})

// ─── IPC: 获取版本号 ───
ipcMain.handle('get-version', () => APP_VERSION)

// ─── IPC: 读取配置文件 ───
ipcMain.handle('get-config', async (event, installDir) => {
  try {
    const dir = installDir || findInstallInfo()?.installDir
    if (!dir) return { success: false, error: '未找到安装目录' }
    const configPath = path.join(dir, 'openclaw.json')
    if (!fs.existsSync(configPath)) return { success: false, error: '配置文件不存在' }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    // 提取当前模型和 provider 信息
    const providers = config.models?.providers || {}
    const defaultModel = config.agents?.defaults?.model?.primary || ''
    const providerEntries = []
    for (const [name, prov] of Object.entries(providers)) {
      providerEntries.push({
        name,
        baseUrl: prov.baseUrl || '',
        apiKey: prov.apiKey ? '***' + prov.apiKey.slice(-4) : '',
        apiKeyFull: prov.apiKey || '',
        api: prov.api || 'openai-completions',
        models: (prov.models || []).map(m => typeof m === 'string' ? m : (m.id || m.name || ''))
      })
    }
    return { success: true, config, providers: providerEntries, currentModel: defaultModel, installDir: dir }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: 从已配置的 API 获取可用模型列表 ───
ipcMain.handle('fetch-models-from-config', async (event, installDir) => {
  try {
    const dir = installDir || findInstallInfo()?.installDir
    if (!dir) return { success: false, error: '未找到安装目录' }
    const configPath = path.join(dir, 'openclaw.json')
    if (!fs.existsSync(configPath)) return { success: false, error: '配置文件不存在' }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const providers = config.models?.providers || {}
    const results = {}
    for (const [name, prov] of Object.entries(providers)) {
      if (!prov.baseUrl || !prov.apiKey) continue
      try {
        const httpMod = prov.baseUrl.startsWith('https') ? require('https') : require('http')
        const url = new URL(prov.baseUrl.replace(/\/$/, '') + '/models')
        const models = await new Promise((resolve) => {
          const req = httpMod.request({
            hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + (url.search || ''), method: 'GET',
            headers: { 'Authorization': `Bearer ${prov.apiKey}`, 'Content-Type': 'application/json' },
            timeout: 10000
          }, (res) => {
            let body = ''
            res.on('data', chunk => body += chunk)
            res.on('end', () => {
              try {
                const data = JSON.parse(body)
                let list = []
                if (data.data && Array.isArray(data.data)) list = data.data.map(m => m.id).filter(Boolean).sort()
                else if (Array.isArray(data)) list = data.map(m => m.id || m.name || m).filter(Boolean).sort()
                resolve(list)
              } catch { resolve([]) }
            })
          })
          req.on('error', () => resolve([]))
          req.on('timeout', () => { req.destroy(); resolve([]) })
          req.end()
        })
        results[name] = models
      } catch { results[name] = [] }
    }
    return { success: true, models: results }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: 切换模型 ───
ipcMain.handle('switch-model', async (event, { installDir, providerName, modelId }) => {
  try {
    const dir = installDir || findInstallInfo()?.installDir
    if (!dir) return { success: false, error: '未找到安装目录' }
    const configPath = path.join(dir, 'openclaw.json')
    if (!fs.existsSync(configPath)) return { success: false, error: '配置文件不存在' }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

    // 更新 primary model
    const newPrimary = `${providerName}/${modelId}`
    if (!config.agents) config.agents = {}
    if (!config.agents.defaults) config.agents.defaults = {}
    if (!config.agents.defaults.model) config.agents.defaults.model = {}
    config.agents.defaults.model.primary = newPrimary

    // 确保 provider 的 models 列表包含这个模型
    const prov = config.models?.providers?.[providerName]
    if (prov) {
      const existingModels = prov.models || []
      const hasModel = existingModels.some(m => (typeof m === 'string' ? m : (m.id || m.name)) === modelId)
      if (!hasModel) {
        existingModels.push({ id: modelId, name: modelId, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192 })
        prov.models = existingModels
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    return { success: true, model: newPrimary }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: 获取 Gateway 日志 ───
ipcMain.handle('get-gateway-logs', async (event, installDir) => {
  try {
    const dir = installDir || findInstallInfo()?.installDir
    if (!dir) return { success: false, error: '未找到安装目录' }
    const logFile = path.join(dir, 'gateway-startup.log')
    if (!fs.existsSync(logFile)) return { success: true, logs: '暂无日志' }
    const content = fs.readFileSync(logFile, 'utf8')
    // 只返回最后 100 行
    const lines = content.split(/\r?\n/)
    return { success: true, logs: lines.slice(-100).join('\n') }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: 系统信息 ───
ipcMain.handle('get-system-info', async () => {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  let diskInfo = null
  try {
    const drive = os.homedir().charAt(0)
    const out = execSync(`powershell -Command "(Get-PSDrive ${drive}).Free,(Get-PSDrive ${drive}).Used"`, { encoding: 'utf8', timeout: 5000 }).trim()
    const parts = out.split(/\r?\n/)
    if (parts.length >= 2) {
      const free = parseInt(parts[0])
      const used = parseInt(parts[1])
      diskInfo = { free, used, total: free + used }
    }
  } catch {}
  // CPU usage (rough estimate)
  let cpuUsage = 0
  try {
    const out = execSync('powershell -Command "(Get-Counter \'\\Processor(_Total)\\% Processor Time\').CounterSamples.CookedValue"', { encoding: 'utf8', timeout: 5000 }).trim()
    cpuUsage = Math.round(parseFloat(out))
  } catch {}
  return {
    cpu: { model: cpus[0]?.model || 'Unknown', cores: cpus.length, usage: cpuUsage },
    memory: { total: totalMem, used: usedMem, free: freeMem },
    disk: diskInfo,
    uptime: os.uptime(),
    platform: `${os.type()} ${os.release()}`
  }
})

// ─── IPC: 重启 Gateway ───
ipcMain.handle('restart-gateway', async (event, info) => {
  const installInfo = info || findInstallInfo()
  if (!installInfo) return { success: false, error: '未找到安装信息' }
  const port = installInfo.port || 18789
  // 先停
  killPortProcess(port)
  await new Promise(r => setTimeout(r, 2000))
  // 再启
  return await doStartGateway(installInfo)
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

// ─── Node 路径工具 ───
function getNodeBinDir() {
  const resourcesPath = process.resourcesPath || path.join(__dirname, '..')
  const bundledDir = path.join(resourcesPath, 'node-win')
  if (fs.existsSync(path.join(bundledDir, 'node.exe'))) return bundledDir
  const devDir = path.join(__dirname, '..', 'node-win')
  if (fs.existsSync(path.join(devDir, 'node.exe'))) return devDir
  return null
}

function getNodeEnv(installDir) {
  const binDir = getNodeBinDir()
  const env = { ...process.env }
  env.USERPROFILE = os.homedir()
  env.HOME = os.homedir()
  if (installDir) {
    env.OPENCLAW_HOME = installDir
    env.OPENCLAW_STATE_DIR = installDir
    env.OPENCLAW_CONFIG_PATH = path.join(installDir, 'openclaw.json')
  }
  if (binDir) env.PATH = binDir + path.delimiter + (env.PATH || '')
  return env
}

// ─── 剪贴板 ───
ipcMain.handle('copy-to-clipboard', async (event, text) => {
  const { clipboard } = require('electron')
  clipboard.writeText(text)
  return true
})

// ─── 窗口控制 ───
ipcMain.on('win-close', () => app.quit())
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize())
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('win-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false)

// 监听窗口最大化/还原事件，通知渲染进程
app.whenReady().then(() => {
  setTimeout(() => {
    if (mainWindow) {
      mainWindow.on('maximize', () => mainWindow.webContents.send('win-maximized', true))
      mainWindow.on('unmaximize', () => mainWindow.webContents.send('win-maximized', false))
    }
  }, 500)
})

// ─── 选择安装目录 ───
ipcMain.handle('select-directory', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择安装目录',
    defaultPath: defaultPath || path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'openclaw'),
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled) return null
  let dir = result.filePaths[0]
  // 如果选了盘符根目录，自动追加 openclaw 子目录
  if (/^[A-Z]:\\?$/i.test(dir.replace(/[\\/]+$/, ''))) {
    dir = path.join(dir, 'openclaw')
  }
  return dir
})

// ─── 验证安装路径 ───
ipcMain.handle('validate-install-dir', async (event, dirPath) => {
  if (!dirPath) return { valid: false, error: '请选择安装目录' }
  // 不允许盘符根目录
  if (/^[A-Z]:\\?$/i.test(dirPath.replace(/[\\/]+$/, ''))) {
    return { valid: false, error: '不能安装到磁盘根目录，请选择子文件夹' }
  }
  // 检查路径是否包含非 ASCII 字符（中文等）
  if (/[^\x00-\x7F]/.test(dirPath)) {
    return { valid: false, error: '安装路径不能包含中文或特殊字符，请选择纯英文路径（如 C:\\ProgramData\\openclaw）' }
  }
  // 检查是否可写
  try {
    const testDir = path.join(dirPath, '.openclaw-test-' + Date.now())
    fs.mkdirSync(testDir, { recursive: true })
    fs.rmdirSync(testDir)
    return { valid: true }
  } catch (e) {
    return { valid: false, error: '目录无写入权限: ' + e.message }
  }
})

// ─── 环境检测 ───
ipcMain.handle('detect-environment', async () => {
  const info = {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: os.cpus()[0]?.model || 'Unknown',
    memory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10} GB`,
    freeMemory: `${Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10} GB`,
    homedir: os.homedir(),
    nodeBuiltin: false,
    nodeSystem: null,
    nodeVersion: null,
    npmVersion: null,
    diskFree: null
  }
  const binDir = getNodeBinDir()
  if (binDir) {
    info.nodeBuiltin = true
    try { info.nodeVersion = execSync(`"${path.join(binDir, 'node.exe')}" --version`, { encoding: 'utf8', timeout: 5000 }).trim() } catch {}
  }
  try {
    const sysNode = execSync('node --version', { encoding: 'utf8', timeout: 5000 }).trim()
    info.nodeSystem = sysNode
    if (!info.nodeVersion) info.nodeVersion = sysNode
  } catch {}
  try {
    if (binDir) info.npmVersion = execSync(`"${path.join(binDir, 'npm.cmd')}" --version`, { encoding: 'utf8', timeout: 10000 }).trim()
    else info.npmVersion = execSync('npm --version', { encoding: 'utf8', timeout: 10000 }).trim()
  } catch {}
  try {
    const drive = os.homedir().charAt(0)
    const out = execSync(`powershell -Command "(Get-PSDrive ${drive}).Free"`, { encoding: 'utf8', timeout: 5000 }).trim()
    if (out && /^\d+$/.test(out)) info.diskFree = `${Math.round(parseInt(out) / 1024 / 1024 / 1024 * 10) / 10} GB`
  } catch {}
  return info
})

// ─── 获取模型列表 ───
ipcMain.handle('fetch-models', async (event, { apiBase, apiKey }) => {
  return new Promise((resolve) => {
    try {
      const httpMod = apiBase.startsWith('https') ? require('https') : require('http')
      const url = new URL(apiBase.replace(/\/$/, '') + '/models')
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 15000
      }
      const req = httpMod.request(options, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const data = JSON.parse(body)
              let models = []
              if (data.data && Array.isArray(data.data)) models = data.data.map(m => m.id).filter(Boolean).sort()
              else if (Array.isArray(data)) models = data.map(m => m.id || m.name || m).filter(Boolean).sort()
              resolve({ success: true, models })
            } catch { resolve({ success: false, error: '无法解析模型列表' }) }
          } else if (res.statusCode === 401) { resolve({ success: false, error: 'API Key 无效' }) }
          else { resolve({ success: false, error: `API 返回 ${res.statusCode}` }) }
        })
      })
      req.on('error', (err) => resolve({ success: false, error: err.message }))
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: '连接超时' }) })
      req.end()
    } catch (err) { resolve({ success: false, error: err.message }) }
  })
})

// ─── 测试 API ───
ipcMain.handle('test-api', async (event, { apiBase, apiKey }) => {
  return new Promise((resolve) => {
    try {
      const httpMod = apiBase.startsWith('https') ? require('https') : require('http')
      const url = new URL(apiBase.replace(/\/$/, '') + '/models')
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 10000
      }
      const req = httpMod.request(options, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ success: true, message: 'API 连接成功' })
          else if (res.statusCode === 401) resolve({ success: false, message: 'API Key 无效' })
          else resolve({ success: false, message: `API 返回 ${res.statusCode}` })
        })
      })
      req.on('error', (err) => resolve({ success: false, message: `无法连接: ${err.message}` }))
      req.on('timeout', () => { req.destroy(); resolve({ success: false, message: '连接超时' }) })
      req.end()
    } catch (err) { resolve({ success: false, message: err.message }) }
  })
})

// ─── 安装流程 ───
let installing = false
ipcMain.on('start-install', async (event, { apiBase, apiKey, model, installDir, providerType: frontProviderType, providerApi: frontProviderApi }) => {
  if (installing) return
  installing = true

  const send = (type, text, step) => {
    if (!event.sender.isDestroyed()) event.reply('install-progress', { type, text, step })
  }

  try {
    const workDir = installDir || path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'openclaw')
    const workspace = path.join(workDir, 'workspace')

    // 开启安装日志
    try {
      fs.mkdirSync(workDir, { recursive: true })
      installLogFd = fs.openSync(path.join(workDir, 'install.log'), 'w')
    } catch {}

    // Step 1: 准备目录
    send('log', '创建工作目录: ' + workDir, 1)
    writeInstallLog('安装开始: ' + workDir)
    fs.mkdirSync(workDir, { recursive: true })
    fs.mkdirSync(workspace, { recursive: true })

    // Step 2: 写配置
    send('log', '生成配置文件...', 2)
    const token = crypto.randomBytes(24).toString('hex')
    const modelName = model.trim() || 'gpt-4o'
    const baseUrl = apiBase.replace(/\/$/, '')

    let providerType = frontProviderType || 'openai'
    // 兜底：如果前端没传，根据 URL 推断
    if (!frontProviderType) {
      if (/anthropic/i.test(baseUrl)) providerType = 'anthropic'
      else if (/google|gemini/i.test(baseUrl)) providerType = 'google'
    }

    const config = {
      models: {
        providers: {
          default: {
            baseUrl: baseUrl,
            apiKey: apiKey.trim(),
            api: frontProviderApi || (providerType === 'anthropic' ? 'anthropic-messages' : 'openai-completions'),
            models: [{
              id: modelName,
              name: modelName,
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 8192
            }]
          }
        }
      },
      agents: {
        defaults: {
          model: { primary: `default/${modelName}` }
        }
      },
      gateway: {
        mode: 'local',
        port: 18789,
        bind: 'loopback',
        auth: { mode: 'token', token },
        controlUi: { allowInsecureAuth: true }
      }
    }
    const configPath = path.join(workDir, 'openclaw.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    secureFile(configPath)
    writeInstallLog('配置已写入: ' + configPath)
    send('log', '配置已写入: ' + configPath)

    // Step 3: 离线安装 openclaw（7z 解压完整包，含 node_modules，无需网络）
    send('log', '安装 OpenClaw...', 3)
    const nodeEnv = getNodeEnv(workDir)
    const binDir = getNodeBinDir()
    const nodeExe = binDir ? path.join(binDir, 'node.exe') : 'node'

    // 找到内嵌的 openclaw-full.7z
    const resourcesPath = process.resourcesPath || path.join(__dirname, '..')
    let archivePath = path.join(resourcesPath, 'openclaw-full.7z')
    if (!fs.existsSync(archivePath)) archivePath = path.join(__dirname, '..', 'openclaw-full.7z')
    if (!fs.existsSync(archivePath)) throw new Error('找不到内嵌的 openclaw 安装包')
    send('log', '安装包: ' + Math.round(fs.statSync(archivePath).size / 1024 / 1024) + ' MB')

    // 找到内嵌的 7za.exe
    let sevenZip = path.join(resourcesPath, '7za.exe')
    if (!fs.existsSync(sevenZip)) sevenZip = path.join(__dirname, '..', '7za.exe')
    if (!fs.existsSync(sevenZip)) sevenZip = path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
    if (!fs.existsSync(sevenZip)) {
      const sysCandidates = ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe']
      for (const c of sysCandidates) { if (fs.existsSync(c)) { sevenZip = c; break } }
    }

    // 解压到 openclaw-pkg 目录
    const ocInstallDir = path.join(workDir, 'openclaw-pkg')
    fs.mkdirSync(ocInstallDir, { recursive: true })

    send('log', '解压中（约 30 秒）...')

    if (fs.existsSync(sevenZip)) {
      // 用 7za 解压
      send('log', '使用 7-Zip 解压...')
      await new Promise((resolve, reject) => {
        const proc = spawn(sevenZip, ['x', '-bd', '-y', archivePath, '-o' + ocInstallDir], {
          shell: false, env: nodeEnv
        })
        proc.stdout.on('data', d => {
          const line = d.toString().trim()
          if (line && !line.startsWith('-') && !line.startsWith('7-Zip')) send('log', line.slice(0, 100))
        })
        proc.stderr.on('data', d => send('log', d.toString().trim()))
        proc.on('close', code => {
          if (code === 0 || code === 2) resolve() // code 2 = warnings (symlinks), ok on Windows
          else reject(new Error('7z 解压失败（退出码 ' + code + '）'))
        })
        proc.on('error', err => reject(new Error('无法执行 7z: ' + err.message)))
      })
    } else {
      // 没有 7z，用 PowerShell + tar 作为后备（不太可能走到这里）
      send('log', '使用 PowerShell 解压...')
      throw new Error('找不到 7-Zip 解压工具，请安装 7-Zip 后重试')
    }

    // 验证解压结果
    const ocEntry = path.join(ocInstallDir, 'openclaw.mjs')
    if (!fs.existsSync(ocEntry)) throw new Error('解压异常：找不到 openclaw.mjs')
    send('log', '解压完成')

    // 复制内嵌 Node.js 到安装目录（确保安装器关闭后仍可用）
    const localNodeDir = path.join(workDir, 'node-win')
    if (binDir && !fs.existsSync(path.join(localNodeDir, 'node.exe'))) {
      send('log', '复制 Node.js 运行时...')
      fs.mkdirSync(localNodeDir, { recursive: true })
      const copyRecursive = (src, dest) => {
        const entries = fs.readdirSync(src, { withFileTypes: true })
        for (const entry of entries) {
          const srcPath = path.join(src, entry.name)
          const destPath = path.join(dest, entry.name)
          if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true })
            copyRecursive(srcPath, destPath)
          } else {
            fs.copyFileSync(srcPath, destPath)
          }
        }
      }
      copyRecursive(binDir, localNodeDir)
    }
    const localNodeExe = path.join(localNodeDir, 'node.exe')
    const finalNodeExe = fs.existsSync(localNodeExe) ? localNodeExe : nodeExe

    // 创建 openclaw.cmd 启动脚本（用 cmd /c echo 写入，确保系统编码兼容中文路径）
    const ocBinDir = path.join(workDir, 'bin')
    fs.mkdirSync(ocBinDir, { recursive: true })
    const ocCmd = path.join(ocBinDir, 'openclaw.cmd')
    const cmdContent = `@echo off\r\nchcp 65001 >nul 2>&1\r\n"${finalNodeExe}" "${ocEntry}" %*\r\n`
    try {
      execSync(`cmd /c chcp 65001 >nul & echo. > "${ocCmd}"`, { timeout: 5000, stdio: 'ignore' })
      fs.writeFileSync(ocCmd, cmdContent, { encoding: 'utf8' })
      // 用 PowerShell 重写为带 BOM 的 UTF-8（cmd.exe + chcp 65001 需要 BOM）
      execSync(`powershell -Command "[System.IO.File]::WriteAllText('${ocCmd.replace(/'/g, "''")}', [System.IO.File]::ReadAllText('${ocCmd.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8), (New-Object System.Text.UTF8Encoding $true))"`, { timeout: 5000, stdio: 'ignore' })
    } catch {
      // 后备：直接写 UTF-8
      fs.writeFileSync(ocCmd, cmdContent, 'utf8')
    }
    send('log', '创建启动脚本完成')

    // 加入 PATH
    nodeEnv.PATH = ocBinDir + path.delimiter + nodeEnv.PATH

    // Step 4: 启动 Gateway
    send('log', '启动 Gateway 服务...', 4)

    // 自动检测可用端口（18789 起，最多尝试 10 个）
    // 先尝试杀掉占用默认端口的旧进程
    const net = require('net')
    function isPortFree(port) {
      return new Promise((resolve) => {
        const srv = net.createServer()
        srv.once('error', () => resolve(false))
        srv.once('listening', () => { srv.close(); resolve(true) })
        srv.listen(port, '127.0.0.1')
      })
    }
    let gwPort = 18789
    if (!(await isPortFree(gwPort))) {
      send('log', `端口 ${gwPort} 被占用，尝试清理旧进程...`)
      writeInstallLog(`端口 ${gwPort} 被占用，尝试杀旧进程`)
      killPortProcess(gwPort)
      await new Promise(r => setTimeout(r, 1500))
    }
    for (let i = 0; i < 10; i++) {
      if (await isPortFree(gwPort)) break
      send('log', `端口 ${gwPort} 已被占用，尝试 ${gwPort + 1}...`)
      gwPort++
    }
    send('log', `使用端口: ${gwPort}`)

    // 更新配置文件中的端口
    config.gateway.port = gwPort
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    const ocPath = findOpenClaw(nodeEnv, workDir)
    send('log', 'OpenClaw: ' + (fs.existsSync(localNodeExe) ? localNodeExe : nodeExe) + ' → ' + path.join(ocInstallDir, 'openclaw.mjs'))

    const gwEnv = { ...nodeEnv }
    gwEnv.OPENCLAW_HOME = workDir
    gwEnv.OPENCLAW_STATE_DIR = workDir
    gwEnv.OPENCLAW_CONFIG_PATH = path.join(workDir, 'openclaw.json')

    // 直接用 node.exe 调用 openclaw.mjs，避免 cmd 文件中文路径编码问题
    const gwNodeExe = fs.existsSync(localNodeExe) ? localNodeExe : nodeExe
    const gwEntry = path.join(ocInstallDir, 'openclaw.mjs')

    // 用日志文件捕获输出（detached 进程不能用 inherit）
    const logFile = path.join(workDir, 'gateway-startup.log')
    const logFd = fs.openSync(logFile, 'w')
    const proc = spawn(gwNodeExe, [gwEntry, 'gateway', '--port', String(gwPort)], {
      detached: true, stdio: ['ignore', logFd, logFd], shell: false,
      env: gwEnv, cwd: workDir
    })
    proc.unref()
    fs.closeSync(logFd)

    send('log', '等待服务就绪...')
    await waitForGateway(gwPort, 20000)

    try { createDesktopShortcut(token, gwPort); send('log', '已创建桌面快捷方式') } catch {}
    try { createAutoStart(ocPath, gwEnv, gwPort); send('log', '已设置开机自启') } catch {}

    const accessUrl = `http://127.0.0.1:${gwPort}`
    fs.writeFileSync(
      path.join(workDir, 'access.json'),
      JSON.stringify({ url: accessUrl, token, port: gwPort, model: modelName, installDir: workDir, installedAt: new Date().toISOString() }, null, 2)
    )
    secureFile(path.join(workDir, 'access.json'))
    writeInstallLog('安装完成，access.json 已写入')

    send('done', JSON.stringify({ url: accessUrl, token, installDir: workDir, port: gwPort }), 5)

    // 安装完成后不再自动打开浏览器，由用户点击按钮触发
  } catch (err) {
    writeInstallLog('安装失败: ' + (err.message || '未知错误'))
    send('error', err.message || '未知错误')
  } finally {
    installing = false
    if (installLogFd) { try { fs.closeSync(installLogFd); installLogFd = null } catch {} }
  }
})

ipcMain.on('open-url', (event, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url) })
ipcMain.on('open-folder', (event, folderPath) => { if (folderPath && fs.existsSync(folderPath)) shell.openPath(folderPath) })
ipcMain.on('open-file', (event, filePath) => { if (filePath && fs.existsSync(filePath)) shell.openPath(filePath) })

function runCmd(cmd, args, send, env, cwd) {
  return new Promise((resolve, reject) => {
    const opts = { shell: true, env }
    if (cwd) opts.cwd = cwd
    const proc = spawn(cmd, args, opts)
    let lastLine = ''
    proc.stdout.on('data', d => {
      d.toString().split(/\r?\n/).filter(l => l.trim()).forEach(line => {
        if (line !== lastLine) { send('log', line.trim().slice(0, 200)); lastLine = line }
      })
    })
    proc.stderr.on('data', d => {
      d.toString().split(/\r?\n/).filter(l => l.trim()).forEach(line => {
        if (!/^npm warn/i.test(line.trim()) && line.trim()) send('log', line.trim().slice(0, 200))
      })
    })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`安装失败（退出码 ${code}），请检查网络连接后重试`))
    })
    proc.on('error', err => reject(new Error(`执行失败: ${err.message}`)))
  })
}

function findOpenClaw(env, workDir) {
  // 优先查我们创建的 bin 目录
  if (workDir) {
    const c = path.join(workDir, 'bin', 'openclaw.cmd')
    if (fs.existsSync(c)) return c
  }

  // npm prefix 目录
  const npmPrefix = path.join(os.homedir(), 'AppData', 'Roaming', 'npm')
  const prefixCmd = path.join(npmPrefix, 'openclaw.cmd')
  if (fs.existsSync(prefixCmd)) return prefixCmd

  // 内嵌 node 目录
  const binDir = getNodeBinDir()
  if (binDir) { const c = path.join(binDir, 'openclaw.cmd'); if (fs.existsSync(c)) return c }

  // where 查找
  try {
    const result = execSync('where openclaw', { encoding: 'utf8', timeout: 5000, env }).trim()
    const first = result.split(/\r?\n/)[0].trim()
    if (first && fs.existsSync(first)) return first
  } catch {}

  return 'openclaw'
}

function waitForGateway(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const http = require('http')
    function check() {
      http.get(`http://127.0.0.1:${port}`, (res) => {
        res.resume()
        resolve()
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Gateway 启动超时，请检查配置后重试'))
        else setTimeout(check, 1500)
      })
    }
    setTimeout(check, 2000)
  })
}

function createDesktopShortcut(token, port) {
  const desktop = path.join(os.homedir(), 'Desktop')
  const gwPort = port || 18789
  const url = `http://127.0.0.1:${gwPort}/#token=${token}`
  fs.writeFileSync(path.join(desktop, 'OpenClaw.url'), '[InternetShortcut]\nURL=' + url + '\nIconIndex=0\n', 'utf8')
}

function createAutoStart(ocPath, gwEnv, gwPort) {
  const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  let envLines = ''
  if (gwEnv) {
    if (gwEnv.OPENCLAW_STATE_DIR) envLines += 'set OPENCLAW_STATE_DIR=' + gwEnv.OPENCLAW_STATE_DIR + '\r\n'
    if (gwEnv.OPENCLAW_CONFIG_PATH) envLines += 'set OPENCLAW_CONFIG_PATH=' + gwEnv.OPENCLAW_CONFIG_PATH + '\r\n'
  }
  const portArg = gwPort ? ' --port ' + gwPort : ''
  const batPath = path.join(startupDir, 'openclaw-gateway.bat')
  const batContent = '@echo off\r\nchcp 65001 >nul 2>&1\r\n' + envLines + 'if not exist "' + ocPath + '" (\r\n  echo OpenClaw not found: ' + ocPath + '\r\n  pause\r\n  exit /b 1\r\n)\r\nstart "" /min "' + ocPath + '" gateway' + portArg + '\r\n'
  fs.writeFileSync(batPath, batContent, 'utf8')
  try {
    execSync(`powershell -Command "[System.IO.File]::WriteAllText('${batPath.replace(/'/g, "''")}', [System.IO.File]::ReadAllText('${batPath.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8), (New-Object System.Text.UTF8Encoding $true))"`, { timeout: 5000, stdio: 'ignore' })
  } catch {}
}
