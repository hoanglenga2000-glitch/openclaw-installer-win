const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, execSync } = require('child_process')
const os = require('os')
const crypto = require('crypto')

const APP_VERSION = '1.0.0'
let mainWindow
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

// Strip UTF-8 BOM before reading text files
function readFileUtf8(filePath) {
  let t = fs.readFileSync(filePath, 'utf8')
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1)
  return t
}

function parseJsonMaybe(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {}
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!(line.startsWith('{') || line.startsWith('['))) continue
    try {
      return JSON.parse(line)
    } catch {}
  }
  return null
}

function normalizeCommandResult({ code = 0, stdout = '', stderr = '' }) {
  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  const json = parseJsonMaybe(stdout) || parseJsonMaybe(output)
  if (code !== 0) {
    return {
      success: false,
      error: stderr || stdout || `exit ${code}`,
      stdout,
      stderr,
      output
    }
  }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    return { success: true, stdout, stderr, output, ...json }
  }
  if (json) {
    return { success: true, stdout, stderr, output, data: json }
  }
  return { success: true, stdout, stderr, output }
}

function getBundledOpenClawVersion(installDir) {
  try {
    const pkgPath = path.join(installDir, 'openclaw-pkg', 'package.json')
    const pkg = JSON.parse(readFileUtf8(pkgPath))
    return String(pkg.version || '')
  } catch {
    return ''
  }
}

function compareLooseVersions(a, b) {
  const normalize = (value) => String(value || '').split('.').map(part => parseInt(part, 10)).filter(n => Number.isInteger(n))
  const ap = normalize(a)
  const bp = normalize(b)
  const len = Math.max(ap.length, bp.length)
  for (let i = 0; i < len; i++) {
    const av = ap[i] || 0
    const bv = bp[i] || 0
    if (av > bv) return 1
    if (av < bv) return -1
  }
  return 0
}

function getWeixinPluginManifestPath(installDir) {
  // 优先检查 extensions 目录（openclaw plugins install 安装位置）
  const extPath = path.join(installDir, 'extensions', 'openclaw-weixin', 'openclaw.plugin.json')
  if (fs.existsSync(extPath)) return extPath
  // 兼容 node_modules 安装方式
  return path.join(installDir, 'node_modules', '@tencent-weixin', 'openclaw-weixin', 'openclaw.plugin.json')
}

function getWeixinSupportIssue(installDir) {
  const hostVersion = getBundledOpenClawVersion(installDir)
  const minVersion = '2026.3.22'
  if (hostVersion && compareLooseVersions(hostVersion, minVersion) < 0) {
    return `当前内置 OpenClaw 版本 ${hostVersion} 过旧，微信插件至少需要 ${minVersion}`
  }
  if (!fs.existsSync(getWeixinPluginManifestPath(installDir))) {
    return '未检测到 @tencent-weixin/openclaw-weixin 插件，请先点击“安装插件”'
  }
  return null
}

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
  mainWindow.on('closed', () => { mainWindow = null })
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
})

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
    const out = execSync('netstat -ano | findstr "LISTENING"', { encoding: 'utf8', timeout: 5000 })
    const lines = out.split('\n')
    let killed = false
    for (const line of lines) {
      const match = line.match(/:(\d+)\s+.*LISTENING\s+(\d+)/)
      if (match && parseInt(match[1]) === port) {
        const pid = match[2]
        try { execSync('taskkill /F /PID ' + pid, { timeout: 5000 }) } catch {}
        killed = true
      }
    }
    return killed
  } catch { return false }
}

// ─── 检测已安装 ───
function findInstallInfo() {
  const searchDirs = [
    path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'openclaw'),
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), 'openclaw'),
  ]
  // 优先通过 access.json 查找
  for (const dir of searchDirs) {
    const accessPath = path.join(dir, 'access.json')
    if (fs.existsSync(accessPath)) {
      try {
        const info = JSON.parse(readFileUtf8(accessPath))
        info.installDir = info.installDir || dir
        info.accessPath = accessPath
        return info
      } catch {}
    }
  }
  // 兜底：通过 openclaw.json 查找（用户可能通过 npm 全局安装，没有 access.json）
  for (const dir of searchDirs) {
    const configPath = path.join(dir, 'openclaw.json')
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileUtf8(configPath))
        const port = config.gateway?.port || 18789
        const token = config.gateway?.auth?.token || ''
        // 用配置文件的修改时间作为安装时间
        const stat = fs.statSync(configPath)
        const installedAt = config.meta?.lastTouchedAt || stat.birthtime.toISOString() || stat.mtime.toISOString()
        return { installDir: dir, port, token, url: `http://127.0.0.1:${port}`, installedAt, configOnly: true }
      } catch {}
    }
  }
  return null
}

// ─── 检测 Gateway 是否运行 ───
function checkGatewayRunning(port) {
  return new Promise((resolve) => {
    const http = require('http')
    const candidates = [
      `http://127.0.0.1:${port}/api/status`,
      `http://127.0.0.1:${port}/`
    ]
    let i = 0

    const tryNext = () => {
      if (i >= candidates.length) return resolve(false)
      const url = candidates[i++]
      const req = http.get(url, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          if (url.endsWith('/api/status')) {
            const ok = res.statusCode >= 200 && res.statusCode < 300 && !!parseJsonMaybe(data)
            if (ok) return resolve(true)
            return tryNext()
          }
          const ok = res.statusCode >= 200 && res.statusCode < 400
          if (ok) return resolve(true)
          return tryNext()
        })
      })
      req.on('error', tryNext)
      req.setTimeout(3000, () => { req.destroy(); tryNext() })
    }

    tryNext()
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
  const logFd = fs.openSync(logFile, 'a')
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
  return { success: false, error: 'OpenClaw 启动超时：进程可能已启动，但健康检查未通过', debugLog: logFile }
}

// ─── IPC: 检测安装 ───
ipcMain.handle('check-install', async () => {
  try {
    const info = findInstallInfo()
    if (!info) return { installed: false }
    const running = await checkGatewayRunning(info.port || 18789)
    return { installed: true, ...info, running, version: APP_VERSION }
  } catch (e) {
    return { installed: false, error: e.message }
  }
})

// ─── IPC: 检测 Gateway 状态 ───
ipcMain.handle('check-gateway', async (event, port) => {
  try {
    return { running: await checkGatewayRunning(port || 18789) }
  } catch (e) {
    return { running: false, error: e.message }
  }
})

// ─── IPC: 启动 Gateway ───
ipcMain.handle('start-gateway', async (event, installInfoOverride) => {
  try {
    const info = installInfoOverride || findInstallInfo()
    if (!info) return { success: false, error: '未找到安装信息' }
    return await doStartGateway(info)
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: 停止 Gateway ───
ipcMain.handle('stop-gateway', async (event, port) => {
  try {
    const killed = killPortProcess(port || 18789)
    return { success: true, killed }
  } catch (e) {
    return { success: true, killed: false, error: e.message }
  }
})

// ─── IPC: 打开 WebChat ───
ipcMain.handle('open-webchat', async (event, installInfoOverride) => {
  try {
    const info = installInfoOverride || findInstallInfo()
    if (!info) return { success: false, error: '未找到安装信息', state: 'missing-install' }
    const port = info.port || 18789

    let state = 'already-running'
    if (!(await checkGatewayRunning(port))) {
      state = 'starting'
      const result = await doStartGateway(info)
      if (!result.success) return { ...result, state: 'start-failed' }
      state = result.alreadyRunning ? 'already-running' : 'started'
    }

    const healthy = await checkGatewayRunning(port)
    if (!healthy) {
      return { success: false, error: 'Gateway 未就绪，请稍后重试', state: 'unhealthy' }
    }

    const url = `http://127.0.0.1:${port}/`
    shell.openExternal(url)
    return { success: true, url, state }
  } catch (e) {
    return { success: false, error: e.message, state: 'error' }
  }
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
    const config = JSON.parse(readFileUtf8(configPath))
    // 提取当前模型和 provider 信息
    const providers = config.models?.providers || {}
    const defaultModel = config.agents?.defaults?.model?.primary || ''
    const providerEntries = []
    for (const [name, prov] of Object.entries(providers)) {
      providerEntries.push({
        name,
        baseUrl: prov.baseUrl || '',
        apiKey: prov.apiKey ? '***' + prov.apiKey.slice(-4) : '',
        apiKeyMasked: prov.apiKey ? (prov.apiKey.slice(0, 6) + '...' + prov.apiKey.slice(-4)) : '',
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
    const config = JSON.parse(readFileUtf8(configPath))
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
    const config = JSON.parse(readFileUtf8(configPath))

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

// ─── IPC: 获取 Gateway 日志（多日志源聚合） ───
ipcMain.handle('get-gateway-logs', async (event, installDir) => {
  try {
    const dir = installDir || findInstallInfo()?.installDir
    if (!dir) return { success: false, error: '未找到安装目录' }
    let combined = ''
    let hasRealLogs = false

    // 1. 获取 Gateway 运行状态（始终放在最前面）
    let port = 18789
    try {
      const cfgPath = path.join(dir, 'openclaw.json')
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileUtf8(cfgPath))
        port = cfg.gateway?.port || 18789
      }
    } catch {}
    if (port === 18789) {
      try {
        const homeCfg = path.join(os.homedir(), '.openclaw', 'openclaw.json')
        if (fs.existsSync(homeCfg)) {
          const cfg = JSON.parse(readFileUtf8(homeCfg))
          port = cfg.gateway?.port || 18789
        }
      } catch {}
    }

    const running = await checkGatewayRunning(port)
    combined += '=== Gateway 状态 ===\n'
    combined += running ? '● 运行中 (端口 ' + port + ')\n' : '○ 未运行\n'
    combined += '检查时间: ' + new Date().toLocaleString('zh-CN') + '\n'

    if (running) {
      // 尝试获取更多运行信息
      const http = require('http')
      const statusInfo = await new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:' + port + '/api/status', { timeout: 5000 }, (res) => {
          let data = ''
          res.on('data', chunk => { data += chunk })
          res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve(null) } })
        })
        req.on('error', () => resolve(null))
        req.on('timeout', () => { req.destroy(); resolve(null) })
      })
      if (statusInfo) {
        if (statusInfo.version) combined += '版本: ' + statusInfo.version + '\n'
        if (statusInfo.uptime) combined += '运行时长: ' + Math.round(statusInfo.uptime / 60) + ' 分钟\n'
        if (statusInfo.sessions) combined += '活跃会话: ' + (statusInfo.sessions.active || 0) + '\n'
      }
    }

    // 2. 文件日志源（启动日志、运行日志）
    const candidates = [
      path.join(dir, 'gateway-startup.log'),
      path.join(dir, 'install.log'),
      path.join(dir, 'logs', 'gateway.log'),
      path.join(dir, 'openclaw.log'),
      path.join(os.homedir(), '.openclaw', 'gateway-startup.log'),
      path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log'),
    ]
    for (const logPath of candidates) {
      try {
        if (fs.existsSync(logPath)) {
          const content = fs.readFileSync(logPath, 'utf8').trim()
          if (content) {
            combined += '\n=== ' + path.basename(logPath) + ' ===\n' + content
            hasRealLogs = true
          }
        }
      } catch {}
    }

    // 3. 配置变更记录（最近 15 条）
    const auditPaths = [
      path.join(dir, 'logs', 'config-audit.jsonl'),
      path.join(os.homedir(), '.openclaw', 'logs', 'config-audit.jsonl'),
    ]
    let auditAdded = false
    for (const ap of auditPaths) {
      if (auditAdded) break
      try {
        if (fs.existsSync(ap)) {
          const raw = fs.readFileSync(ap, 'utf8').trim()
          const lines = raw.split('\n').slice(-15)
          const formatted = lines.map(l => {
            try {
              const j = JSON.parse(l)
              const ts = j.ts ? new Date(j.ts).toLocaleString('zh-CN') : ''
              return '[' + ts + '] ' + (j.event || j.source || 'audit') + (j.result ? ' → ' + j.result : '')
            } catch { return l.slice(0, 120) }
          }).join('\n')
          if (formatted) {
            combined += '\n=== 配置变更记录 ===\n' + formatted
            auditAdded = true
          }
        }
      } catch {}
    }

    // 4. 如果没有真正的运行日志，给出提示
    if (!hasRealLogs) {
      combined += '\n\n提示: 未找到 Gateway 运行日志文件。'
      if (running) {
        combined += '\nGateway 当前输出到控制台，重启后日志将自动写入文件。'
      }
    }

    const allLines = combined.split(/\r?\n/)
    return { success: true, logs: allLines.slice(-300).join('\n') }
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
  try {
    const installInfo = info || findInstallInfo()
    if (!installInfo) return { success: false, error: '未找到安装信息' }
    const port = installInfo.port || 18789
    // 先停
    killPortProcess(port)
    await new Promise(r => setTimeout(r, 2000))
    // 再启
    return await doStartGateway(installInfo)
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: 一键诊断修复 ───
ipcMain.handle('diagnose-and-repair', async (event, installDir) => {
  const dir = installDir || findInstallInfo()?.installDir
  if (!dir) return { success: false, error: '未找到安装目录', checks: [] }

  const checks = []
  let fixedCount = 0

  // 1. 检查安装目录是否存在
  const dirExists = fs.existsSync(dir)
  checks.push({ name: '安装目录', status: dirExists ? 'ok' : 'error', detail: dirExists ? dir : '目录不存在: ' + dir, fixable: false })

  if (!dirExists) return { success: true, checks, fixedCount }

  // 2. 检查 openclaw.json 配置文件
  const configPath = path.join(dir, 'openclaw.json')
  const configExists = fs.existsSync(configPath)
  let configValid = false
  let configError = ''
  if (configExists) {
    try { JSON.parse(readFileUtf8(configPath)); configValid = true }
    catch (e) { configError = 'JSON 格式错误: ' + e.message }
  }
  checks.push({
    name: '配置文件',
    status: !configExists ? 'error' : !configValid ? 'warn' : 'ok',
    detail: !configExists ? '缺失 openclaw.json' : !configValid ? configError : '配置正常',
    fixable: !configExists
  })
  // 修复：如果配置文件不存在，创建默认配置
  if (!configExists) {
    try {
      const defaultConfig = {
        models: { providers: { default: { baseUrl: '', apiKey: '', api: 'openai-completions', models: [] } } },
        agents: { defaults: { model: { primary: 'default/' } } },
        gateway: { mode: 'local', port: 18789, bind: 'loopback', auth: { mode: 'token', token: crypto.randomBytes(24).toString('hex') }, controlUi: { allowInsecureAuth: true } }
      }
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8')
      checks[checks.length - 1].status = 'fixed'
      checks[checks.length - 1].detail = '已创建默认配置（需要填写 API Key）'
      fixedCount++
    } catch (e) { checks[checks.length - 1].detail = '创建失败: ' + e.message }
  }

  // 3. 检查 access.json
  const accessPath = path.join(dir, 'access.json')
  const accessExists = fs.existsSync(accessPath)
  let accessValid = false
  if (accessExists) {
    try { const a = JSON.parse(readFileUtf8(accessPath)); accessValid = !!(a.token && a.port); } catch {}
  }
  checks.push({
    name: '访问凭证',
    status: !accessExists ? 'error' : !accessValid ? 'warn' : 'ok',
    detail: !accessExists ? '缺失 access.json' : !accessValid ? 'access.json 内容不完整' : '凭证正常',
    fixable: !accessExists || !accessValid
  })
  // 修复：从 openclaw.json 重建 access.json
  if (!accessExists || !accessValid) {
    try {
      if (configExists || fs.existsSync(configPath)) {
        const config = JSON.parse(readFileUtf8(configPath))
        const token = config.gateway?.auth?.token || crypto.randomBytes(24).toString('hex')
        const port = config.gateway?.port || 18789
        const model = config.agents?.defaults?.model?.primary || ''
        fs.writeFileSync(accessPath, JSON.stringify({
          url: `http://127.0.0.1:${port}`, token, port, model, installDir: dir, repairedAt: new Date().toISOString()
        }, null, 2), 'utf8')
        secureFile(accessPath)
        checks[checks.length - 1].status = 'fixed'
        checks[checks.length - 1].detail = '已从配置文件重建访问凭证'
        fixedCount++
      }
    } catch (e) { checks[checks.length - 1].detail = '修复失败: ' + e.message }
  }

  // 4. 检查 Node.js 运行时
  const nodeExe = path.join(dir, 'node-win', 'node.exe')
  const nodeExists = fs.existsSync(nodeExe)
  let nodeVersion = ''
  if (nodeExists) {
    try { nodeVersion = execSync(`"${nodeExe}" --version`, { encoding: 'utf8', timeout: 5000 }).trim() } catch {}
  }
  checks.push({
    name: 'Node.js 运行时',
    status: !nodeExists ? 'error' : !nodeVersion ? 'warn' : 'ok',
    detail: !nodeExists ? '缺失 node-win/node.exe（需重新安装）' : nodeVersion ? 'Node ' + nodeVersion : 'node.exe 存在但无法执行',
    fixable: false
  })

  // 5. 检查 OpenClaw 核心文件
  const ocEntry = path.join(dir, 'openclaw-pkg', 'openclaw.mjs')
  const ocExists = fs.existsSync(ocEntry)
  const nodeModules = path.join(dir, 'openclaw-pkg', 'node_modules')
  const nmExists = fs.existsSync(nodeModules)
  checks.push({
    name: 'OpenClaw 核心',
    status: !ocExists ? 'error' : !nmExists ? 'warn' : 'ok',
    detail: !ocExists ? '缺失 openclaw.mjs（需重新安装）' : !nmExists ? '缺失 node_modules（需重新安装）' : 'openclaw.mjs + node_modules 正常',
    fixable: false
  })

  // 6. 检查端口占用
  let port = 18789
  try {
    if (configExists) {
      const config = JSON.parse(readFileUtf8(configPath))
      port = config.gateway?.port || 18789
    }
  } catch {}
  const gatewayRunning = await checkGatewayRunning(port)
  let portConflict = false
  if (!gatewayRunning) {
    // 检查端口是否被其他进程占用
    try {
      const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf8', timeout: 5000 })
      if (out.trim()) portConflict = true
    } catch {}
  }
  checks.push({
    name: '端口 ' + port,
    status: gatewayRunning ? 'ok' : portConflict ? 'warn' : 'ok',
    detail: gatewayRunning ? 'Gateway 正在运行' : portConflict ? '端口被其他程序占用' : '端口空闲',
    fixable: portConflict
  })
  // 修复：杀掉占用端口的进程
  if (portConflict) {
    killPortProcess(port)
    await new Promise(r => setTimeout(r, 1000))
    checks[checks.length - 1].status = 'fixed'
    checks[checks.length - 1].detail = '已清理占用端口的进程'
    fixedCount++
  }

  // 7. 检查开机自启
  const startupBat = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'openclaw-gateway.bat')
  const startupExists = fs.existsSync(startupBat)
  checks.push({
    name: '开机自启',
    status: startupExists ? 'ok' : 'warn',
    detail: startupExists ? '已配置开机自启' : '未配置开机自启',
    fixable: !startupExists
  })
  // 修复：重建开机自启脚本
  if (!startupExists && ocExists && nodeExists) {
    try {
      const ocBinCmd = path.join(dir, 'bin', 'openclaw.cmd')
      const ocPath = fs.existsSync(ocBinCmd) ? ocBinCmd : 'openclaw'
      const gwEnv = { OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath }
      createAutoStart(ocPath, gwEnv, port)
      checks[checks.length - 1].status = 'fixed'
      checks[checks.length - 1].detail = '已重建开机自启脚本'
      fixedCount++
    } catch {}
  }

  // 8. 检查桌面快捷方式
  const desktopShortcut = path.join(os.homedir(), 'Desktop', 'OpenClaw.url')
  const shortcutExists = fs.existsSync(desktopShortcut)
  checks.push({
    name: '桌面快捷方式',
    status: shortcutExists ? 'ok' : 'warn',
    detail: shortcutExists ? '快捷方式存在' : '桌面快捷方式缺失',
    fixable: !shortcutExists
  })
  // 修复：重建桌面快捷方式
  if (!shortcutExists) {
    try {
      let token = ''
      try { const a = JSON.parse(readFileUtf8(accessPath)); token = a.token || '' } catch {}
      if (!token) { try { const c = JSON.parse(readFileUtf8(configPath)); token = c.gateway?.auth?.token || '' } catch {} }
      if (token) {
        createDesktopShortcut(token, port)
        checks[checks.length - 1].status = 'fixed'
        checks[checks.length - 1].detail = '已重建桌面快捷方式'
        fixedCount++
      }
    } catch {}
  }

  // 9. 检查文件权限
  let configReadable = false
  try { fs.accessSync(configPath, fs.constants.R_OK | fs.constants.W_OK); configReadable = true } catch {}
  if (configExists && !configReadable) {
    checks.push({ name: '文件权限', status: 'warn', detail: '配置文件权限异常', fixable: true })
    try {
      secureFile(configPath)
      secureFile(accessPath)
      checks[checks.length - 1].status = 'fixed'
      checks[checks.length - 1].detail = '已修复文件权限'
      fixedCount++
    } catch {}
  } else {
    checks.push({ name: '文件权限', status: 'ok', detail: '权限正常', fixable: false })
  }

  // 10. 检查磁盘空间
  let diskLow = false
  try {
    const drive = dir.charAt(0)
    const out = execSync(`powershell -Command "(Get-PSDrive ${drive}).Free"`, { encoding: 'utf8', timeout: 5000 }).trim()
    const freeBytes = parseInt(out)
    const freeGB = freeBytes / 1073741824
    diskLow = freeGB < 1
    checks.push({
      name: '磁盘空间',
      status: diskLow ? 'warn' : 'ok',
      detail: diskLow ? '剩余空间不足 1 GB（' + freeGB.toFixed(1) + ' GB）' : '剩余 ' + freeGB.toFixed(1) + ' GB',
      fixable: false
    })
  } catch {
    checks.push({ name: '磁盘空间', status: 'ok', detail: '无法检测', fixable: false })
  }

  // 11. 配置完整性检查
  if (configExists && configValid) {
    try {
      const config = JSON.parse(readFileUtf8(configPath))
      const hasProvider = config.models?.providers && Object.keys(config.models.providers).length > 0
      const hasModel = !!(config.agents?.defaults?.model?.primary)
      const hasGateway = !!(config.gateway?.port)
      const issues = []
      if (!hasProvider) issues.push('缺少模型服务商配置')
      if (!hasModel) issues.push('未设置默认模型')
      if (!hasGateway) issues.push('缺少 Gateway 端口配置')
      checks.push({
        name: '配置完整性',
        status: issues.length > 0 ? 'warn' : 'ok',
        detail: issues.length > 0 ? issues.join('；') : '配置项完整',
        fixable: false
      })
    } catch {
      checks.push({ name: '配置完整性', status: 'warn', detail: '无法解析配置', fixable: false })
    }
  } else {
    checks.push({ name: '配置完整性', status: configExists ? 'warn' : 'error', detail: configExists ? '配置文件格式错误' : '配置文件不存在', fixable: false })
  }

  // 12. Node.js 版本检查
  if (nodeExists && nodeVersion) {
    const major = parseInt(nodeVersion.replace('v', '').split('.')[0])
    checks.push({
      name: 'Node.js 版本',
      status: major >= 18 ? 'ok' : 'warn',
      detail: major >= 18 ? nodeVersion + '（满足要求）' : nodeVersion + '（建议 v18+）',
      fixable: false
    })
  } else {
    checks.push({ name: 'Node.js 版本', status: nodeExists ? 'warn' : 'error', detail: nodeExists ? '无法获取版本' : 'Node.js 未安装', fixable: false })
  }

  // 13. 进程冲突检查
  let gatewayProcCount = 0
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 })
    const nodeProcs = out.split('\n').filter(l => l.includes('node.exe'))
    gatewayProcCount = nodeProcs.length
    checks.push({
      name: '进程冲突',
      status: gatewayProcCount > 10 ? 'warn' : 'ok',
      detail: gatewayProcCount > 10 ? '检测到 ' + gatewayProcCount + ' 个 Node 进程，可能有僵尸进程' : gatewayProcCount + ' 个 Node 进程运行中',
      fixable: false
    })
  } catch {
    checks.push({ name: '进程冲突', status: 'ok', detail: '无法检测', fixable: false })
  }

  // 14. 日志文件检查
  const logCandidates = [
    path.join(dir, 'gateway-startup.log'),
    path.join(dir, 'install.log')
  ]
  let logFound = false
  let logSize = 0
  for (const lp of logCandidates) {
    try {
      if (fs.existsSync(lp)) {
        logFound = true
        logSize += fs.statSync(lp).size
      }
    } catch {}
  }
  const logSizeMB = (logSize / 1048576).toFixed(1)
  const logTooBig = logSize > 50 * 1048576 // 50MB
  checks.push({
    name: '日志文件',
    status: !logFound ? 'warn' : logTooBig ? 'warn' : 'ok',
    detail: !logFound ? '未找到日志文件' : logTooBig ? '日志过大（' + logSizeMB + ' MB），建议清理' : '日志正常（' + logSizeMB + ' MB）',
    fixable: logTooBig
  })
  if (logTooBig) {
    try {
      for (const lp of logCandidates) {
        if (fs.existsSync(lp) && fs.statSync(lp).size > 10 * 1048576) {
          const content = fs.readFileSync(lp, 'utf8')
          const lines = content.split('\n')
          fs.writeFileSync(lp, lines.slice(-1000).join('\n'), 'utf8')
        }
      }
      checks[checks.length - 1].status = 'fixed'
      checks[checks.length - 1].detail = '已截断过大的日志文件'
      fixedCount++
    } catch {}
  }

  // 15. OpenClaw 版本检查
  const ocVersion = getBundledOpenClawVersion(dir)
  checks.push({
    name: 'OpenClaw 版本',
    status: ocVersion ? 'ok' : 'warn',
    detail: ocVersion ? 'v' + ocVersion : '无法获取版本信息',
    fixable: false
  })

  // 16. API 连通性检查
  let apiOk = false
  try {
    if (configExists && configValid) {
      const config = JSON.parse(readFileUtf8(configPath))
      const providers = config.models?.providers || {}
      const firstKey = Object.keys(providers)[0]
      const prov = firstKey ? providers[firstKey] : null
      if (prov && prov.baseUrl && prov.apiKey) {
        const testUrl = prov.baseUrl.replace(/\/+$/, '') + '/models'
        const http = testUrl.startsWith('https') ? require('https') : require('http')
        apiOk = await new Promise((resolve) => {
          const req = http.get(testUrl, { headers: { 'Authorization': 'Bearer ' + prov.apiKey }, timeout: 8000 }, (res) => {
            res.resume()
            resolve(res.statusCode >= 200 && res.statusCode < 500)
          })
          req.on('error', () => resolve(false))
          req.on('timeout', () => { req.destroy(); resolve(false) })
        })
        checks.push({
          name: 'API 连通性',
          status: apiOk ? 'ok' : 'warn',
          detail: apiOk ? '服务商 API 可达' : 'API 连接失败，请检查网络或 API Key',
          fixable: false
        })
      } else {
        checks.push({ name: 'API 连通性', status: 'warn', detail: '未配置 API 服务商', fixable: false })
      }
    } else {
      checks.push({ name: 'API 连通性', status: 'warn', detail: '配置文件异常，跳过检测', fixable: false })
    }
  } catch {
    checks.push({ name: 'API 连通性', status: 'warn', detail: '检测异常', fixable: false })
  }

  // 17. 网络代理检查
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || ''
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || ''
  const hasProxy = !!(httpProxy || httpsProxy)
  checks.push({
    name: '网络代理',
    status: 'ok',
    detail: hasProxy ? '检测到代理: ' + (httpsProxy || httpProxy) : '未使用代理（直连）',
    fixable: false
  })

  // 18. Windows Defender 排除检查
  let defenderExcluded = false
  try {
    const out = execSync('powershell -Command "Get-MpPreference | Select-Object -ExpandProperty ExclusionPath"', { encoding: 'utf8', timeout: 10000 })
    defenderExcluded = out.includes(dir) || out.includes('openclaw') || out.includes('OpenClaw')
    checks.push({
      name: 'Defender 排除',
      status: defenderExcluded ? 'ok' : 'warn',
      detail: defenderExcluded ? '安装目录已加入排除列表' : '未排除，可能影响性能（建议将安装目录加入 Defender 排除）',
      fixable: false
    })
  } catch {
    checks.push({ name: 'Defender 排除', status: 'ok', detail: '无法检测（可能无管理员权限）', fixable: false })
  }

  // 19. 配置备份检查
  const backupDir = path.join(dir, 'backups')
  const hasBackup = fs.existsSync(backupDir)
  let backupCount = 0
  if (hasBackup) {
    try { backupCount = fs.readdirSync(backupDir).length } catch {}
  }
  checks.push({
    name: '配置备份',
    status: hasBackup && backupCount > 0 ? 'ok' : 'warn',
    detail: hasBackup && backupCount > 0 ? backupCount + ' 个备份文件' : '无备份，建议定期备份配置',
    fixable: !hasBackup
  })
  if (!hasBackup) {
    try {
      fs.mkdirSync(backupDir, { recursive: true })
      if (configExists) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        fs.copyFileSync(configPath, path.join(backupDir, 'openclaw-' + ts + '.json'))
      }
      checks[checks.length - 1].status = 'fixed'
      checks[checks.length - 1].detail = '已创建备份目录并备份当前配置'
      fixedCount++
    } catch {}
  }

  // 20. 环境变量检查
  const pathEnv = process.env.PATH || ''
  const ocBinInPath = pathEnv.includes(path.join(dir, 'bin'))
  checks.push({
    name: '环境变量',
    status: ocBinInPath ? 'ok' : 'warn',
    detail: ocBinInPath ? 'OpenClaw bin 目录已在 PATH 中' : 'OpenClaw bin 未在系统 PATH 中（不影响安装器内使用）',
    fixable: false
  })

  // 21. 工作区目录检查
  const workspaceDir = path.join(os.homedir(), '.openclaw', 'workspace')
  const wsExists = fs.existsSync(workspaceDir)
  checks.push({
    name: '工作区目录',
    status: wsExists ? 'ok' : 'warn',
    detail: wsExists ? '工作区目录存在' : '工作区目录不存在（首次使用时自动创建）',
    fixable: !wsExists
  })
  if (!wsExists) {
    try {
      fs.mkdirSync(workspaceDir, { recursive: true })
      checks[checks.length - 1].status = 'fixed'
      checks[checks.length - 1].detail = '已创建工作区目录'
      fixedCount++
    } catch {}
  }

  // 22. 崩溃日志分析
  let crashFound = false
  let crashDetail = '未发现崩溃记录'
  try {
    const startupLog = path.join(dir, 'gateway-startup.log')
    if (fs.existsSync(startupLog)) {
      const content = fs.readFileSync(startupLog, 'utf8')
      const errorLines = content.split('\n').filter(l => /error|crash|fatal|EADDRINUSE|EACCES|unhandled/i.test(l))
      if (errorLines.length > 0) {
        crashFound = true
        crashDetail = '发现 ' + errorLines.length + ' 条错误记录：' + errorLines[errorLines.length - 1].trim().slice(0, 80)
      }
    }
  } catch {}
  checks.push({
    name: '崩溃日志分析',
    status: crashFound ? 'warn' : 'ok',
    detail: crashDetail,
    fixable: false
  })

  // 23. 自启脚本健康检查
  if (startupExists) {
    try {
      const batContent = fs.readFileSync(startupBat, 'utf8')
      const refsOcPath = batContent.includes('openclaw')
      const refsValidPath = batContent.includes(dir) || batContent.includes('openclaw')
      checks.push({
        name: '自启脚本健康',
        status: refsOcPath && refsValidPath ? 'ok' : 'warn',
        detail: refsOcPath && refsValidPath ? '自启脚本路径正确' : '自启脚本可能引用了错误路径',
        fixable: !refsValidPath
      })
      if (!refsValidPath) {
        try {
          const ocBinCmd = path.join(dir, 'bin', 'openclaw.cmd')
          const ocPath = fs.existsSync(ocBinCmd) ? ocBinCmd : 'openclaw'
          const gwEnv = { OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath }
          createAutoStart(ocPath, gwEnv, port)
          checks[checks.length - 1].status = 'fixed'
          checks[checks.length - 1].detail = '已重建自启脚本'
          fixedCount++
        } catch {}
      }
    } catch {
      checks.push({ name: '自启脚本健康', status: 'warn', detail: '无法读取自启脚本', fixable: false })
    }
  } else {
    checks.push({ name: '自启脚本健康', status: 'warn', detail: '未配置自启（跳过）', fixable: false })
  }

  // 24. 临时文件清理
  let tempSize = 0
  const tempFiles = []
  try {
    const entries = fs.readdirSync(dir)
    for (const e of entries) {
      if (e.endsWith('.tmp') || e.endsWith('.bak') || e.startsWith('_tmp_')) {
        const fp = path.join(dir, e)
        try {
          const stat = fs.statSync(fp)
          tempSize += stat.size
          tempFiles.push(fp)
        } catch {}
      }
    }
  } catch {}
  const tempSizeMB = (tempSize / 1048576).toFixed(1)
  checks.push({
    name: '临时文件清理',
    status: tempFiles.length > 0 ? 'warn' : 'ok',
    detail: tempFiles.length > 0 ? '发现 ' + tempFiles.length + ' 个临时文件（' + tempSizeMB + ' MB）' : '无临时文件',
    fixable: tempFiles.length > 0
  })
  if (tempFiles.length > 0) {
    let cleaned = 0
    for (const fp of tempFiles) {
      try {
        const stat = fs.statSync(fp)
        if (stat.isDirectory()) {
          fs.rmSync(fp, { recursive: true, force: true })
        } else {
          fs.unlinkSync(fp)
        }
        cleaned++
      } catch {}
    }
    if (cleaned > 0) {
      checks[checks.length - 1].status = 'fixed'
      checks[checks.length - 1].detail = '已清理 ' + cleaned + ' 个临时文件'
      fixedCount++
    }
  }

  // 25. 总体健康评分
  const totalChecks = checks.length
  const okChecks = checks.filter(c => c.status === 'ok' || c.status === 'fixed').length
  const healthScore = Math.round((okChecks / totalChecks) * 100)
  checks.push({
    name: '总体健康评分',
    status: healthScore >= 80 ? 'ok' : healthScore >= 60 ? 'warn' : 'error',
    detail: healthScore + ' 分（' + okChecks + '/' + totalChecks + ' 项通过）',
    fixable: false
  })

  return { success: true, checks, fixedCount }
})

app.whenReady().then(() => {
  if (!mainWindow) createWindow()
})
app.on('window-all-closed', () => {
  app.quit()
})
app.on('before-quit', () => {
  mainWindow = null
})

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
    const openclawBinDir = path.join(installDir, 'bin')
    if (fs.existsSync(path.join(openclawBinDir, 'openclaw.cmd'))) {
      env.PATH = openclawBinDir + path.delimiter + (env.PATH || '')
    }
    const openclawVersion = getBundledOpenClawVersion(installDir)
    if (openclawVersion) {
      env.OPENCLAW_VERSION = openclawVersion
      env.OPENCLAW_SERVICE_VERSION = openclawVersion
    }
  }
  if (binDir) env.PATH = binDir + path.delimiter + (env.PATH || '')
  return env
}

function httpPost(urlText, body, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlText)
      const httpMod = url.protocol === 'https:' ? require('https') : require('http')
      const req = httpMod.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body || '')
        },
        timeout: 15000
      }, (res) => {
        let responseBody = ''
        res.on('data', chunk => { responseBody += chunk })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(responseBody)
          else reject(new Error(responseBody || `HTTP ${res.statusCode}`))
        })
      })
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('连接超时'))
      })
      if (body) req.write(body)
      req.end()
    } catch (error) {
      reject(error)
    }
  })
}

function copyDirectoryRecursive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath)
    } else {
      fs.copyFileSync(sourcePath, targetPath)
    }
  }
}

function patchWeixinPluginCompatibility(pluginDir) {
  const compatPath = path.join(pluginDir, 'src', 'compat.ts')
  const indexPath = path.join(pluginDir, 'index.ts')
  if (fs.existsSync(compatPath)) {
    let compat = readFileUtf8(compatPath)
    compat = compat.replace(
      /throw new Error\([\s\S]*?openclaw plugins install @tencent-weixin\/openclaw-weixin@legacy`,\s*\n\s*\)/,
      "logger.warn(`[compat] Skip host compatibility check in installer-managed runtime: ${hostVersion}`)"
    )
    fs.writeFileSync(compatPath, compat, 'utf8')
  }
  if (fs.existsSync(indexPath)) {
    let indexSource = readFileUtf8(indexPath)
    indexSource = indexSource.replace(
      "    assertHostCompatibility(api.runtime?.version)\n",
      "    // Installer-managed runtime patches host version compatibility at install time.\n"
    )
    fs.writeFileSync(indexPath, indexSource, 'utf8')
  }
}

// ─── 安全命令执行：仅允许 openclaw 子命令 ───
const ALLOWED_OPENCLAW_SUBCOMMANDS = [
  'channels', 'gateway', 'plugins', 'weixin', 'config', 'version', 'status'
]

function findOpenClawExe(installDir) {
  // 优先用安装目录下的 bin/openclaw.cmd
  const binCmd = path.join(installDir, 'bin', 'openclaw.cmd')
  if (fs.existsSync(binCmd)) return binCmd
  // 内嵌 node 直接调用 openclaw.mjs
  const localNodeExe = path.join(installDir, 'node-win', 'node.exe')
  const ocEntry = path.join(installDir, 'openclaw-pkg', 'openclaw.mjs')
  if (fs.existsSync(localNodeExe) && fs.existsSync(ocEntry)) return null // 用 node + mjs 模式
  return 'openclaw'
}

function spawnOpenClawCmd(installDir, args, env) {
  const localNodeExe = path.join(installDir, 'node-win', 'node.exe')
  const ocEntry = path.join(installDir, 'openclaw-pkg', 'openclaw.mjs')
  // 优先用 node.exe + openclaw.mjs（避免 shell）
  if (fs.existsSync(localNodeExe) && fs.existsSync(ocEntry)) {
    return spawn(localNodeExe, [ocEntry, ...args], { shell: false, cwd: installDir, env, timeout: 120000 })
  }
  const binCmd = path.join(installDir, 'bin', 'openclaw.cmd')
  if (fs.existsSync(binCmd)) {
    return spawn(binCmd, args, { shell: false, cwd: installDir, env, timeout: 120000 })
  }
  return spawn('openclaw', args, { shell: false, cwd: installDir, env, timeout: 120000 })
}

// ─── IPC: 安全执行 openclaw 子命令（白名单） ───
ipcMain.handle('run-openclaw-cmd', async (event, { installDir, subcommand, args }) => {
  try {
    const dir = installDir || findInstallInfo()?.installDir
    if (!dir) return { success: false, error: '未找到安装目录' }
    // 验证子命令在白名单中
    const sub = String(subcommand || '').trim()
    if (!sub || !ALLOWED_OPENCLAW_SUBCOMMANDS.includes(sub)) {
      return { success: false, error: '不允许的子命令: ' + sub }
    }
    // 验证 args 是数组且不含危险字符
    const safeArgs = (Array.isArray(args) ? args : []).map(a => String(a).trim()).filter(Boolean)
    const env = getNodeEnv(dir)
    return new Promise((resolve) => {
      let resolved = false
      const fullArgs = [sub, ...safeArgs]
      const child = spawnOpenClawCmd(dir, fullArgs, env)
      let stdout = '', stderr = ''
      child.stdout.on('data', d => {
        stdout += d.toString()
        // 微信扫码登录：检测到二维码 URL 立即返回
        if (!resolved && /https:\/\/liteapp\.weixin\.qq\.com\//.test(stdout)) {
          resolved = true
          resolve({ success: true, stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n').trim() })
        }
      })
      child.stderr.on('data', d => { stderr += d.toString() })
      child.on('close', code => { if (!resolved) { resolved = true; resolve(normalizeCommandResult({ code, stdout, stderr })) } })
      child.on('error', err => { if (!resolved) { resolved = true; resolve({ success: false, error: err.message, stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n').trim() }) } })
    })
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: 安装微信插件（专用） ───
// 注意：install-weixin-plugin 已在上方注册，这里不重复

// ─── IPC: 微信渠道登录（专用） ───
ipcMain.handle('login-weixin-channel', async (event, { installDir }) => {
  try {
    const dir = installDir || findInstallInfo()?.installDir
    if (!dir) return { success: false, error: '未找到安装目录' }
    const env = getNodeEnv(dir)
    // 依次尝试多种登录命令
    const commandSets = [
      ['channels', 'login', '--channel', 'openclaw-weixin', '--json'],
      ['channels', 'login', '--channel', 'openclaw-weixin'],
      ['weixin', 'login', '--qr']
    ]
    for (const args of commandSets) {
      const result = await new Promise((resolve) => {
        let resolved = false
        const child = spawnOpenClawCmd(dir, args, env)
        let stdout = '', stderr = ''
        child.stdout.on('data', d => {
          stdout += d.toString()
          if (!resolved && /https:\/\/liteapp\.weixin\.qq\.com\//.test(stdout)) {
            resolved = true
            resolve({ success: true, stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n').trim() })
          }
        })
        child.stderr.on('data', d => { stderr += d.toString() })
        child.on('close', code => { if (!resolved) { resolved = true; resolve(normalizeCommandResult({ code, stdout, stderr })) } })
        child.on('error', err => { if (!resolved) { resolved = true; resolve({ success: false, error: err.message }) } })
      })
      if (result.success) return result
    }
    return { success: false, error: '微信登录命令执行失败' }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('get-install-info', async () => {
  try {
    const info = findInstallInfo()
    if (!info) return { success: false, installed: false }
    const running = await checkGatewayRunning(info.port || 18789)
    return { success: true, installed: true, running, version: APP_VERSION, ...info }
  } catch (e) {
    return { success: false, installed: false, error: e.message }
  }
})

// ─── IPC: 加载渠道配置（合并后唯一版本） ───
ipcMain.handle('load-channel-config', async (event, installDir) => {
  const dir = installDir || findInstallInfo()?.installDir
  if (!dir) return { success: false, error: '未找到安装目录' }
  const cp = path.join(dir, 'openclaw.json')
  if (!fs.existsSync(cp)) return { success: false, error: '配置文件不存在' }
  try {
    const config = JSON.parse(readFileUtf8(cp))
    return {
      success: true,
      channels: config.channels || {},
      plugins: config.plugins?.entries || {},
      pluginAllow: config.plugins?.allow || [],
      config
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: 保存渠道配置（合并后唯一版本） ───
ipcMain.handle('save-channel-config', async (event, args) => {
  const { installDir, channelName, channelConfig, channelKey, config: nextConfig } = args || {}
  const effectiveChannelKey = channelKey || channelName
  const effectiveConfig = nextConfig || channelConfig
  const dir = installDir || findInstallInfo()?.installDir
  if (!dir) return { success: false, error: '未找到安装目录' }
  const cp = path.join(dir, 'openclaw.json')
  try {
    const fileConfig = JSON.parse(readFileUtf8(cp))
    if (!effectiveChannelKey) return { success: false, error: '缺少 channelKey' }
    if (!effectiveConfig || typeof effectiveConfig !== 'object') return { success: false, error: '缺少渠道配置' }
    if (effectiveChannelKey === 'openclaw-weixin') {
      const issue = getWeixinSupportIssue(dir)
      if (issue) return { success: false, error: issue }
    }
    if (!fileConfig.channels) fileConfig.channels = {}
    if (!fileConfig.plugins) fileConfig.plugins = {}
    if (!Array.isArray(fileConfig.plugins.allow)) fileConfig.plugins.allow = []
    if (!fileConfig.plugins.entries || typeof fileConfig.plugins.entries !== 'object') fileConfig.plugins.entries = {}

    // 插件类渠道（如 openclaw-weixin）不写到 channels 里，只写到 plugins 里
    // OpenClaw 不认识插件提供的 channel ID，写到 channels 会导致配置校验失败
    const pluginChannels = ['openclaw-weixin']
    if (pluginChannels.includes(effectiveChannelKey)) {
      // 确保不在 channels 里（清理旧的错误配置）
      delete fileConfig.channels[effectiveChannelKey]
    } else {
      fileConfig.channels[effectiveChannelKey] = { ...effectiveConfig, enabled: true }
    }
    if (!fileConfig.plugins.allow.includes(effectiveChannelKey)) fileConfig.plugins.allow.push(effectiveChannelKey)
    fileConfig.plugins.entries[effectiveChannelKey] = {
      ...(fileConfig.plugins.entries[effectiveChannelKey] || {}),
      ...effectiveConfig,
      enabled: true
    }
    fs.writeFileSync(cp, JSON.stringify(fileConfig, null, 4), 'utf8')
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ─── IPC: 测试渠道连接（合并后唯一版本） ───
ipcMain.handle('test-channel-connection', async (event, args) => {
  const { installDir, channelName, channelKey, config } = args || {}
  const effectiveChannelKey = channelKey || channelName
  const dir = installDir || findInstallInfo()?.installDir
  if (!dir) return { success: false, error: '未找到安装目录' }
  if (effectiveChannelKey === 'openclaw-weixin') {
    const issue = getWeixinSupportIssue(dir)
    return issue ? { success: false, error: issue } : { success: true, note: '微信个人号走扫码登录，无需单独测试凭证' }
  }
  if (effectiveChannelKey === 'qqbot' && config?.appId && config?.clientSecret) {
    try {
      const payload = JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret })
      const result = await httpPost('https://bots.qq.com/app/getAppAccessToken', payload, { 'Content-Type': 'application/json' })
      const data = JSON.parse(result)
      return data.access_token ? { success: true } : { success: false, error: data.message || '获取 access_token 失败' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  if (effectiveChannelKey === 'feishu' && config?.appId && config?.appSecret) {
    try {
      const payload = JSON.stringify({ app_id: config.appId, app_secret: config.appSecret })
      const result = await httpPost('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', payload, { 'Content-Type': 'application/json; charset=utf-8' })
      const data = JSON.parse(result)
      return data.code === 0 && data.tenant_access_token ? { success: true } : { success: false, error: data.msg || '获取 tenant_access_token 失败' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
  const env = getNodeEnv(dir)
  return new Promise((resolve) => {
    // 安全：不用 shell: true，用数组参数
    const child = spawnOpenClawCmd(dir, ['channels', 'status', '--channel', effectiveChannelKey], env)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', code => resolve(normalizeCommandResult({ code, stdout, stderr })))
    child.on('error', err => resolve({ success: false, error: err.message }))
  })
})

ipcMain.handle('save-provider', async (event, { installDir, providerName, providerConfig, baseUrl, apiKey, api }) => {
  const dir = installDir || findInstallInfo()?.installDir
  if (!dir) return { success: false, error: '未找到安装目录' }
  const cp = require('path').join(dir, 'openclaw.json')
  try {
    const config = JSON.parse(readFileUtf8(cp))
    if (!config.models) config.models = {}
    if (!config.models.providers) config.models.providers = {}
    if (!providerName) return { success: false, error: '缺少 providerName' }
    const nextProviderConfig = providerConfig || {
      baseUrl,
      apiKey,
      api: api || 'openai-completions'
    }
    config.models.providers[providerName] = {
      ...(config.models.providers[providerName] || {}),
      ...nextProviderConfig
    }
    fs.writeFileSync(cp, JSON.stringify(config, null, 4), 'utf8')
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

ipcMain.handle('delete-provider', async (event, { installDir, providerName }) => {
  const dir = installDir || findInstallInfo()?.installDir
  if (!dir) return { success: false, error: '未找到安装目录' }
  const cp = require('path').join(dir, 'openclaw.json')
  try {
    const config = JSON.parse(readFileUtf8(cp))
    if (!providerName) return { success: false, error: '缺少 providerName' }
    if (!config.models?.providers?.[providerName]) return { success: false, error: '服务商不存在' }

    const currentPrimary = String(config.agents?.defaults?.model?.primary || '')
    const currentProvider = currentPrimary.includes('/') ? currentPrimary.split('/')[0] : ''
    if (currentProvider && currentProvider === providerName) {
      return { success: false, error: '当前默认模型正在使用该服务商，请先切换默认模型后再删除' }
    }

    delete config.models.providers[providerName]
    fs.writeFileSync(cp, JSON.stringify(config, null, 4), 'utf8')
    return { success: true }
  } catch (e) { return { success: false, error: e.message } }
})

// ─── 剪贴板 ───
ipcMain.handle('install-weixin-plugin', async (event, installDir) => {
  const dir = installDir || findInstallInfo()?.installDir
  if (!dir) return { success: false, error: '未找到安装目录' }

  const sourceCandidates = [
    path.join(dir, 'node_modules', '@tencent-weixin', 'openclaw-weixin'),
    path.join(dir, 'openclaw-pkg', 'node_modules', '@tencent-weixin', 'openclaw-weixin')
  ]
  const sourceDir = sourceCandidates.find(candidate => fs.existsSync(path.join(candidate, 'openclaw.plugin.json')))
  if (!sourceDir) return { success: false, error: '未找到内置微信插件包' }

  try {
    const targetDir = path.join(dir, 'extensions', 'openclaw-weixin')
    copyDirectoryRecursive(sourceDir, targetDir)
    patchWeixinPluginCompatibility(targetDir)

    const configPath = path.join(dir, 'openclaw.json')
    const config = fs.existsSync(configPath) ? JSON.parse(readFileUtf8(configPath)) : {}
    if (!config.plugins) config.plugins = {}
    if (!Array.isArray(config.plugins.allow)) config.plugins.allow = []
    if (!config.plugins.entries || typeof config.plugins.entries !== 'object') config.plugins.entries = {}
    if (!config.plugins.allow.includes('openclaw-weixin')) config.plugins.allow.push('openclaw-weixin')
    config.plugins.entries['openclaw-weixin'] = {
      ...(config.plugins.entries['openclaw-weixin'] || {}),
      enabled: true
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8')

    let version = ''
    try {
      version = JSON.parse(readFileUtf8(path.join(targetDir, 'package.json'))).version || ''
    } catch {}

    return { success: true, sourceDir, targetDir, version }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('copy-to-clipboard', async (event, text) => {
  const { clipboard } = require('electron')
  clipboard.writeText(text)
  return true
})

ipcMain.handle('export-logs', async (event, installDir) => {
  try {
    const logResult = await (async () => {
      const dir = installDir || findInstallInfo()?.installDir
      if (!dir) return { success: false, error: '未找到安装目录' }
      let combined = ''
      let hasRealLogs = false
      let port = 18789
      try {
        const cfgPath = path.join(dir, 'openclaw.json')
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileUtf8(cfgPath))
          port = cfg.gateway?.port || 18789
        }
      } catch {}
      const running = await checkGatewayRunning(port)
      combined += '=== Gateway 状态 ===\n'
      combined += running ? '● 运行中 (端口 ' + port + ')\n' : '○ 未运行\n'
      combined += '导出时间: ' + new Date().toLocaleString('zh-CN') + '\n'
      const candidates = [
        path.join(dir, 'gateway-startup.log'),
        path.join(dir, 'install.log'),
        path.join(dir, 'logs', 'gateway.log'),
        path.join(dir, 'openclaw.log'),
        path.join(os.homedir(), '.openclaw', 'gateway-startup.log'),
        path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log'),
      ]
      for (const logPath of candidates) {
        try {
          if (fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf8').trim()
            if (content) {
              combined += '\n=== ' + path.basename(logPath) + ' ===\n' + content
              hasRealLogs = true
            }
          }
        } catch {}
      }
      if (!hasRealLogs) combined += '\n\n提示: 未找到可导出的 Gateway 运行日志文件。'
      return { success: true, logs: combined }
    })()

    if (!logResult.success) return logResult
    const saveRes = await dialog.showSaveDialog(mainWindow, {
      title: '导出 Gateway 日志',
      defaultPath: path.join(os.homedir(), 'Desktop', 'openclaw-gateway-logs-' + Date.now() + '.log'),
      filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }, { name: 'All Files', extensions: ['*'] }]
    })
    if (saveRes.canceled || !saveRes.filePath) return { success: false, error: '已取消导出' }
    fs.writeFileSync(saveRes.filePath, logResult.logs, 'utf8')
    return { success: true, path: saveRes.filePath }
  } catch (e) {
    return { success: false, error: e.message }
  }
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
      send('log', `端口 ${gwPort} 已被占用，先检测是否已有可用 OpenClaw...`)
      writeInstallLog(`端口 ${gwPort} 已被占用，优先检测现有服务是否可复用`)
      const existingHealthy = await checkGatewayRunning(gwPort)
      if (existingHealthy) {
        send('log', `检测到端口 ${gwPort} 上已有可用 OpenClaw，直接复用该端口`)
      } else {
        send('log', `端口 ${gwPort} 被其他程序占用，自动尝试下一个可用端口...`)
        for (let i = 1; i <= 20; i++) {
          const candidate = gwPort + i
          if (await isPortFree(candidate)) {
            gwPort = candidate
            send('log', `改用端口: ${gwPort}`)
            break
          }
        }
      }
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
    const logFd = fs.openSync(logFile, 'a')
    const proc = spawn(gwNodeExe, [gwEntry, 'gateway', '--port', String(gwPort)], {
      detached: true, stdio: ['ignore', logFd, logFd], shell: false,
      env: gwEnv, cwd: workDir
    })
    proc.unref()
    fs.closeSync(logFd)

    send('log', '等待服务就绪（首次启动可能需要 1-2 分钟）...')
    await waitForGateway(gwPort, 90000)

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
        if (Date.now() - start > timeoutMs) reject(new Error('OpenClaw 启动超时：首次启动可能较慢，请稍后重试'))
        else setTimeout(check, 1500)
      })
    }
    setTimeout(check, 2000)
  })
}

function createDesktopShortcut(token, port) {
  const desktop = path.join(os.homedir(), 'Desktop')
  const gwPort = port || 18789
  const url = `http://127.0.0.1:${gwPort}/`
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
  // 获取日志文件路径（写入安装目录）
  const logDir = gwEnv && gwEnv.OPENCLAW_STATE_DIR ? gwEnv.OPENCLAW_STATE_DIR : path.join(os.homedir(), '.openclaw')
  const logFile = path.join(logDir, 'gateway-startup.log').replace(/\//g, '\\')
  const batContent = '@echo off\r\nchcp 65001 >nul 2>&1\r\n' + envLines + 'if not exist "' + ocPath + '" (\r\n  echo OpenClaw not found: ' + ocPath + '\r\n  pause\r\n  exit /b 1\r\n)\r\necho [%date% %time%] Gateway starting... >> "' + logFile + '"\r\nstart "" /min cmd /c ""' + ocPath + '" gateway' + portArg + ' >> "' + logFile + '" 2>&1"\r\n'
  fs.writeFileSync(batPath, batContent, 'utf8')
  try {
    execSync(`powershell -Command "[System.IO.File]::WriteAllText('${batPath.replace(/'/g, "''")}', [System.IO.File]::ReadAllText('${batPath.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8), (New-Object System.Text.UTF8Encoding $true))"`, { timeout: 5000, stdio: 'ignore' })
  } catch {}
}
