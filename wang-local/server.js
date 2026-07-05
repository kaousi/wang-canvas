const express = require('express')
const http = require('http')
const https = require('https')
const path = require('path')
const fs = require('fs')
const url = require('url')
const crypto = require('crypto')
const zlib = require('zlib')
const multer = require('multer')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')

const uploadTmpDir = path.join(__dirname, 'tmp')
if (!fs.existsSync(uploadTmpDir)) fs.mkdirSync(uploadTmpDir, { recursive: true })
const upload = multer({
  dest: uploadTmpDir,
  limits: {
    fileSize: 1024 * 1024 * 1024,
    files: 128,
    fields: 128,
  },
})

// ── Load config ──
const configPath = path.join(__dirname, 'config.json')
function loadConfig() {
  const defaults = {
    port: 3456,
    apiBaseUrl: '',
    apiKey: '',
    model: '',
    authToken: '',
    openaiProfiles: [],
    activeOpenaiProfileId: '',
    openaiStreamingEnabled: true,
    outputFormat: 'png',
  }
  try {
    if (!fs.existsSync(configPath)) return defaults
    return { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) }
  } catch (err) {
    console.error('[Config] load failed, using defaults:', err.message)
    return defaults
  }
}
const config = loadConfig()
const PORT = config.port || 3456
let API_BASE = config.apiBaseUrl || ''
let API_KEY = config.apiKey || ''
const MODEL = config.model || ''
const AUTH_TOKEN = config.authToken || ''
let OPENAI_PROFILES = normalizeOpenAIProfiles(config)
let ACTIVE_OPENAI_PROFILE_ID = config.activeOpenaiProfileId || OPENAI_PROFILES[0]?.id || ''
let OPENAI_BASE = ''
let OPENAI_KEY = ''
let OPENAI_MODEL = ''
let OPENAI_STREAMING_ENABLED = normalizeOpenAIStreamingEnabled(config)
refreshActiveOpenAIGlobals()

const app = express()
app.use(express.json({ limit: '200mb' }))
app.use(express.urlencoded({ limit: '200mb', extended: true }))
app.use(express.text({ limit: '200mb' }))
app.use((err, _req, res, next) => {
  if (!err) return next()
  const message = err.type === 'entity.too.large'
    ? '上传内容过大，请减少单次上传数量或压缩文件后重试'
    : err.message || '请求解析失败'
  return res.status(200).json({ success: false, message, errMessage: message })
})

const imgDir = path.join(__dirname, 'generated')
const thumbsDir = path.join(imgDir, '.thumbs')
if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true })
if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true })

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', '*')
  res.header('Access-Control-Allow-Headers', '*')
  res.header('Access-Control-Expose-Headers', 'ETag, Location, x-oss-request-id')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// ── Helpers ──
const useOpenAI = () => !!(OPENAI_BASE && OPENAI_KEY)

function uid() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 24)
}

function mockSuccess(data = {}) {
  return { success: true, data }
}

function mockFail(msg = 'error') {
  return { success: false, message: msg }
}

function uploadSuccessPayload(fileUrl, asset = null) {
  return {
    success: true,
    url: fileUrl,
    fileUrl,
    imageUrl: fileUrl,
    asset,
    data: {
      url: fileUrl,
      fileUrl,
      imageUrl: fileUrl,
      asset,
    },
  }
}

function uploadSingleFile(req, res, next) {
  upload.single('file')(req, res, err => {
    if (!err) return next()
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? '文件过大，无法上传'
      : err.message || '上传失败'
    return res.status(200).json(mockFail(message))
  })
}

function mockRemoved(msg = '该模块已移除') {
  return { success: false, errCode: 'MODULE_REMOVED', errMessage: msg, message: msg }
}

function normalizeOpenAIProfile(profile = {}, index = 0) {
  const fallbackId = index === 0 ? 'default' : `profile_${index + 1}`
  return {
    id: String(profile.id || fallbackId).trim() || fallbackId,
    name: String(profile.name || profile.label || (index === 0 ? '默认配置' : `配置 ${index + 1}`)).trim() || `配置 ${index + 1}`,
    baseUrl: String(profile.baseUrl || profile.openaiBaseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(profile.apiKey || profile.openaiApiKey || ''),
    model: String(profile.model || profile.openaiModel || 'gpt-4o').trim() || 'gpt-4o',
  }
}

function normalizeOpenAIProfiles(source = {}) {
  const rawProfiles = Array.isArray(source.openaiProfiles) ? source.openaiProfiles : []
  let profiles = rawProfiles.map((profile, index) => normalizeOpenAIProfile(profile, index))
  const hasLegacy = source.openaiBaseUrl || source.openaiApiKey || source.openaiModel
  if (profiles.length === 0 && hasLegacy) {
    profiles = [normalizeOpenAIProfile({
      id: source.activeOpenaiProfileId || 'default',
      name: source.openaiProfileName || '默认配置',
      baseUrl: source.openaiBaseUrl || '',
      apiKey: source.openaiApiKey || '',
      model: source.openaiModel || 'gpt-4o',
    }, 0)]
  }
  const seen = new Set()
  return profiles.map((profile, index) => {
    let id = profile.id
    if (seen.has(id)) id = `${id}_${index + 1}`
    seen.add(id)
    return { ...profile, id }
  })
}

function normalizeOpenAIStreamingEnabled(source = {}) {
  if (source.openaiStreamingEnabled !== undefined) {
    return source.openaiStreamingEnabled !== false && source.openaiStreamingEnabled !== 'false' && source.openaiStreamingEnabled !== 0 && source.openaiStreamingEnabled !== '0'
  }
  const mode = source.openaiRequestMode || source.requestMode || source.streamMode
  if (mode !== undefined) {
    return !['non_stream', 'non-stream', 'blocking', 'false', '0'].includes(String(mode).trim().toLowerCase())
  }
  return true
}

function getActiveOpenAIProfile() {
  if (!Array.isArray(OPENAI_PROFILES) || OPENAI_PROFILES.length === 0) return null
  return OPENAI_PROFILES.find(profile => profile.id === ACTIVE_OPENAI_PROFILE_ID)
    || OPENAI_PROFILES.find(profile => profile.baseUrl && profile.apiKey)
    || OPENAI_PROFILES[0]
}

function refreshActiveOpenAIGlobals() {
  const active = getActiveOpenAIProfile()
  ACTIVE_OPENAI_PROFILE_ID = active?.id || ''
  OPENAI_BASE = (active?.baseUrl || '').replace(/\/+$/, '')
  OPENAI_KEY = active?.apiKey || ''
  OPENAI_MODEL = active?.model || config.openaiModel || 'gpt-4o'
}

function applyOpenAIConfigPayload(payload = {}) {
  if (Array.isArray(payload.openaiProfiles)) {
    OPENAI_PROFILES = normalizeOpenAIProfiles({ openaiProfiles: payload.openaiProfiles })
    ACTIVE_OPENAI_PROFILE_ID = String(payload.activeOpenaiProfileId || ACTIVE_OPENAI_PROFILE_ID || OPENAI_PROFILES[0]?.id || '')
  } else {
    const hasLegacy = payload.openaiBaseUrl !== undefined || payload.openaiApiKey !== undefined || payload.openaiModel !== undefined
    if (hasLegacy) {
      const active = getActiveOpenAIProfile() || {}
      const id = ACTIVE_OPENAI_PROFILE_ID || active.id || 'default'
      OPENAI_PROFILES = [normalizeOpenAIProfile({
        ...active,
        id,
        name: active.name || payload.openaiProfileName || '默认配置',
        baseUrl: payload.openaiBaseUrl !== undefined ? payload.openaiBaseUrl : active.baseUrl,
        apiKey: payload.openaiApiKey !== undefined ? payload.openaiApiKey : active.apiKey,
        model: payload.openaiModel !== undefined ? payload.openaiModel : active.model,
      }, 0)]
      ACTIVE_OPENAI_PROFILE_ID = id
    }
    if (payload.activeOpenaiProfileId !== undefined) {
      ACTIVE_OPENAI_PROFILE_ID = String(payload.activeOpenaiProfileId || '')
    }
  }
  refreshActiveOpenAIGlobals()
  if (
    payload.openaiStreamingEnabled !== undefined ||
    payload.openaiRequestMode !== undefined ||
    payload.requestMode !== undefined ||
    payload.streamMode !== undefined
  ) {
    OPENAI_STREAMING_ENABLED = normalizeOpenAIStreamingEnabled(payload)
  }
  config.openaiProfiles = OPENAI_PROFILES
  config.activeOpenaiProfileId = ACTIVE_OPENAI_PROFILE_ID
  config.openaiBaseUrl = OPENAI_BASE
  config.openaiApiKey = OPENAI_KEY
  config.openaiModel = OPENAI_MODEL
  config.openaiStreamingEnabled = OPENAI_STREAMING_ENABLED
}

function removedModuleInterceptor(req, res, next) {
  const p = req.path
  const removedMessage = '该模块已移除'
  const sendEmptyList = () => res.json(mockSuccess({ list: [], total: 0, totalCount: 0 }))
  const sendRemoved = () => res.json(mockRemoved(removedMessage))

  if (p === '/user/notifications') return res.json(mockSuccess({ list: [], total: 0, unreadCount: 0 }))
  if (p === '/user/notifications/read') return res.json(mockSuccess({}))
  if (p === '/user/invitation-codes') return res.json(mockSuccess([]))

  if (p === '/user/points-history/v2/project-summary') {
    return res.json(mockSuccess({ projectTitle: '', totalConsumedPoints: 0, items: [] }))
  }
  if (p === '/user/points-usage-stats') return res.json(mockSuccess({}))

  if (p.startsWith('/agent/membership/')) {
    if (p === '/agent/membership/current') {
      return res.json(mockSuccess({ level: 'FREE', levelCode: 'FREE', status: 'disabled', moduleRemoved: true }))
    }
    if (
      p === '/agent/membership/plans/v2' ||
      p === '/agent/membership/enterprise/levels'
    ) return res.json(mockSuccess([]))
    if (p === '/agent/membership/enterprise/name/check') return res.json(mockSuccess({ available: false }))
    return sendRemoved()
  }

  if (p.startsWith('/agent/pay/')) {
    if (p === '/agent/pay/recharge/configs') return res.json(mockSuccess([]))
    if (p === '/agent/pay/order/status') return res.json(mockSuccess({ status: 'closed', moduleRemoved: true }))
    return sendRemoved()
  }

  if (p === '/agent/coupon/validate') {
    return res.json(mockSuccess({ valid: false, usable: false, reason: removedMessage }))
  }

  if (p === '/agent/announcement/active') return res.json(mockSuccess(null))
  if (p === '/agent/capabilities/list') return res.json(mockSuccess([]))

  if (p.startsWith('/agent/trial-package/')) {
    if (p === '/agent/trial-package/list') return res.json(mockSuccess([]))
    if (p === '/agent/trial-package/current') return res.json(mockSuccess(null))
    return sendRemoved()
  }

  if (p.startsWith('/agent/competition-activity/')) {
    if (p.includes('/works') || p.includes('/award-works')) return sendEmptyList()
    if (p === '/agent/competition-activity/list' || p === '/agent/competition-activity/registered/list') {
      return res.json(mockSuccess([]))
    }
    if (req.method === 'GET') return res.json(mockSuccess(null))
    return sendRemoved()
  }

  if (p.startsWith('/agent/community/product/')) {
    if (p === '/agent/community/product/list') return res.json(mockSuccess([]))
    if (req.method === 'GET') return res.json(mockSuccess(null))
    return sendRemoved()
  }

  if (p.startsWith('/agent/project-collaboration/')) {
    if (
      p.endsWith('/query-invitations') ||
      p.endsWith('/query-members') ||
      p.endsWith('/query-operation-logs')
    ) return sendEmptyList()
    return sendRemoved()
  }
  if (p === '/ucenter/v1/session/dissolve') return sendRemoved()
  if (p === '/ucenter/enterprise/level/info') return res.json(mockSuccess({}))

  if (p.startsWith('/ucenter/v1/session/') || p.startsWith('/ucenter/v2/session/') || p.startsWith('/ucenter/v2/billing/points/')) {
    if (p.endsWith('/project-info')) return res.json(mockSuccess({ projectType: 0, role: 'CREATOR', isOwner: true }))
    if (p.endsWith('/user-limits')) return sendEmptyList()
    if (p.endsWith('/my-project-points')) return res.json(mockSuccess({ totalPoints: 0, usagePoints: 0, remainingPoints: 0 }))
    if (p.endsWith('/project-transactions')) return sendEmptyList()
    if (p.endsWith('/allocatable-points')) return res.json(mockSuccess({ totalPoints: 0, allocatablePoints: 0 }))
    return sendRemoved()
  }

  if (p.startsWith('/agent/story-canvas/session/share/')) {
    if (p.startsWith('/agent/story-canvas/session/share/info/')) {
      return res.json(mockSuccess({ shareCode: null, status: 0 }))
    }
    return sendRemoved()
  }

  if (p === '/agent/video-render/share') return sendRemoved()
  if (p === '/agent/video-render/shared/list') return sendEmptyList()
  if (p.startsWith('/agent/video-render/shared/')) return sendRemoved()
  if (p.startsWith('/agent/ai-creation/visual-record/share/')) return sendRemoved()

  next()
}

function guessImageMime(filename = '') {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

function imageExtFromMime(mime = '') {
  const type = mime.toLowerCase().split(';')[0].trim()
  if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg'
  if (type === 'image/webp') return 'webp'
  if (type === 'image/gif') return 'gif'
  return 'png'
}

function saveImageBuffer(prefix, buf, ext) {
  const safePrefix = String(prefix || 'image').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40)
  const name = `${safePrefix}_${uid()}.${ext || 'png'}`
  fs.writeFileSync(path.join(imgDir, name), buf)
  return `/generated/${name}`
}

function saveDataImageUrl(dataUrl, prefix = 'dataurl') {
  const match = String(dataUrl).match(/^data:(image\/[^;,]+);base64,([\s\S]+)$/)
  if (!match) throw new Error('unsupported data image')
  const mime = match[1]
  const ext = imageExtFromMime(mime)
  const buf = Buffer.from(match[2], 'base64')
  return saveImageBuffer(prefix, buf, ext)
}

function sanitizeDataImageUrls(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/') && value.includes(';base64,')) {
      return saveDataImageUrl(value, 'inline')
    }
    return value
  }
  if (!value || typeof value !== 'object' || depth > 20) return value
  if (seen.has(value)) return value
  seen.add(value)

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = sanitizeDataImageUrls(value[i], seen, depth + 1)
    }
    return value
  }

  for (const key of Object.keys(value)) {
    value[key] = sanitizeDataImageUrls(value[key], seen, depth + 1)
  }
  return value
}

function sanitizeJsonBodyImages(req, _res, next) {
  try {
    if (req.path === '/agent/upload-data-url') return next()
    if (req.body && typeof req.body === 'object') {
      sanitizeDataImageUrls(req.body)
    }
  } catch (err) {
    console.warn('[sanitize] data image cleanup skipped:', err.message)
  }
  next()
}

const localStorePath = path.join(imgDir, 'local-sessions.json')

function emptyLocalStore() {
  return { sessions: {}, canvases: {}, imageRecords: {}, generationRecords: [], assetRecords: [], sceneTemplateRecords: [] }
}

function loadLocalStore() {
  try {
    if (!fs.existsSync(localStorePath)) return emptyLocalStore()
    const parsed = JSON.parse(fs.readFileSync(localStorePath, 'utf-8'))
    return {
      ...emptyLocalStore(),
      ...parsed,
      sessions: parsed.sessions || {},
      canvases: parsed.canvases || {},
      imageRecords: parsed.imageRecords || {},
      generationRecords: Array.isArray(parsed.generationRecords) ? parsed.generationRecords : [],
      assetRecords: Array.isArray(parsed.assetRecords) ? parsed.assetRecords : [],
      sceneTemplateRecords: Array.isArray(parsed.sceneTemplateRecords) ? parsed.sceneTemplateRecords : [],
    }
  } catch (err) {
    console.warn('[local-store] failed to load:', err.message)
    return emptyLocalStore()
  }
}

let localStore = loadLocalStore()

function persistLocalStore() {
  try {
    const tmp = localStorePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(localStore, null, 2))
    fs.renameSync(tmp, localStorePath)
  } catch (err) {
    console.warn('[local-store] failed to save:', err.message)
  }
}

function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function sanitizeForStore(value) {
  const cloned = cloneJson(value)
  if (cloned && typeof cloned === 'object') sanitizeDataImageUrls(cloned)
  return cloned
}

function nowIso() {
  return new Date().toISOString()
}

function buildLocalSceneTemplate({ imageUrl = '' } = {}) {
  const hasReference = !!String(imageUrl || '').trim()
  return {
    label: hasReference ? '本地参考图站位' : '本地导演台站位',
    description: '本地 mock 生成的导演台站位模板，可直接导入后继续调整。',
    characters: [
      { role: '主角', offset: { x: -0.75, y: 0, z: 0 }, rotation: 12, pose: 'stand', bodyType: 'mannequin', color: '#d5cec5' },
      { role: '配角', offset: { x: 0.75, y: 0, z: 0.1 }, rotation: -12, pose: 'stand', bodyType: 'mannequin_female', color: '#c9d7f0' },
      { role: '背景人物', offset: { x: 0, y: 0, z: 1.25 }, rotation: 0, pose: 'stand', bodyType: 'mannequin_slim', color: '#f0d4c0' },
    ],
    cameras: [
      { label: '正面中景', position: { x: 0, y: 1.65, z: 5.8 }, lookAt: { x: 0, y: 1.15, z: 0.2 }, fov: 45 },
      { label: '侧面调度', position: { x: 4.2, y: 1.75, z: 3.2 }, lookAt: { x: 0, y: 1.1, z: 0.15 }, fov: 50 },
    ],
    props: [
      { assetId: 'area_marker', position: { x: 0, y: 0, z: 0.35 }, rotation: 0, scale: 1.25 },
      { assetId: 'image_board', position: { x: 0, y: 0, z: -2.2 }, rotation: 0, scale: 1.35 },
    ],
  }
}

function ensureSceneTemplateRecords() {
  if (!Array.isArray(localStore.sceneTemplateRecords)) localStore.sceneTemplateRecords = []
  return localStore.sceneTemplateRecords
}

function createLocalSceneTemplateRecord(body = {}) {
  const imageUrl = String(body.imageUrl || '').trim()
  const sessionId = String(body.sessionId || '').trim()
  const resultJson = buildLocalSceneTemplate({ imageUrl, sessionId })
  const record = {
    id: `scene_template_${uid()}`,
    taskId: `scene_template_task_${uid()}`,
    sessionId: sessionId || null,
    imageUrl,
    status: 1,
    resultJson,
    createTime: nowIso(),
    updateTime: nowIso(),
  }
  const records = ensureSceneTemplateRecords()
  records.unshift(record)
  localStore.sceneTemplateRecords = records.slice(0, 200)
  persistLocalStore()
  return record
}

function listLocalSceneTemplateRecords(query = {}) {
  const pageNum = Math.max(parseInt(query.pageNum) || 1, 1)
  const pageSize = Math.max(parseInt(query.pageSize) || 10, 1)
  const sessionId = String(query.sessionId || '').trim()
  const status = query.status
  let rows = ensureSceneTemplateRecords()
  if (sessionId) rows = rows.filter(r => !r.sessionId || r.sessionId === sessionId)
  if (status !== undefined && status !== null && status !== '') {
    rows = rows.filter(r => String(r.status ?? 1) === String(status))
  }
  const totalCount = rows.length
  const start = (pageNum - 1) * pageSize
  return {
    rows: rows.slice(start, start + pageSize),
    totalCount,
    pageNum,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  }
}

function sendSceneTemplateRecords(req, res) {
  const page = listLocalSceneTemplateRecords(req.method === 'GET' ? req.query || {} : req.body || {})
  res.json({
    success: true,
    data: page.rows,
    totalCount: page.totalCount,
    pageSize: page.pageSize,
    pageIndex: page.pageNum,
    totalPages: page.totalPages,
  })
}

function sessionNodeCount(session) {
  return Array.isArray(session?.nodes) ? session.nodes.length : 0
}

function ensureLocalSession(sessionId, seed = {}) {
  const id = String(sessionId || '').trim() || `session_${uid()}`
  if (!localStore.sessions[id]) {
    const ts = nowIso()
    localStore.sessions[id] = {
      sessionId: id,
      title: seed.title || seed.name || '无限画布',
      description: seed.description || '',
      imageUrl: seed.coverImageUrl || seed.imageUrl || null,
      nodes: Array.isArray(seed.nodes) ? sanitizeForStore(seed.nodes) : [],
      edges: Array.isArray(seed.edges) ? sanitizeForStore(seed.edges) : [],
      folderId: seed.folderId || null,
      projectType: seed.projectType ?? 1,
      createTime: seed.createTime || ts,
      updateTime: seed.updateTime || ts,
    }
  }
  return localStore.sessions[id]
}

function createLocalSession(body = {}) {
  const session = ensureLocalSession(`session_${uid()}`, body)
  persistLocalStore()
  return session
}

function updateLocalSession(sessionId, body = {}) {
  const session = ensureLocalSession(sessionId, body)
  if (body.title !== undefined) session.title = body.title || '无限画布'
  if (body.name !== undefined) session.title = body.name || session.title
  if (body.description !== undefined) session.description = body.description || ''
  if (body.coverImageUrl !== undefined) session.imageUrl = body.coverImageUrl || null
  if (body.imageUrl !== undefined) session.imageUrl = body.imageUrl || null
  if (body.folderId !== undefined) session.folderId = body.folderId || null
  if (body.projectType !== undefined) session.projectType = body.projectType
  if (Array.isArray(body.nodes)) session.nodes = sanitizeForStore(body.nodes)
  if (Array.isArray(body.edges)) session.edges = sanitizeForStore(body.edges)
  session.updateTime = nowIso()
  persistLocalStore()
  return session
}

function sessionSummary(session, extra = {}) {
  return {
    sessionId: session.sessionId,
    title: session.title || '无限画布',
    description: session.description || '',
    imageUrl: session.imageUrl || null,
    folderId: session.folderId || null,
    projectType: session.projectType ?? 1,
    createTime: session.createTime,
    updateTime: session.updateTime,
    nodeCount: sessionNodeCount(session),
    isOwner: true,
    ...extra,
  }
}

function sessionDetail(session) {
  hydrateLocalTaskNodes(session)
  sanitizeDataImageUrls(session)
  return {
    ...sessionSummary(session),
    nodes: Array.isArray(session.nodes) ? session.nodes : [],
    edges: Array.isArray(session.edges) ? session.edges : [],
  }
}

function listLocalSessions(query = {}) {
  const pageNum = Math.max(parseInt(query.pageNum) || 1, 1)
  const pageSize = Math.max(parseInt(query.pageSize) || 20, 1)
  const title = String(query.title || '').trim().toLowerCase()
  const folderId = query.folderId
  const projectType = query.projectType
  let rows = Object.values(localStore.sessions)
  if (title) rows = rows.filter(s => String(s.title || '').toLowerCase().includes(title))
  if (folderId) rows = rows.filter(s => s.folderId === folderId)
  if (projectType === 0 || projectType === '0' || projectType === 1 || projectType === '1') {
    rows = rows.filter(s => String(s.projectType ?? 1) === String(projectType))
  }
  rows.sort((a, b) => String(b.updateTime || '').localeCompare(String(a.updateTime || '')))
  const totalCount = rows.length
  const start = (pageNum - 1) * pageSize
  return { rows: rows.slice(start, start + pageSize), totalCount, pageNum, pageSize }
}

function sendSessionList(req, res, options = {}) {
  const { rows, totalCount, pageNum, pageSize } = listLocalSessions(req.query || {})
  const data = rows.map(s => sessionSummary(s, options.v3 ? { itemType: 1 } : {}))
  res.json({
    success: true,
    data,
    totalCount,
    pageSize,
    pageIndex: pageNum,
    totalPages: Math.ceil(totalCount / pageSize),
  })
}

function itemKey(item, type) {
  if (!item || typeof item !== 'object') return null
  if (item.id) return String(item.id)
  if (type === 'edge' && item.source && item.target) {
    return `e-${item.source}-${item.target}-${item.sourceHandle || 'default'}-${item.targetHandle || 'default'}`
  }
  return null
}

function applyCollectionAction(current, incoming, action, type) {
  if (!Array.isArray(incoming) || incoming.length === 0) return current
  const map = new Map((Array.isArray(current) ? current : []).map(item => [itemKey(item, type), item]).filter(([key]) => key))
  if (action === 'delete' || action === 'remove') {
    incoming.forEach(item => {
      const key = itemKey(item, type)
      if (key) map.delete(key)
    })
    return Array.from(map.values())
  }
  incoming.forEach(item => {
    const key = itemKey(item, type)
    if (key) map.set(key, sanitizeForStore(item))
  })
  return Array.from(map.values())
}

function applyBatchOperation(sessionId, actions = []) {
  const session = ensureLocalSession(sessionId)
  const results = actions.map(action => {
    try {
      const name = String(action?.action || '').toLowerCase()
      session.nodes = applyCollectionAction(session.nodes, action?.nodes, name, 'node')
      session.edges = applyCollectionAction(session.edges, action?.edges, name, 'edge')
      return { success: true }
    } catch (err) {
      return { success: false, errorMessage: err.message }
    }
  })
  session.updateTime = nowIso()
  persistLocalStore()
  return results
}

function isLocalGeneratedTaskId(taskId) {
  return /^gen_task_/.test(String(taskId || ''))
}

function normalizeTaskResultData(resultData) {
  const items = Array.isArray(resultData) ? resultData : resultData ? [resultData] : []
  return items.map(item => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object') {
      return item.url || item.imageUrl || item.videoUrl || item.audioUrl || item.resultUrl || ''
    }
    return ''
  }).filter(Boolean)
}

function nodeResultData(data = {}) {
  const urls = normalizeTaskResultData(data.inputImageUrls)
  if (urls.length > 0) return urls
  if (data.result?.imageUrl) return [data.result.imageUrl]
  if (data.imageUrl) return [data.imageUrl]
  return []
}

function localTaskStatusPayload(taskId) {
  const id = String(taskId || '').trim()
  if (!id) return null
  const task = aiTasks.get(id)
  if (!task) {
    if (!isLocalGeneratedTaskId(id)) return null
    return {
      taskId: id,
      nodeKey: '',
      dataType: 'image',
      status: 'FAILED',
      resultData: [],
      errorMessage: '本地任务状态已丢失，请重新生成',
    }
  }
  const status = task.status === 'completed' ? 'SUCCESS' : task.status === 'failed' ? 'FAILED' : 'PROCESSING'
  return {
    taskId: id,
    nodeKey: task.nodeKey || '',
    dataType: task.dataType || 'image',
    status,
    resultData: task.status === 'completed' ? normalizeTaskResultData(task.resultData) : [],
    errorMessage: task.errorMessage || null,
  }
}

function applyTaskPayloadToNode(node, payload) {
  if (!node?.data || !payload) return false
  if (payload.status !== 'SUCCESS' && payload.status !== 'FAILED') return false
  const data = node.data
  const before = JSON.stringify({
    status: data.status,
    inputImageUrls: data.inputImageUrls,
    isGenerating: data.isGenerating,
    generatingMessage: data.generatingMessage,
    hasError: data.hasError,
    errorMessage: data.errorMessage,
  })

  data.status = payload.status
  data.isGenerating = false
  data.generatingMessage = ''
  if (payload.status === 'SUCCESS') {
    const urls = normalizeTaskResultData(payload.resultData)
    if (urls.length > 0) data.inputImageUrls = urls
    data.hasError = false
    data.errorMessage = ''
  } else {
    data.hasError = true
    data.errorMessage = payload.errorMessage || '图片生成失败'
  }

  const after = JSON.stringify({
    status: data.status,
    inputImageUrls: data.inputImageUrls,
    isGenerating: data.isGenerating,
    generatingMessage: data.generatingMessage,
    hasError: data.hasError,
    errorMessage: data.errorMessage,
  })
  return before !== after
}

function syncTaskResultToLocalNodes(taskId, payload = localTaskStatusPayload(taskId)) {
  if (!payload || (payload.status !== 'SUCCESS' && payload.status !== 'FAILED')) return false
  let changed = false
  Object.values(localStore.sessions || {}).forEach(session => {
    let sessionChanged = false
    ;(session.nodes || []).forEach(node => {
      if (String(node?.data?.taskId || '') === String(taskId || '')) {
        sessionChanged = applyTaskPayloadToNode(node, payload) || sessionChanged
      }
    })
    if (sessionChanged) {
      session.updateTime = nowIso()
      changed = true
    }
  })
  if (changed) persistLocalStore()
  return changed
}

function hydrateLocalTaskNodes(session) {
  if (!session || !Array.isArray(session.nodes)) return false
  let changed = false
  session.nodes.forEach(node => {
    const data = node?.data || {}
    const status = String(data.status || '').toUpperCase()
    const isPending = status === 'PENDING' || status === 'PROCESSING' || data.isGenerating === true
    if (!isPending || !isLocalGeneratedTaskId(data.taskId)) return
    changed = applyTaskPayloadToNode(node, localTaskStatusPayload(data.taskId)) || changed
  })
  if (changed) {
    session.updateTime = nowIso()
    persistLocalStore()
  }
  return changed
}

function findLocalNode(nodeKey) {
  const id = String(nodeKey || '').trim()
  if (!id) return null
  for (const session of Object.values(localStore.sessions || {})) {
    const node = (session.nodes || []).find(item => String(item?.id || '') === id)
    if (node) return { session, node }
  }
  return null
}

function localLatestGeneration(nodeKey) {
  const found = findLocalNode(nodeKey)
  if (!found) return null
  const data = found.node.data || {}
  const status = String(data.status || '').toUpperCase()
  if (status === 'SUCCESS') {
    return {
      taskId: data.taskId || null,
      nodeKey,
      dataType: found.node.type === 'video' ? 'video' : 'image',
      status: 'SUCCESS',
      resultData: nodeResultData(data),
      errorMessage: null,
    }
  }
  const taskPayload = localTaskStatusPayload(data.taskId)
  if (taskPayload) return taskPayload
  if (status === 'FAILED') {
    return {
      taskId: data.taskId || null,
      nodeKey,
      dataType: found.node.type === 'video' ? 'video' : 'image',
      status: 'FAILED',
      resultData: [],
      errorMessage: data.errorMessage || '生成失败',
    }
  }
  return null
}

function ensureGenerationRecords() {
  if (!Array.isArray(localStore.generationRecords)) localStore.generationRecords = []
  return localStore.generationRecords
}

function ensureAssetRecords() {
  if (!Array.isArray(localStore.assetRecords)) localStore.assetRecords = []
  return localStore.assetRecords
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12)
}

function isoFromTime(value) {
  if (!value) return nowIso()
  if (typeof value === 'number') return new Date(value).toISOString()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString()
}

function statusToLocalStatus(status) {
  const value = String(status || '').toUpperCase()
  if (value === 'COMPLETED' || value === 'SUCCESS') return 'SUCCESS'
  if (value === 'FAILED' || value === 'FAIL') return 'FAILED'
  return 'PROCESSING'
}

function assetTypeFromUrl(url, fallback = 'image') {
  const clean = String(url || '').split('?')[0].toLowerCase()
  if (/\.(mp4|mov|webm|m4v|avi|mkv)$/.test(clean)) return 'video'
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(clean)) return 'audio'
  if (/\.(spz|ply|glb|gltf|obj|fbx|splat|usdz)$/.test(clean)) return 'world'
  return fallback || 'image'
}

const localAssetCategories = [
  { code: 'character', name: '人物', sortOrder: 10 },
  { code: 'scene', name: '场景', sortOrder: 20 },
  { code: 'item', name: '物品', sortOrder: 30 },
  { code: 'style', name: '风格', sortOrder: 40 },
  { code: 'sound_effect', name: '音效', sortOrder: 50 },
  { code: 'other', name: '其他', sortOrder: 90 },
]

function filenameFromUrl(url, fallback = 'asset') {
  try {
    const pathname = /^https?:\/\//.test(String(url || '')) ? new URL(url).pathname : String(url || '')
    const name = decodeURIComponent(path.basename(pathname.split('?')[0] || ''))
    return name || fallback
  } catch {
    return fallback
  }
}

function toolTypeFromSource(source) {
  const value = String(source || '').toLowerCase()
  if (value.includes('pose')) return 'POSE_REFERENCE'
  if (value.includes('angle')) return 'SINGLE_ANGLE_VIEW'
  if (value.includes('markup')) return 'MARK_MODIFICATION'
  if (value.includes('outpaint')) return 'IMAGE_OUTPAINTING'
  if (value.includes('light')) return 'LIGHTING_MODIFICATION'
  if (value.includes('upscale')) return 'IMAGE_UPSCALE'
  return 'IMAGE_GENERATION'
}

function generationTypeFromRecord(record = {}) {
  const inputs = normalizeImageUrlList(record.inputImageUrls)
  return inputs.length > 0 ? 'IMAGE_TO_IMAGE' : 'TEXT_TO_IMAGE'
}

function generationRecordView(record = {}) {
  const urls = normalizeTaskResultData(record.resultData || record.urls || record.url)
  const createTime = record.createTime || record.createdAt || nowIso()
  const updateTime = record.updateTime || createTime
  return {
    id: record.id || `generation_${record.taskId || uid()}`,
    taskId: record.taskId || null,
    nodeKey: record.nodeKey || '',
    sessionId: record.sessionId || '',
    dataType: record.dataType || 'image',
    assetType: record.assetType || record.dataType || 'image',
    status: statusToLocalStatus(record.status),
    source: record.source || 'generate-image',
    toolType: record.toolType || toolTypeFromSource(record.source),
    prompt: record.prompt || '',
    model: record.model || record.modelName || OPENAI_MODEL || '',
    modelName: record.modelName || record.model || OPENAI_MODEL || '',
    size: record.size || '',
    aspectRatio: record.aspectRatio || '',
    quality: record.quality || '',
    outputFormat: record.outputFormat || '',
    inputImageUrls: normalizeImageUrlList(record.inputImageUrls),
    resultData: urls,
    urls,
    url: urls[0] || '',
    imageUrl: urls[0] || '',
    errorMessage: record.errorMessage || null,
    createTime,
    updateTime,
    createdAt: createTime,
    updatedAt: updateTime,
    imageRef: {
      generationType: record.generationType || generationTypeFromRecord(record),
      prompt: record.prompt || '',
      modelName: record.modelName || record.model || OPENAI_MODEL || '',
      urls,
      url: urls[0] || '',
      imageUrl: urls[0] || '',
      inputImageUrls: normalizeImageUrlList(record.inputImageUrls),
    },
  }
}

function assetRecordView(record = {}) {
  const urls = normalizeTaskResultData(record.urls || record.url || record.imageUrl)
  const url = urls[0] || record.assetUrl || ''
  const assetType = record.assetType || record.type || assetTypeFromUrl(url, record.dataType || 'image')
  const createTime = record.createTime || record.createdAt || nowIso()
  const updateTime = record.updateTime || createTime
  const id = record.assetId || record.materialId || record.id || `asset_${shortHash(url || record.textContent || uid())}`
  const name = record.assetName || record.name || record.fileName || filenameFromUrl(url, assetType === 'text' ? '文本素材' : assetType)
  return {
    id,
    assetId: id,
    materialId: id,
    taskId: record.taskId || null,
    generationId: record.generationId || null,
    nodeKey: record.nodeKey || '',
    sessionId: record.sessionId || '',
    assetType,
    assetCategory: record.assetCategory || record.category || 'other',
    assetName: name,
    assetUrl: url,
    dataType: record.dataType || assetType,
    type: assetType,
    source: record.source || 'local',
    name,
    fileName: record.fileName || filenameFromUrl(url, assetType),
    prompt: record.prompt || '',
    textContent: record.textContent || '',
    duration: record.duration || 0,
    remark: record.remark || '',
    toolType: record.toolType || toolTypeFromSource(record.source),
    url,
    urls,
    imageUrl: assetType === 'image' ? url : '',
    videoUrl: assetType === 'video' ? url : '',
    audioUrl: assetType === 'audio' ? url : '',
    createTime,
    updateTime,
    createdAt: createTime,
    updatedAt: updateTime,
  }
}

function upsertGenerationRecord(record = {}) {
  const rows = ensureGenerationRecords()
  const view = generationRecordView(record)
  const index = rows.findIndex(item => item.id === view.id || (view.taskId && item.taskId === view.taskId))
  if (index >= 0) rows[index] = generationRecordView({ ...rows[index], ...view, updateTime: view.updateTime || nowIso() })
  else rows.unshift(view)
  localStore.generationRecords = rows
    .map(generationRecordView)
    .sort((a, b) => String(b.updateTime || b.createTime || '').localeCompare(String(a.updateTime || a.createTime || '')))
    .slice(0, 500)
  return index >= 0 ? localStore.generationRecords.find(item => item.id === view.id || item.taskId === view.taskId) : view
}

function upsertAssetRecord(record = {}) {
  const rows = ensureAssetRecords()
  const view = assetRecordView(record)
  if (!view.url && !view.textContent) return null
  const index = rows.findIndex(item => item.id === view.id || item.assetId === view.assetId || (view.taskId && item.taskId === view.taskId && item.url === view.url) || (view.url && item.url === view.url))
  if (index >= 0) rows[index] = assetRecordView({ ...rows[index], ...view, updateTime: view.updateTime || nowIso() })
  else rows.unshift(view)
  localStore.assetRecords = rows
    .map(assetRecordView)
    .sort((a, b) => String(b.updateTime || b.createTime || '').localeCompare(String(a.updateTime || a.createTime || '')))
    .slice(0, 1000)
  return index >= 0 ? localStore.assetRecords.find(item => item.id === view.id || item.assetId === view.assetId || (view.url && item.url === view.url)) : view
}

function recordAssetsForGeneration(record = {}) {
  const view = generationRecordView(record)
  view.urls.forEach((url, index) => {
    upsertAssetRecord({
      id: `asset_${view.taskId || view.id}_${index}_${shortHash(url)}`,
      generationId: view.id,
      taskId: view.taskId,
      nodeKey: view.nodeKey,
      sessionId: view.sessionId,
      assetType: view.dataType || 'image',
      dataType: view.dataType || 'image',
      source: view.source,
      prompt: view.prompt,
      toolType: view.toolType,
      url,
      urls: [url],
      name: filenameFromUrl(url, `${view.source || 'image'}_${index + 1}`),
      createTime: view.createTime,
      updateTime: view.updateTime,
    })
  })
}

function recordGenerationStart(meta = {}) {
  const ts = isoFromTime(meta.createdAt || Date.now())
  const record = upsertGenerationRecord({
    id: `generation_${meta.taskId}`,
    taskId: meta.taskId,
    nodeKey: meta.nodeKey || '',
    sessionId: meta.sessionId || '',
    dataType: meta.dataType || 'image',
    status: 'PROCESSING',
    source: meta.source || 'generate-image',
    prompt: meta.prompt || '',
    model: meta.model || '',
    modelName: meta.model || '',
    size: meta.size || '',
    aspectRatio: meta.aspectRatio || '',
    quality: meta.quality || '',
    outputFormat: meta.outputFormat || '',
    inputImageUrls: meta.inputImageUrls || [],
    resultData: [],
    createTime: ts,
    updateTime: ts,
  })
  persistLocalStore()
  return record
}

function recordGenerationFinal(taskId) {
  const task = aiTasks.get(String(taskId || ''))
  if (!task) return null
  const status = statusToLocalStatus(task.status)
  const existing = ensureGenerationRecords().find(item => item.taskId === taskId) || {}
  const record = upsertGenerationRecord({
    ...existing,
    id: existing.id || `generation_${taskId}`,
    taskId,
    nodeKey: task.nodeKey || existing.nodeKey || '',
    sessionId: task.sessionId || existing.sessionId || '',
    dataType: task.dataType || existing.dataType || 'image',
    status,
    source: task.source || existing.source || 'generate-image',
    prompt: task.prompt || existing.prompt || '',
    model: task.model || existing.model || '',
    modelName: task.model || existing.modelName || '',
    size: task.size || existing.size || '',
    aspectRatio: task.aspectRatio || existing.aspectRatio || '',
    quality: task.quality || existing.quality || '',
    outputFormat: task.outputFormat || existing.outputFormat || '',
    inputImageUrls: task.inputImageUrls || existing.inputImageUrls || [],
    resultData: status === 'SUCCESS' ? normalizeTaskResultData(task.resultData) : [],
    errorMessage: task.errorMessage || null,
    createTime: existing.createTime || isoFromTime(task.createdAt),
    updateTime: nowIso(),
  })
  if (record.status === 'SUCCESS') recordAssetsForGeneration(record)
  persistLocalStore()
  return record
}

function hydrateLocalRecordsFromSessions() {
  let changed = false
  Object.values(localStore.sessions || {}).forEach(session => {
    const sessionId = session.sessionId || ''
    ;(session.nodes || []).forEach(node => {
      const data = node?.data || {}
      const nodeKey = node?.id || ''
      const resultUrls = nodeResultData(data)
      resultUrls.forEach((url, index) => {
        const asset = upsertAssetRecord({
          id: `asset_node_${nodeKey}_${index}_${shortHash(url)}`,
          taskId: data.taskId || null,
          nodeKey,
          sessionId,
          assetType: node.type === 'video' ? 'video' : 'image',
          dataType: node.type === 'video' ? 'video' : 'image',
          source: data.type || data.mediaSource || 'node',
          prompt: data.prompt || data.localPrompt || '',
          url,
          urls: [url],
          name: data.label || data.fileName || filenameFromUrl(url, '图片'),
          createTime: isoFromTime(data.createdAt || session.createTime),
          updateTime: session.updateTime || nowIso(),
        })
        if (asset) changed = true
      })

      if (!data.taskId) return
      const status = statusToLocalStatus(data.status || (data.hasError ? 'FAILED' : 'SUCCESS'))
      const record = upsertGenerationRecord({
        id: `generation_${data.taskId}`,
        taskId: data.taskId,
        nodeKey,
        sessionId,
        dataType: node.type === 'video' ? 'video' : 'image',
        status,
        source: data.type || 'generate-image',
        prompt: data.prompt || data.localPrompt || '',
        model: data.model || data.modelName || '',
        modelName: data.modelName || data.model || '',
        inputImageUrls: data.connectedImageUrls || [],
        resultData: status === 'SUCCESS' ? resultUrls : [],
        errorMessage: data.errorMessage || null,
        createTime: isoFromTime(data.createdAt || session.createTime),
        updateTime: session.updateTime || nowIso(),
      })
      if (record.status === 'SUCCESS') recordAssetsForGeneration(record)
      changed = true
    })
  })
  if (changed) persistLocalStore()
  return changed
}

function pageFromQuery(query = {}) {
  const pageNum = Math.max(parseInt(query.pageNum || query.pageIndex) || 1, 1)
  const pageSize = Math.max(parseInt(query.pageSize) || 20, 1)
  return { pageNum, pageSize }
}

function listLocalGenerationRecords(query = {}) {
  hydrateLocalRecordsFromSessions()
  let rows = ensureGenerationRecords().map(generationRecordView)
  const nodeKey = String(query.nodeKey || '').trim()
  const sessionId = String(query.sessionId || '').trim()
  const status = String(query.status || '').trim().toUpperCase()
  if (nodeKey) rows = rows.filter(row => String(row.nodeKey || '') === nodeKey)
  if (sessionId) rows = rows.filter(row => String(row.sessionId || '') === sessionId)
  if (status && status !== 'ALL') rows = rows.filter(row => String(row.status || '').toUpperCase() === status)
  if (!status) rows = rows.filter(row => String(row.status || '').toUpperCase() === 'SUCCESS' && normalizeTaskResultData(row.urls || row.resultData || row.url).length > 0)
  rows.sort((a, b) => String(b.updateTime || b.createTime || '').localeCompare(String(a.updateTime || a.createTime || '')))
  const { pageNum, pageSize } = pageFromQuery(query)
  const start = (pageNum - 1) * pageSize
  return {
    rows: rows.slice(start, start + pageSize),
    totalCount: rows.length,
    pageNum,
    pageSize,
    totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
  }
}

function listLocalAssetRecords(query = {}) {
  hydrateLocalRecordsFromSessions()
  let rows = ensureAssetRecords().map(assetRecordView)
  const sessionId = String(query.sessionId || '').trim()
  const assetType = String(query.assetType || query.type || '').trim().toLowerCase()
  const assetCategory = String(query.assetCategory || query.category || query.materialCategory || '').trim().toLowerCase()
  const keyword = String(query.keyword || query.name || '').trim().toLowerCase()
  if (sessionId) rows = rows.filter(row => !row.sessionId || String(row.sessionId || '') === sessionId)
  if (assetType && assetType !== 'all') rows = rows.filter(row => String(row.assetType || '').toLowerCase() === assetType)
  if (assetCategory && assetCategory !== 'all') rows = rows.filter(row => String(row.assetCategory || '').toLowerCase() === assetCategory)
  if (keyword) rows = rows.filter(row => String(row.assetName || row.name || row.fileName || row.url || row.textContent || row.remark || '').toLowerCase().includes(keyword))
  rows.sort((a, b) => String(b.updateTime || b.createTime || '').localeCompare(String(a.updateTime || a.createTime || '')))
  const { pageNum, pageSize } = pageFromQuery(query)
  const start = (pageNum - 1) * pageSize
  return {
    rows: rows.slice(start, start + pageSize),
    totalCount: rows.length,
    pageNum,
    pageSize,
    totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
  }
}

function findLocalAssetRef(taskId) {
  hydrateLocalRecordsFromSessions()
  const id = String(taskId || '').trim()
  if (!id) return null
  const generation = ensureGenerationRecords().map(generationRecordView).find(item => item.taskId === id || item.id === id)
  if (generation) return generation
  const asset = ensureAssetRecords().map(assetRecordView).find(item => item.taskId === id || item.id === id || item.generationId === id)
  if (!asset) return null
  return {
    ...asset,
    resultData: asset.urls,
    imageRef: {
      generationType: 'IMAGE_TO_IMAGE',
      urls: asset.urls,
      url: asset.url,
      imageUrl: asset.imageUrl || asset.url,
      prompt: asset.prompt || '',
    },
  }
}

function ensureLocalCanvas(canvasId, seed = {}) {
  const id = String(canvasId || '').trim() || `canvas_${uid()}`
  if (!localStore.canvases[id]) {
    const ts = nowIso()
    localStore.canvases[id] = {
      canvasId: id,
      sessionId: seed.sessionId || 'session_001',
      nodes: Array.isArray(seed.nodes) ? sanitizeForStore(seed.nodes) : [],
      edges: Array.isArray(seed.edges) ? sanitizeForStore(seed.edges) : [],
      createTime: ts,
      updateTime: ts,
    }
  }
  return localStore.canvases[id]
}

function updateLocalCanvas(body = {}) {
  const canvas = ensureLocalCanvas(body.canvasId || body.id, body)
  if (body.sessionId !== undefined) canvas.sessionId = body.sessionId
  if (Array.isArray(body.nodes)) canvas.nodes = sanitizeForStore(body.nodes)
  if (Array.isArray(body.edges)) canvas.edges = sanitizeForStore(body.edges)
  canvas.updateTime = nowIso()
  persistLocalStore()
  return canvas
}

function publicUrlForObject(objectKey) {
  const key = String(objectKey || '').replace(/^\/+/, '').replace(/^generated\//, '')
  return `/${key}`
}

function sendOssXml(res, xml, headers = {}) {
  res.set({
    ETag: headers.etag || `"${uid()}"`,
    Location: headers.location || '',
    'x-oss-request-id': uid(),
  })
  return res.type('application/xml').status(200).send(xml)
}

function readRequestBuffer(req, done) {
  if (Buffer.isBuffer(req.body)) return done(req.body)
  if (typeof req.body === 'string') return done(Buffer.from(req.body))
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return done(Buffer.from(JSON.stringify(req.body)))
  }
  if (req.readableEnded) return done(Buffer.alloc(0))
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => done(Buffer.concat(chunks)))
  req.on('error', () => done(Buffer.alloc(0)))
}

function parseResizeWidth(req) {
  const process = req.query?.['x-oss-process']
  if (typeof process !== 'string' || !process.includes('image/resize')) return null
  const widthMatch = process.match(/(?:^|,)w_(\d+)/)
  const heightMatch = process.match(/(?:^|,)h_(\d+)/)
  const width = widthMatch ? Number(widthMatch[1]) : 0
  const height = heightMatch ? Number(heightMatch[1]) : 0
  const size = Math.max(width, height)
  if (!Number.isFinite(size) || size <= 0) return null
  return Math.min(Math.max(Math.round(size), 16), 2048)
}

function wantsImageInfo(req) {
  const process = req.query?.['x-oss-process']
  return typeof process === 'string' && process.includes('image/info')
}

function readImageSize(fp) {
  const buf = fs.readFileSync(fp)
  if (buf.length >= 24 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), size: buf.length }
  }
  if (buf.length >= 10 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset < buf.length) {
      if (buf[offset] !== 0xff) break
      const marker = buf[offset + 1]
      const length = buf.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), size: buf.length }
      }
      offset += 2 + length
    }
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
        size: buf.length,
      }
    }
  }
  return { width: 1024, height: 1024, size: buf.length }
}

function resolveLocalImagePath(rootDir, requestPath, prefix) {
  const pathname = decodeURIComponent(new URL(requestPath, 'http://localhost').pathname)
  const rel = pathname.replace(new RegExp(`^/${prefix}/?`), '')
  const base = path.resolve(rootDir)
  const fp = path.resolve(rootDir, rel)
  if (!fp.startsWith(base + path.sep)) return null
  return fp
}

function resizeWithSips(source, target, maxSize) {
  return new Promise((resolve, reject) => {
    const child = spawn('sips', ['-Z', String(maxSize), source, '--out', target], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0 && fs.existsSync(target)) resolve()
      else reject(new Error(`sips exited with ${code}`))
    })
  })
}

function makeThumbPath(source, maxSize) {
  const stat = fs.statSync(source)
  const ext = path.extname(source) || '.png'
  const key = crypto.createHash('sha1').update(`${source}:${stat.mtimeMs}:${stat.size}:${maxSize}`).digest('hex')
  return path.join(thumbsDir, `${key}${ext}`)
}

function serveResizedLocalImage(rootDir, prefix) {
  return async (req, res, next) => {
    if (wantsImageInfo(req)) {
      const source = resolveLocalImagePath(rootDir, req.originalUrl, prefix)
      if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) return next()
      try {
        const info = readImageSize(source)
        return res.json({
          ImageWidth: { value: String(info.width) },
          ImageHeight: { value: String(info.height) },
          FileSize: { value: String(info.size) },
        })
      } catch (err) {
        console.warn('[image-info] failed:', err.message)
        return next()
      }
    }

    const maxSize = parseResizeWidth(req)
    if (!maxSize) return next()

    const source = resolveLocalImagePath(rootDir, req.originalUrl, prefix)
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) return next()

    try {
      const thumb = makeThumbPath(source, maxSize)
      if (!fs.existsSync(thumb)) {
        await resizeWithSips(source, thumb, maxSize)
      }
      res.set('Cache-Control', 'public, max-age=31536000, immutable')
      res.type(guessImageMime(thumb))
      const stream = fs.createReadStream(thumb)
      stream.on('error', next)
      stream.pipe(res)
    } catch (err) {
      console.warn('[thumbnail] fallback to original:', err.message)
      next()
    }
  }
}

// ── In-memory AI task store ──
const aiTasks = new Map()
const runEvents = new Map()

// ── OpenAI API helpers ──
function resolveOpenAIUrl(apiPath) {
  const base = OPENAI_BASE.replace(/\/+$/, '')
  // 如果 base 已经包含版本前缀（如 /v1），去掉 apiPath 中的版本前缀
  const hasVer = /\/v\d+$/.test(base)
  const path = hasVer ? apiPath.replace(/^\/v\d+/, '') : apiPath
  return base + path
}

function openAIRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = resolveOpenAIUrl(apiPath)
    const parsed = new URL(fullUrl)
    const bodyStr = body ? JSON.stringify(body) : null
    console.log('[openAI] %s %s body=%s', method, fullUrl, bodyStr ? bodyStr.slice(0, 300) : '(empty)')
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      }
    }
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr)
    const proto = parsed.protocol === 'https:' ? https : http
    const req = proto.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error?.message || parsed.message || `API error ${res.statusCode}`))
          } else {
            resolve(parsed)
          }
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`))
        }
      })
    })
    req.setTimeout(480000, () => req.destroy(new Error('API 请求超时')))
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

function escapeMultipartValue(value) {
  return String(value).replace(/"/g, '%22').replace(/\r?\n/g, ' ')
}

function buildMultipartBody(fields, files) {
  const boundary = '----wang-' + uid()
  const chunks = []
  const push = chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))

  Object.entries(fields || {}).forEach(([name, value]) => {
    if (value === undefined || value === null) return
    const values = Array.isArray(value) ? value : [value]
    values.forEach(item => {
      if (item === undefined || item === null) return
      push(`--${boundary}\r\n`)
      push(`Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n`)
      push(String(item))
      push('\r\n')
    })
  })

  ;(files || []).forEach(file => {
    push(`--${boundary}\r\n`)
    push(`Content-Disposition: form-data; name="${escapeMultipartValue(file.name)}"; filename="${escapeMultipartValue(file.filename)}"\r\n`)
    push(`Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`)
    push(file.data)
    push('\r\n')
  })

  push(`--${boundary}--\r\n`)
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

function openAIFormRequest(method, apiPath, fields, files) {
  return new Promise((resolve, reject) => {
    const fullUrl = resolveOpenAIUrl(apiPath)
    const parsed = new URL(fullUrl)
    const { body, contentType } = buildMultipartBody(fields, files)
    console.log('[openAI] %s %s multipart fields=%s files=%d', method, fullUrl, Object.keys(fields || {}).join(','), files?.length || 0)
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: {
        'Content-Type': contentType,
        'Content-Length': body.length,
        'Authorization': `Bearer ${OPENAI_KEY}`,
      }
    }
    const proto = parsed.protocol === 'https:' ? https : http
    const req = proto.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error?.message || parsed.message || `API error ${res.statusCode}`))
          } else {
            resolve(parsed)
          }
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`))
        }
      })
    })
    req.setTimeout(480000, () => req.destroy(new Error('API 请求超时')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function openAIStreamChat(body, onEvent, onError, onDone) {
  const base = OPENAI_BASE.replace(/\/+$/, '')
  const hasVer = /\/v\d+$/.test(base)
  const path = hasVer ? '/chat/completions' : '/v1/chat/completions'
  const fullUrl = base + path
  const parsed = new URL(fullUrl)
  const bodyStr = JSON.stringify({ ...body, stream: true })
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Accept': 'text/event-stream',
    }
  }
  options.headers['Content-Length'] = Buffer.byteLength(bodyStr)
  const proto = parsed.protocol === 'https:' ? https : http
  const req = proto.request(options, (res) => {
    let buffer = ''
    let fullContent = ''
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6)
          if (jsonStr === '[DONE]') {
            if (onDone) onDone(fullContent)
            return
          }
          try {
            const data = JSON.parse(jsonStr)
            const delta = data.choices?.[0]?.delta
            if (delta && delta.content) {
              fullContent += delta.content
              if (onEvent) onEvent({ content: delta.content, fullContent })
            }
            if (data.choices?.[0]?.finish_reason) {
              if (onDone) onDone(fullContent)
            }
          } catch { /* skip parse errors */ }
        }
      }
    })
    res.on('end', () => {})
  })
  req.setTimeout(480000, () => req.destroy(new Error('API 流式请求超时')))
  req.on('error', (err) => {
    if (onError) onError(err)
  })
  req.write(bodyStr)
  req.end()
  return req
}

// ── Static files ──
app.use('/generated', serveResizedLocalImage(imgDir, 'generated'))
app.use('/dify', serveResizedLocalImage(path.join(imgDir, 'dify'), 'dify'))
app.use('/generated', express.static(path.join(__dirname, 'generated')))
app.use('/dify', express.static(path.join(__dirname, 'generated', 'dify')))
app.get('/assets/PoseEditorDialog-D7BFxdwD.js', (req, res) => {
  const fp = path.join(__dirname, 'assets', 'PoseEditorDialog-D7BFxdwD.js')
  let src = fs.readFileSync(fp, 'utf8')
  if (src.includes('data-pose-select')) {
    res.set('Content-Type', 'application/javascript; charset=utf-8')
    res.set('Cache-Control', 'no-store')
    return res.send(src)
  }
  src = src.replace(
    'h=o(500),_=o("")',
    'h=o(500),Aa=o("png"),Ba=o(92),Ca=o(0),Da=o(0),Oa=Pa=>{if(!K.visible)return;const Qa=Pa.composedPath?.().find?.(Ra=>Ra?.dataset?.poseOption)||((Pa.target?.nodeType===1?Pa.target:Pa.target?.parentElement)?.closest?.(".pose-editor-dialog .output-settings button[data-pose-option]"));if(!Qa||!Qa.closest?.(".pose-editor-dialog"))return;const Ra=Qa.dataset.poseOption||Qa.textContent.trim();if(Ra==="PNG"||Ra==="png")Aa.value="png";else if(Ra==="JPEG"||Ra==="jpeg")Aa.value="jpeg";else if(Ra==="低"||Ra==="low")Ba.value=30;else if(Ra==="中"||Ra==="medium")Ba.value=60;else if(Ra==="高"||Ra==="high")Ba.value=92;else if(Ra==="自动"||Ra==="auto"||Ra==="reference"){Ca.value=0;Da.value=0}else if(Ra==="1K"){Ca.value=1024;Da.value=1024}else if(Ra==="2K"){Ca.value=2048;Da.value=2048}else if(Ra==="4K"){Ca.value=4096;Da.value=4096}},_=o("")'
  )
  src = src.replace(
    'X("confirm",{imagePoseUrl:a.url,imageUrl:p.value,description:_.value,prompt:"参考图2修改图1的人物姿势，禁止出现火柴人，去除噪点，保持人物一一致性"+(_.value?"「"+_.value+"」":"")})',
    'X("confirm",{imagePoseUrl:a.url,imageUrl:p.value,description:_.value,outputFormat:Aa.value,quality:Ba.value===30?"low":Ba.value===60?"medium":"high",size:Ca.value===0?"auto":Ca.value===1024?"1K":Ca.value===2048?"2K":"4K",aspectRatio:(ge.value?.width&&ge.value?.height?((a=>{const r={1/1:"1:1",5/4:"5:4",9/16:"9:16",21/9:"21:9",16/9:"16:9",4/3:"4:3",3/2:"3:2",4/5:"4:5",3/4:"3:4",2/3:"2:3"};const t=ge.value.width/ge.value.height;let o="1:1",i=Infinity;for(const[s,e]of Object.entries(r)){const n=Math.abs(t-parseFloat(s));n<i&&(i=n,o=e)}return o})(0):"1:1"),width:ge.value?.width||0,height:ge.value?.height||0,prompt:"图一人物换成图二火柴人的姿势，禁止出现火柴人，去除噪点"+(_.value?"「"+_.value+"」":"")})'
  )
  const btnUI = 'd("div",{class:"output-settings pose-option-settings","data-pose-select":"v6",onMousedown:Oa,onClick:Oa},[d("div",{class:"output-setting-group"},[d("span",{class:"setting-label"},"格式"),d("div",{class:"pose-option-grid two"},[d("button",{class:Aa.value==="jpeg"?"option-card pose-option-card active":"option-card pose-option-card",type:"button","data-pose-option":"jpeg","aria-pressed":Aa.value==="jpeg"?"true":"false"},"JPEG"),d("button",{class:Aa.value==="png"?"option-card pose-option-card active":"option-card pose-option-card",type:"button","data-pose-option":"png","aria-pressed":Aa.value==="png"?"true":"false"},"PNG")])]),d("div",{class:"output-setting-group"},[d("span",{class:"setting-label"},"质量"),d("div",{class:"pose-option-grid three"},[d("button",{class:Ba.value===30?"option-card pose-option-card active":"option-card pose-option-card",type:"button","data-pose-option":"low","aria-pressed":Ba.value===30?"true":"false"},"低"),d("button",{class:Ba.value===60?"option-card pose-option-card active":"option-card pose-option-card",type:"button","data-pose-option":"medium","aria-pressed":Ba.value===60?"true":"false"},"中"),d("button",{class:Ba.value===92?"option-card pose-option-card active":"option-card pose-option-card",type:"button","data-pose-option":"high","aria-pressed":Ba.value===92?"true":"false"},"高")])]),d("div",{class:"output-setting-group"},[d("span",{class:"setting-label"},"尺寸"),d("div",{class:"pose-option-grid four"},[d("button",{class:Ca.value===0&&Da.value===0?"option-card pose-option-card active":"option-card pose-option-card",type:"button","data-pose-option":"auto","aria-pressed":Ca.value===0&&Da.value===0?"true":"false"},"自动"),d("button",{class:Ca.value===1024&&Da.value===1024?"option-card pose-option-card active":"option-card pose-option-card",type:"button","data-pose-option":"1K","aria-pressed":Ca.value===1024&&Da.value===1024?"true":"false"},"1K"),d("button",{class:Ca.value===2048&&Da.value===2048?"option-card pose-option-card active":"option-card pose-option-card",type:"button","data-pose-option":"2K","aria-pressed":Ca.value===2048&&Da.value===2048?"true":"false"},"2K"),d("button",{class:Ca.value===4096&&Da.value===4096?"option-card pose-option-card active":"option-card pose-option-card",type:"button","data-pose-option":"4K","aria-pressed":Ca.value===4096&&Da.value===4096?"true":"false"},"4K")])])]),'
  src = src.replace(
    'd("div",Ze,[',
    'd("div",Ze,[' + btnUI
  )
  src = src.replace(
    'const r=await new Promise(s=>{i.toBlob(y=>{s(y)},"image/png")});if(!r)throw new Error("生成图片失败");const t=new File([r],`pose_${Date.now()}.png`,{type:"image/png"}),a=await ue(t,"pose-editor");X("confirm",{imagePoseUrl:a.url,imageUrl:p.value,description:_.value,outputFormat:Aa.value,quality:Ba.value===30?"low":Ba.value===60?"medium":"high",size:Ca.value===0?"auto":Ca.value===1024?"1K":Ca.value===2048?"2K":"4K",aspectRatio:(ge.value?.width&&ge.value?.height?((a=>{const r={1/1:"1:1",5/4:"5:4",9/16:"9:16",21/9:"21:9",16/9:"16:9",4/3:"4:3",3/2:"3:2",4/5:"4:5",3/4:"3:4",2/3:"2:3"};const t=ge.value.width/ge.value.height;let o="1:1",i=Infinity;for(const[s,e]of Object.entries(r)){const n=Math.abs(t-parseFloat(s));n<i&&(i=n,o=e)}return o})(0):"1:1"),width:ge.value?.width||0,height:ge.value?.height||0,prompt:"图一人物换成图二火柴人的姿势，禁止出现火柴人，去除噪点"+(_.value?"「"+_.value+"」":"")})',
    'const Oa=Aa.value==="jpeg"?"image/jpeg":"image/png";const Pa=Aa.value==="jpeg"?Ba.value/100:void 0;const Qa=Aa.value==="jpeg"?"jpg":"png";const Ra=Ca.value>0?(g.value>=h.value?Ca.value:Math.round(Ca.value*(g.value/h.value))):g.value;const Sa=Da.value>0?(h.value>=g.value?Da.value:Math.round(Da.value*(h.value/g.value))):h.value;const Ta=document.createElement("canvas");Ta.width=Ra;Ta.height=Sa;const Ua=Ta.getContext("2d");Ua.drawImage(i,0,0,Ra,Sa);const r=await new Promise(s=>{Ta.toBlob(y=>{s(y)},Oa,Pa)});if(!r)throw new Error("生成图片失败");const t=new File([r],`pose_${Date.now()}.${Qa}`,{type:Oa}),a=await ue(t,"pose-editor");X("confirm",{imagePoseUrl:a.url,imageUrl:p.value,description:_.value,outputFormat:Aa.value,quality:Ba.value===30?"low":Ba.value===60?"medium":"high",size:Ca.value===0?"auto":Ca.value===1024?"1K":Ca.value===2048?"2K":"4K",aspectRatio:(ge.value?.width&&ge.value?.height?((a=>{const r={1/1:"1:1",5/4:"5:4",9/16:"9:16",21/9:"21:9",16/9:"16:9",4/3:"4:3",3/2:"3:2",4/5:"4:5",3/4:"3:4",2/3:"2:3"};const t=ge.value.width/ge.value.height;let o="1:1",i=Infinity;for(const[s,e]of Object.entries(r)){const n=Math.abs(t-parseFloat(s));n<i&&(i=n,o=e)}return o})(0):"1:1"),width:ge.value?.width||0,height:ge.value?.height||0,prompt:"图一人物换成图二火柴人的姿势，禁止出现火柴人，去除噪点"+(_.value?"「"+_.value+"」":"")})'
  )
  res.set('Content-Type', 'application/javascript; charset=utf-8')
  res.set('Cache-Control', 'no-store')
  res.send(src)
})
const legacyIconPrefix = ['neo', 'wow'].join('')
app.get(`/assets/${legacyIconPrefix}_icon.png`, (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.type('image/png').sendFile(path.join(__dirname, 'assets', 'wang_icon.png'))
})
app.get(`/assets/${legacyIconPrefix}_icon_l.png`, (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.type('image/png').sendFile(path.join(__dirname, 'assets', 'wang_icon_l.png'))
})
app.get('/wang_icon.png', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.type('image/png').sendFile(path.join(__dirname, 'assets', 'wang_icon.png'))
})
app.get('/wang_icon_l.png', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.type('image/png').sendFile(path.join(__dirname, 'assets', 'wang_icon_l.png'))
})
app.get('/logo-xwow-text.png', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.type('image/png').sendFile(path.join(__dirname, 'assets', 'wang_icon_l.png'))
})
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  setHeaders: (res, fp) => {
    if (fp.endsWith('.js')) {
      res.set('Content-Type', 'application/javascript; charset=utf-8')
      res.set('Cache-Control', 'no-store')
    }
    if (fp.endsWith('.css')) {
      res.set('Content-Type', 'text/css; charset=utf-8')
      res.set('Cache-Control', 'no-store')
    }
  }
}))
app.get('/auth-mock.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'auth-mock.js'))
})
app.get('/settings-ui.js', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.type('application/javascript').sendFile(path.join(__dirname, 'settings-ui.js'))
})
app.get('/config.json', (req, res) => {
  if (fs.existsSync(configPath)) return res.type('application/json').sendFile(configPath)
  res.json(config)
})

// ── Redirect unwanted SPA routes to workflow ──
app.get(['/', '/neo-tv', '/home', '/inputSection'], (req, res) => {
  res.redirect('/workflows')
})

// ── Dynamic OpenAI config API (for settings UI) ──
app.get('/api/openai-config', (req, res) => {
  const activeProfile = getActiveOpenAIProfile()
  res.json({
    apiBaseUrl: API_BASE,
    apiKey: API_KEY,
    openaiProfiles: OPENAI_PROFILES,
    activeOpenaiProfileId: ACTIVE_OPENAI_PROFILE_ID,
    activeOpenaiProfile: activeProfile,
    openaiBaseUrl: OPENAI_BASE,
    openaiApiKey: OPENAI_KEY,
    openaiModel: OPENAI_MODEL,
    openaiStreamingEnabled: OPENAI_STREAMING_ENABLED,
  })
})

app.put('/api/openai-config', (req, res) => {
  const { apiBaseUrl, apiKey, outputFormat } = req.body || {}
  if (apiBaseUrl !== undefined) API_BASE = apiBaseUrl.replace(/\/+$/, '')
  if (apiKey !== undefined) API_KEY = apiKey
  applyOpenAIConfigPayload(req.body || {})
  config.apiBaseUrl = API_BASE
  config.apiKey = API_KEY
  if (outputFormat !== undefined) config.outputFormat = outputFormat
  config.openaiStreamingEnabled = OPENAI_STREAMING_ENABLED
  try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)) } catch (e) { console.error('[Config] save failed:', e.message) }
  const activeProfile = getActiveOpenAIProfile()
  console.log(`[Config] API Base: ${API_BASE || '(mock)'} | OpenAI: ${activeProfile?.name || '(none)'} ${OPENAI_BASE} | Model: ${OPENAI_MODEL} | Key: ${OPENAI_KEY ? '✓' : '✗'} | Request: ${OPENAI_STREAMING_ENABLED ? 'stream' : 'non-stream'}`)
  res.json({ success: true })
})

// ── Proxy middleware (checks API_BASE at request time) ──
app.use(sanitizeJsonBodyImages)
app.use(removedModuleInterceptor)
app.use((req, res, next) => {
  if (req.path === '/workflow' && req.query?.sessionId && !req.query?.workspaceId) {
    const params = new URLSearchParams(req.query)
    params.set('workspaceId', req.query.sessionId)
    params.delete('sessionId')
    return res.redirect(302, `/workflow?${params.toString()}`)
  }
  next()
})
app.use((req, res, next) => {
  const p = req.path
  const localStoryImageTaskPaths = new Set([
    '/agent/story-canvas/generate-image',
    '/agent/story-canvas/batch-query-status',
    '/agent/story-canvas/latest-generation',
    '/agent/story-canvas/pose-reference',
    '/agent/story-canvas/convert-angle',
  ])
  if (p.startsWith('/assets/') || p === '/auth-mock.js') return next()
  if (p.startsWith('/local/') || p.startsWith('/generated/') || p.startsWith('/dify/')) return next()
  if (p === '/agent/upload-data-url' || p === '/agent/upload-local') return next()
  if (p.startsWith('/api/') && (p === '/api/openai-config' || p.startsWith('/api/openai-config/'))) return next()
  if (localStoryImageTaskPaths.has(p) || p.startsWith('/agent/story-canvas/generate-image/result/')) return next()
  if (p.startsWith('/user/') || p.startsWith('/agent/') || p.startsWith('/ucenter/') || p.startsWith('/api/')) {
    if (API_BASE) return proxyRequest(req, res)
    return next()
  }
  res.set('Cache-Control', 'no-store')
  res.sendFile(path.join(__dirname, 'index.html'))
})

// ── Mock routes (always registered, used when API_BASE is empty) ──
  // User Auth
  app.post('/user/login/send-unified-code', (req, res) => res.json(mockSuccess({})))
  app.post('/user/login/unified-login/identity', (req, res) => res.json(mockSuccess({ userId: 'local_user_001', token: 'mock-token', nickname: '本地用户', mobile: '138****8888' })))
  app.post('/user/login/logout', (req, res) => res.json(mockSuccess()))
  app.post('/user/login/check-exist', (req, res) => res.json(mockSuccess({ exists: true })))
  app.post('/user/login/password', (req, res) => res.json(mockSuccess({ userId: 'local_user_001', token: 'mock-token' })))
  app.post('/user/login/register', (req, res) => res.json(mockSuccess()))
  app.post('/user/mobile/bind', (req, res) => res.json(mockSuccess()))
  app.get('/user/invitation-codes', (req, res) => res.json(mockSuccess([])))
  app.post('/user/login/activate/:code', (req, res) => res.json(mockSuccess()))
  app.post('/user/login/select-identity', (req, res) => res.json(mockSuccess()))
  app.get('/user/login/active-sessions', (req, res) => res.json(mockSuccess([])))
  app.post('/user/login/logout-device', (req, res) => res.json(mockSuccess()))
  app.post('/user/oauth/authorize/login', (req, res) => res.json(mockSuccess()))
  app.get('/user/profile', (req, res) => res.json(mockSuccess({ userId: 'local_user_001', nickname: '本地用户', mobile: '138****8888', avatar: null, status: 'active' })))
  app.put('/user/profile', (req, res) => res.json(mockSuccess()))
  app.get('/user/points-info', (req, res) => res.json(mockSuccess({ pointsBalance: 99999, pointsDetails: [] })))
  app.get('/user/points-history/v2', (req, res) => res.json(mockSuccess({ list: [], total: 0 })))
  app.get('/user/points-history/v2/project-summary', (req, res) => res.json(mockSuccess({})))
  app.get('/user/points-usage-stats', (req, res) => res.json(mockSuccess({})))
  app.get('/user/notifications', (req, res) => res.json(mockSuccess({ list: [], total: 0 })))
  app.put('/user/notifications/read', (req, res) => res.json(mockSuccess()))
  app.post('/user/login/active-sessions', (req, res) => res.json(mockSuccess([])))

  // Workflow / Session
  app.get('/agent/chat/session/:id', (req, res) => res.json(mockSuccess({ sessionId: req.params.id, title: '本地工作流', status: 'active' })))
  app.post('/agent/chat/session/update', (req, res) => res.json(mockSuccess()))
  app.get('/agent/chat/sessions', (req, res) => res.json(mockSuccess({ list: [], total: 0 })))
  app.delete('/agent/chat/conversation/:id', (req, res) => res.json(mockSuccess()))
  app.delete('/agent/ai-creation/visual-record/:id', (req, res) => res.json(mockSuccess()))
  app.post('/agent/chat/conversation', (req, res) => res.json(mockSuccess({ conversationId: 'conv_001' })))
  app.post('/agent/chat/optimize-prompt', (req, res) => res.json(mockSuccess()))
  app.get('/agent/chat/image-generation-result/:id', (req, res) => res.json(mockSuccess({ status: 'completed', imageUrl: null })))
  app.post('/agent/chat/regenerate-image/:id', (req, res) => res.json(mockSuccess()))
  app.post('/agent/chat/stop-response/:id', (req, res) => res.json(mockSuccess()))
  app.post('/agent/chat/clear-context/:id', (req, res) => res.json(mockSuccess()))
  app.get('/agent/chat/user/messages', (req, res) => res.json(mockSuccess([])))

  // Canvas
  app.get('/agent/canvas/list', (req, res) => {
    const list = Object.values(localStore.canvases).map(canvas => ({
      canvasId: canvas.canvasId,
      sessionId: canvas.sessionId,
      nodes: canvas.nodes || [],
      edges: canvas.edges || [],
      updateTime: canvas.updateTime,
    }))
    res.json(mockSuccess({ list, total: list.length }))
  })
  app.put('/agent/canvas/update', (req, res) => {
    const canvas = updateLocalCanvas(req.body || {})
    res.json(mockSuccess(canvas))
  })
  app.post('/agent/canvas/create', (req, res) => {
    const canvas = ensureLocalCanvas(`canvas_${uid()}`, req.body || {})
    persistLocalStore()
    res.json(mockSuccess({ canvasId: canvas.canvasId }))
  })
  app.delete('/agent/canvas/:id', (req, res) => {
    delete localStore.canvases[req.params.id]
    persistLocalStore()
    res.json(mockSuccess())
  })
  app.get('/agent/canvas/detail/:id', (req, res) => {
    const canvas = ensureLocalCanvas(req.params.id)
    res.json(mockSuccess(canvas))
  })
  app.post('/agent/canvas/shot/create', (req, res) => res.json(mockSuccess({ shotId: 'shot_001' })))
  app.delete('/agent/canvas/shot/:id', (req, res) => res.json(mockSuccess()))
  app.put('/agent/canvas/shot/edit', (req, res) => res.json(mockSuccess()))
  app.put('/agent/canvas/shot-order', (req, res) => res.json(mockSuccess()))
  app.post('/agent/canvas/material/add', (req, res) => {
    const body = req.body || {}
    const urlValue = body.assetUrl || body.url || body.imageUrl || body.videoUrl || body.audioUrl || body.materialUrl
    const urls = normalizeTaskResultData(body.urls || urlValue)
    const textContent = String(body.textContent || body.content || '').trim()
    if (urls.length === 0 && !textContent) return res.json(mockFail('assetUrl is required'))
    const sourceItems = urls.length > 0 ? urls : ['']
    const records = sourceItems.map((itemUrl, index) => upsertAssetRecord({
      id: body.assetId || body.id || body.materialId || `asset_manual_${shortHash(itemUrl || textContent || uid())}_${index}`,
      assetId: body.assetId || body.id || body.materialId || undefined,
      materialId: body.materialId || body.assetId || body.id || undefined,
      sessionId: body.sessionId || '',
      nodeKey: body.nodeKey || '',
      taskId: body.taskId || null,
      assetType: body.assetType || body.type || assetTypeFromUrl(itemUrl, textContent ? 'text' : (body.dataType || 'image')),
      dataType: body.dataType || body.assetType || body.type || assetTypeFromUrl(itemUrl, textContent ? 'text' : 'image'),
      assetCategory: body.assetCategory || body.category || body.materialCategory || 'other',
      source: body.source || 'manual',
      assetName: body.assetName || body.name || body.fileName || filenameFromUrl(itemUrl, textContent ? '文本素材' : '素材'),
      name: body.assetName || body.name || body.fileName || filenameFromUrl(itemUrl, textContent ? '文本素材' : '素材'),
      fileName: body.fileName || body.assetName || body.name || filenameFromUrl(itemUrl, textContent ? '文本素材' : '素材'),
      prompt: body.prompt || '',
      textContent,
      duration: body.duration || 0,
      remark: body.remark || '',
      url: itemUrl,
      assetUrl: itemUrl,
      urls: itemUrl ? [itemUrl] : [],
      createTime: nowIso(),
      updateTime: nowIso(),
    })).filter(Boolean)
    persistLocalStore()
    res.json(mockSuccess(records.length === 1 ? records[0] : records))
  })
  app.delete('/agent/canvas/material/:id', (req, res) => {
    const id = String(req.params.id || '')
    localStore.assetRecords = ensureAssetRecords().filter(item => String(item.assetId || item.materialId || item.id || '') !== id)
    persistLocalStore()
    res.json(mockSuccess())
  })
  app.post('/agent/canvas/material/page', (req, res) => {
    const page = listLocalAssetRecords(req.body || {})
    res.json({
      success: true,
      data: page.rows,
      list: page.rows,
      total: page.totalCount,
      totalCount: page.totalCount,
      pageSize: page.pageSize,
      pageIndex: page.pageNum,
      totalPages: page.totalPages,
    })
  })
  app.post('/agent/canvas/shot/status/batch', (req, res) => res.json(mockSuccess({})))
  app.post('/agent/canvas/shot/audio/create', (req, res) => res.json(mockSuccess({ audioId: 'audio_001' })))
  app.put('/agent/canvas/shot/audio/update', (req, res) => res.json(mockSuccess()))
  app.delete('/agent/canvas/shot/audio/:id', (req, res) => res.json(mockSuccess()))
  app.put('/agent/canvas/shot/audio/order', (req, res) => res.json(mockSuccess()))
  app.post('/agent/canvas/shot/extend-video', (req, res) => res.json(mockSuccess()))
  app.post('/agent/canvas/shot/optimize-prompt', (req, res) => res.json(mockSuccess()))
  app.post('/agent/canvas/background-music/set', (req, res) => res.json(mockSuccess()))
  app.post('/agent/canvas/shot/update-volume', (req, res) => res.json(mockSuccess()))
  app.get('/agent/canvas/session/:sessionId/segment/:segmentId', (req, res) => res.json(mockSuccess({})))
  app.post('/agent/canvas/convert-from-chapter', (req, res) => res.json(mockSuccess()))

  // AI Image generation
  app.post('/agent/ai-image-generation/page', (req, res) => {
    const page = listLocalGenerationRecords(req.body || {})
    res.json(mockSuccess({
      list: page.rows,
      total: page.totalCount,
      totalCount: page.totalCount,
      pageSize: page.pageSize,
      pageIndex: page.pageNum,
      totalPages: page.totalPages,
    }))
  })
  app.delete('/agent/ai-image-generation/:id', (req, res) => res.json(mockSuccess()))
  app.get('/agent/ai-image-template/page', (req, res) => res.json(mockSuccess({ list: [], total: 0 })))
  app.post('/agent/ai-image/upload', (req, res) => res.json(mockSuccess()))

  app.get('/agent/sts/oss/token', (req, res) => {
    res.json(mockSuccess({
      accessKeyId: 'local', accessKeySecret: 'local', securityToken: 'local',
      bucketName: '', bucket: '',
      region: 'local', endpoint: 'http://localhost:3456', env: 'local',
      expiration: new Date(Date.now() + 86400000).toISOString(),
    }))
  })

  app.put(/^\/dify\//, (req, res) => {
    try {
      const urlObj = new URL(req.url, 'http://localhost')
      const objectKey = req.path.replace(/^\//, '')
      const basePath = path.join(imgDir, objectKey)
      const dir = path.dirname(basePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

      // Multipart upload part
      if (urlObj.searchParams.has('partNumber') && urlObj.searchParams.has('uploadId')) {
        const partNum = urlObj.searchParams.get('partNumber')
        const uploadId = urlObj.searchParams.get('uploadId')
        const partPath = basePath + `.part.${partNum}.${uploadId}`
        readRequestBuffer(req, buf => {
          fs.writeFileSync(partPath, buf)
          const etag = `"${uid()}"`
          sendOssXml(res, `<?xml version="1.0" encoding="UTF-8"?><Part><PartNumber>${partNum}</PartNumber><ETag>${etag}</ETag></Part>`, { etag })
        })
        return
      }

      // Single PUT upload
      readRequestBuffer(req, buf => {
        fs.writeFileSync(basePath, buf)
        const etag = `"${uid()}"`
        const location = publicUrlForObject(objectKey)
        sendOssXml(res, `<?xml version="1.0" encoding="UTF-8"?><PutObjectResult><Location>${location}</Location><Bucket>local</Bucket><Key>${objectKey}</Key><ETag>${etag}</ETag></PutObjectResult>`, { etag, location })
      })
    } catch (e) {
      res.status(200).type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>500</Code></Error>`)
    }
  })

  app.post(/^\/dify\//, (req, res) => {
    const urlObj = new URL(req.url, 'http://localhost')
    const objectKey = req.path.replace(/^\//, '')
    const basePath = path.join(imgDir, objectKey)
    const dir = path.dirname(basePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    // Initiate multipart upload
    if (urlObj.searchParams.has('uploads')) {
      const uploadId = uid()
      return sendOssXml(
        res,
        `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>local</Bucket><Key>${objectKey}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
      )
    }

    // Complete multipart upload - assemble parts
    if (urlObj.searchParams.has('uploadId')) {
      const uploadId = urlObj.searchParams.get('uploadId')
      // Find and concatenate all parts in order
      const dir = path.dirname(basePath)
      const prefix = path.basename(basePath) + `.part.`
      let partNum = 1
      const bufs = []
      while (true) {
        const partPath = path.join(dir, prefix + partNum + '.' + uploadId)
        if (!fs.existsSync(partPath)) break
        bufs.push(fs.readFileSync(partPath))
        fs.unlinkSync(partPath)
        partNum++
      }
      if (bufs.length > 0) {
        fs.writeFileSync(basePath, Buffer.concat(bufs))
      }
      const etag = `"${uid()}"`
      const location = publicUrlForObject(objectKey)
      return sendOssXml(
        res,
        `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Location>${location}</Location><Bucket>local</Bucket><Key>${objectKey}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`,
        { etag, location }
      )
    }

    // Regular upload
    readRequestBuffer(req, buf => {
      fs.writeFileSync(basePath, buf)
      const etag = `"${uid()}"`
      const location = publicUrlForObject(objectKey)
      sendOssXml(res, `<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>${location}</Location><Bucket>local</Bucket><Key>${objectKey}</Key><ETag>${etag}</ETag></PostResponse>`, { etag, location })
    })
  })

  app.options(/^\/dify\//, (req, res) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'PUT, POST, OPTIONS')
    res.header('Access-Control-Allow-Headers', '*')
    res.sendStatus(200)
  })

  app.post('/agent/upload-local', uploadSingleFile, (req, res) => {
    try {
      const file = req.file
      if (!file) return res.json(mockFail('no file'))
      const name = req.body?.name || file.originalname || `upload_${uid()}.png`
      const buf = fs.readFileSync(file.path)
      const filename = `upload_${uid()}_${path.basename(name)}`
      const filepath = path.join(imgDir, filename)
      fs.writeFileSync(filepath, buf)
      fs.unlinkSync(file.path)
      const fileUrl = `/generated/${filename}`
      const record = upsertAssetRecord({
        id: `asset_upload_${shortHash(fileUrl)}`,
        sessionId: req.body?.sessionId || '',
        nodeKey: req.body?.nodeKey || '',
        assetType: assetTypeFromUrl(fileUrl, 'image'),
        dataType: assetTypeFromUrl(fileUrl, 'image'),
        source: 'upload',
        name,
        fileName: name,
        url: fileUrl,
        urls: [fileUrl],
        createTime: nowIso(),
        updateTime: nowIso(),
      })
      persistLocalStore()
      res.json(uploadSuccessPayload(fileUrl, record))
    } catch (e) {
      res.json(mockFail(e.message))
    }
  })

  app.post('/agent/upload-data-url', (req, res) => {
    try {
      const dataUrl = req.body?.dataUrl || req.body?.url || req.body?.image
      if (!dataUrl || typeof dataUrl !== 'string') return res.json(mockFail('dataUrl is required'))
      const url = saveDataImageUrl(dataUrl, req.body?.name || 'inline')
      const record = upsertAssetRecord({
        id: `asset_data_${shortHash(url)}`,
        sessionId: req.body?.sessionId || '',
        nodeKey: req.body?.nodeKey || '',
        assetType: 'image',
        dataType: 'image',
        source: 'upload',
        name: req.body?.name || filenameFromUrl(url, '图片'),
        fileName: filenameFromUrl(url, '图片'),
        url,
        urls: [url],
        createTime: nowIso(),
        updateTime: nowIso(),
      })
      persistLocalStore()
      res.json(uploadSuccessPayload(url, record))
    } catch (e) {
      res.json(mockFail(e.message))
    }
  })

  app.get('/agent/image-record/query', (req, res) => {
    const md5 = req.query?.imageMd5
    const record = md5 ? localStore.imageRecords[md5] : null
    res.json(mockSuccess(record || null))
  })
  app.post('/agent/image-record/save', (req, res) => {
    const md5 = req.body?.imageMd5
    const imageUrl = req.body?.imageUrl
    if (!md5 || !imageUrl) return res.json(mockFail('imageMd5 and imageUrl are required'))
    const record = {
      imageMd5: md5,
      imageUrl,
      reviewed: true,
      createTime: nowIso(),
      updateTime: nowIso(),
    }
    localStore.imageRecords[md5] = record
    upsertAssetRecord({
      id: `asset_image_record_${md5}`,
      assetType: 'image',
      dataType: 'image',
      source: 'image-record',
      name: filenameFromUrl(imageUrl, '图片'),
      fileName: filenameFromUrl(imageUrl, '图片'),
      url: imageUrl,
      urls: [imageUrl],
      createTime: record.createTime,
      updateTime: record.updateTime,
    })
    persistLocalStore()
    res.json(mockSuccess(record))
  })
  app.post('/agent/ark-asset-review/submit', (req, res) => {
    res.json(mockSuccess({ reviewed: true, imageUrl: req.body?.imageUrl || null, status: 'PASS' }))
  })

  // Membership
  app.get('/agent/membership/current', (req, res) => res.json(mockSuccess({ level: 'free', status: 'active' })))
  app.get('/agent/membership/plans/v2', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/membership/subscribe', (req, res) => res.json(mockSuccess()))
  app.get('/agent/membership/subscribe/:id', (req, res) => res.json(mockSuccess()))
  app.get('/agent/membership/enterprise/levels', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/membership/enterprise/subscribe', (req, res) => res.json(mockSuccess()))
  app.get('/agent/membership/enterprise/subscribe/:id', (req, res) => res.json(mockSuccess()))
  app.post('/agent/membership/enterprise/subscribe/:id/cancel', (req, res) => res.json(mockSuccess()))
  app.get('/agent/membership/enterprise/name/check', (req, res) => res.json(mockSuccess()))

  // Sound / Style / Tags
  app.get('/agent/v1/sound/list', (req, res) => res.json(mockSuccess([])))
  app.put('/agent/v1/sound/update-name', (req, res) => res.json(mockSuccess()))
  app.delete('/agent/v1/sound/delete/:id', (req, res) => res.json(mockSuccess()))
  app.get('/agent/image/style/list', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/tag/list', (req, res) => res.json(mockSuccess([])))

  // Resources
  app.post('/agent/user/image/query', (req, res) => res.json(mockSuccess({ list: [], total: 0 })))
  app.post('/agent/user/video/query', (req, res) => res.json(mockSuccess({ list: [], total: 0 })))
  app.post('/agent/resource/favorite/batch/add', (req, res) => res.json(mockSuccess()))
  app.post('/agent/resource/favorite/batch/remove', (req, res) => res.json(mockSuccess()))

  // AI Shot
  app.get('/agent/ai-shot/chapters/:id', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/ai-shot/shots/:ch/:sh', (req, res) => res.json(mockSuccess({})))
  app.post('/agent/ai-shot/update', (req, res) => res.json(mockSuccess()))
  app.get('/agent/ai-shot/design-content/:id', (req, res) => res.json(mockSuccess({})))
  app.put('/agent/ai-shot/narration/update', (req, res) => res.json(mockSuccess()))
  app.get('/agent/ai-shot/audio-count/:id', (req, res) => res.json(mockSuccess({ count: 0 })))
  app.post('/agent/ai-shot/audio/update', (req, res) => res.json(mockSuccess()))
  app.get('/agent/ai-shot/reference-image-status/:a/:b', (req, res) => res.json(mockSuccess({})))
  app.post('/agent/ai-shot/reference-image-modify', (req, res) => res.json(mockSuccess()))

  // Audio
  app.post('/agent/minimax/file/voice-clone', (req, res) => res.json(mockSuccess({ cloneRecordId: 'clone_001' })))
  app.post('/agent/minimax/file/voice-clone/confirm', (req, res) => res.json(mockSuccess()))

  // Annotations
  app.get('/agent/announcement/active', (req, res) => res.json(mockSuccess(null)))
  app.get('/agent/capabilities/list', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/trial-package/list', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/trial-package/current', (req, res) => res.json(mockSuccess(null)))
  app.post('/agent/trial-package/purchase', (req, res) => res.json(mockSuccess()))
  app.post('/agent/trial-package/order/check-status', (req, res) => res.json(mockSuccess()))

  // Competition
  app.get('/agent/competition-activity/list', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/competition-activity/detail/:id', (req, res) => res.json(mockSuccess({})))
  app.get('/agent/competition-activity/:id/works', (req, res) => res.json(mockSuccess({ list: [] })))
  app.get('/agent/competition-activity/:id/award-works', (req, res) => res.json(mockSuccess({ list: [] })))
  app.get('/agent/competition-activity/registered/list', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/competition-activity/register', (req, res) => res.json(mockSuccess()))

  // AI Conversation
  app.get('/agent/ai-creation/conversation/content', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/ai-creation/conversation/characters', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/ai-creation/visual-record/list/:id', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/ai-creation/visual-record/share/:id', (req, res) => res.json(mockSuccess({})))
  app.get('/agent/ai-creation/visual-record/list/published/:id', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/ai-creation/visual-record/status/update', (req, res) => res.json(mockSuccess()))
  app.post('/agent/ai-creation/visual-record/render', (req, res) => res.json(mockSuccess()))

  // Video render
  app.post('/agent/video-render/share', (req, res) => res.json(mockSuccess()))
  app.get('/agent/video-render/shared/list', (req, res) => res.json(mockSuccess({ list: [] })))
  app.get('/agent/video-render/shared/:id', (req, res) => res.json(mockSuccess({})))
  app.post('/agent/video-render/export', (req, res) => res.json(mockSuccess()))
  app.get('/agent/video-render/list', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/video-render/capcut/export', (req, res) => res.json(mockSuccess()))
  app.get('/agent/video-render/capcut/:id', (req, res) => res.json(mockSuccess({})))

  // Pay
  app.get('/agent/pay/recharge/configs', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/pay/order/create', (req, res) => res.json(mockSuccess({ orderNo: 'order_001' })))
  app.get('/agent/pay/order/status', (req, res) => res.json(mockSuccess({ status: 'paid' })))
  app.post('/agent/pay/order/close', (req, res) => res.json(mockSuccess()))

  // Volcengine
  app.post('/agent/volcengine/spi/verify', (req, res) => res.json(mockSuccess()))

  // Community
  app.get('/agent/community/product/list', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/community/product/purchase', (req, res) => res.json(mockSuccess()))
  app.get('/agent/community/product/order/:id', (req, res) => res.json(mockSuccess()))

  // Coupon
  app.post('/agent/coupon/validate', (req, res) => res.json(mockSuccess({ valid: true })))

  // Wechat
  app.post('/agent/wechat/jssdk/signature', (req, res) => res.json(mockSuccess({})))

  // Dictionary
  app.get('/agent/dictionary/value/:key', (req, res) => res.json(mockSuccess('')))

  // License
  app.post('/agent/business-license/recognize', (req, res) => res.json(mockSuccess({})))

  // Collaboration
  app.post('/agent/project-collaboration/join', (req, res) => res.json(mockSuccess()))
  app.post('/agent/project-collaboration/query-invitations', (req, res) => res.json(mockSuccess({ list: [] })))
  app.post('/agent/project-collaboration/query-members', (req, res) => res.json(mockSuccess({ list: [] })))
  app.delete('/agent/project-collaboration/remove-member', (req, res) => res.json(mockSuccess()))
  app.put('/agent/project-collaboration/update-member-role', (req, res) => res.json(mockSuccess()))
  app.delete('/agent/project-collaboration/cancel-invitation', (req, res) => res.json(mockSuccess()))
  app.post('/agent/project-collaboration/leave', (req, res) => res.json(mockSuccess()))
  app.post('/ucenter/v1/session/dissolve', (req, res) => res.json(mockSuccess()))
  app.get('/ucenter/enterprise/level/info', (req, res) => res.json(mockSuccess({})))
  app.get('/agent/user/video/templates', (req, res) => res.json(mockSuccess({ list: [] })))
  app.get('/agent/running-hub/resource-hd/submit', (req, res) => res.json(mockSuccess({})))

  // ── Canvas / Story Canvas mock routes (local mode) ──
  app.post('/agent/story-canvas/session/create', (req, res) => {
    const session = createLocalSession(req.body || {})
    res.json(mockSuccess(session.sessionId))
  })
  app.get('/agent/story-canvas/session/list', (req, res) => sendSessionList(req, res))
  app.get('/agent/story-canvas/session/list/v2', (req, res) => sendSessionList(req, res))
  app.get('/agent/story-canvas/session/list/v3', (req, res) => sendSessionList(req, res, { v3: true }))
  app.get(/\/agent\/story-canvas\/session\/([^/]+)$/, (req, res) => {
    const session = ensureLocalSession(req.params[0])
    persistLocalStore()
    res.json(mockSuccess(sessionDetail(session)))
  })
  app.put('/agent/story-canvas/session/update', (req, res) => {
    const id = req.body?.sessionId || req.body?.id
    if (!id) return res.json(mockFail('sessionId is required'))
    updateLocalSession(id, req.body || {})
    res.json(mockSuccess({}))
  })
  app.post('/agent/story-canvas/session/update', (req, res) => {
    const id = req.body?.sessionId || req.body?.id
    if (!id) return res.json(mockFail('sessionId is required'))
    updateLocalSession(id, req.body || {})
    res.json(mockSuccess({}))
  })
  app.delete(/\/agent\/story-canvas\/session\/([^/]+)$/, (req, res) => {
    delete localStore.sessions[req.params[0]]
    persistLocalStore()
    res.json(mockSuccess({}))
  })
  app.post('/agent/story-canvas/batch-operation', (req, res) => {
    const id = req.body?.sessionId || req.body?.id
    if (!id) return res.json(mockFail('sessionId is required'))
    const actions = Array.isArray(req.body?.actions) ? req.body.actions : []
    res.json(mockSuccess({ results: applyBatchOperation(id, actions) }))
  })
  app.post('/agent/story-canvas/update-detail', (req, res) => {
    const id = req.body?.sessionId || req.body?.id
    if (!id) return res.json(mockFail('sessionId is required'))
    updateLocalSession(id, {
      nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : [],
      edges: Array.isArray(req.body?.edges) ? req.body.edges : [],
    })
    res.json(mockSuccess({}))
  })
  app.post('/agent/story-canvas/session/clone', (req, res) => {
    const source = req.body?.sessionId ? localStore.sessions[req.body.sessionId] : null
    const session = createLocalSession(source ? {
      ...sessionDetail(source),
      title: `${source.title || '无限画布'} 副本`,
    } : req.body || {})
    res.json(mockSuccess({ sessionId: session.sessionId }))
  })
  function sendLatestGeneration(req, res) {
    const nodeKey = req.method === 'GET' ? req.query?.nodeKey : req.body?.nodeKey
    res.json(mockSuccess(localLatestGeneration(nodeKey)))
  }
  app.get('/agent/story-canvas/latest-generation', sendLatestGeneration)
  app.post('/agent/story-canvas/latest-generation', sendLatestGeneration)
  function sendGenerationList(req, res) {
    const page = listLocalGenerationRecords(req.method === 'GET' ? req.query || {} : req.body || {})
    res.json({
      success: true,
      data: page.rows,
      totalCount: page.totalCount,
      pageSize: page.pageSize,
      pageIndex: page.pageNum,
      totalPages: page.totalPages,
    })
  }
  app.get('/agent/story-canvas/list-generations', sendGenerationList)
  app.post('/agent/story-canvas/list-generations', sendGenerationList)
  app.post('/agent/story-canvas/generate-text', (req, res) => res.json(mockSuccess({ taskId: 'text_task_' + uid() })))
  app.post('/agent/story-canvas/convert-angle', handleConvertAngleImageEdit)
  app.post('/agent/story-canvas/outpainting', (req, res) => res.json(mockSuccess({ taskId: 'outpaint_task_' + uid() })))
  app.post('/agent/story-canvas/generate-audio', (req, res) => res.json(mockSuccess({ taskId: 'audio_task_' + uid() })))
  app.post('/agent/story-canvas/generate-audio-v2', (req, res) => res.json(mockSuccess({ taskId: 'audio_task_' + uid() })))
  app.post('/agent/story-canvas/generate-music', (req, res) => res.json(mockSuccess({ taskId: 'music_task_' + uid() })))
  app.post('/agent/story-canvas/generate-lyrics', (req, res) => res.json(mockSuccess({ taskId: 'lyrics_task_' + uid() })))
  function sendAssetList(req, res) {
    const page = listLocalAssetRecords(req.method === 'GET' ? req.query || {} : req.body || {})
    res.json({
      success: true,
      data: page.rows,
      assets: page.rows,
      totalCount: page.totalCount,
      pageSize: page.pageSize,
      pageIndex: page.pageNum,
      totalPages: page.totalPages,
    })
  }
  app.get('/agent/story-canvas/query-assets-v2', sendAssetList)
  app.post('/agent/story-canvas/query-assets-v2', sendAssetList)
  app.post('/agent/story-canvas/query-asset-categories', (req, res) => {
    res.json(mockSuccess(localAssetCategories))
  })
  app.post('/agent/story-canvas/query-user-assets', (req, res) => {
    const page = listLocalAssetRecords(req.body || {})
    res.json({
      success: true,
      data: page.rows,
      list: page.rows,
      total: page.totalCount,
      totalCount: page.totalCount,
      pageSize: page.pageSize,
      pageIndex: page.pageNum,
      totalPages: page.totalPages,
    })
  })
  app.post('/agent/story-canvas/add-canvas-asset', (req, res) => {
    const body = req.body || {}
    const urlValue = body.assetUrl || body.url || body.mediaUrl || body.imageUrl || body.videoUrl || body.audioUrl || body.materialUrl
    const urls = normalizeTaskResultData(body.urls || body.assetUrls || body.imageUrls || body.videoUrls || body.audioUrls || urlValue)
    const textContent = String(body.textContent || body.content || '').trim()
    if (urls.length === 0 && !textContent) return res.json(mockFail('assetUrl is required'))
    const sourceItems = urls.length > 0 ? urls : ['']
    const records = sourceItems.map((itemUrl, index) => upsertAssetRecord({
      id: body.assetId || body.id || body.materialId || `asset_manual_${shortHash(itemUrl || textContent || uid())}_${index}`,
      assetId: body.assetId || body.id || body.materialId || undefined,
      materialId: body.materialId || body.assetId || body.id || undefined,
      sessionId: body.sessionId || '',
      nodeKey: body.nodeKey || body.nodeId || '',
      taskId: body.taskId || null,
      assetType: body.assetType || body.type || assetTypeFromUrl(itemUrl, textContent ? 'text' : (body.dataType || 'image')),
      dataType: body.dataType || body.assetType || body.type || assetTypeFromUrl(itemUrl, textContent ? 'text' : 'image'),
      assetCategory: body.assetCategory || body.category || body.materialCategory || 'other',
      source: body.source || 'manual',
      assetName: body.assetName || body.name || body.fileName || filenameFromUrl(itemUrl, textContent ? '文本素材' : '素材'),
      name: body.assetName || body.name || body.fileName || filenameFromUrl(itemUrl, textContent ? '文本素材' : '素材'),
      fileName: body.fileName || body.assetName || body.name || filenameFromUrl(itemUrl, textContent ? '文本素材' : '素材'),
      prompt: body.prompt || '',
      textContent,
      duration: body.duration || 0,
      remark: body.remark || '',
      url: itemUrl,
      assetUrl: itemUrl,
      urls: itemUrl ? [itemUrl] : [],
      createTime: nowIso(),
      updateTime: nowIso(),
    })).filter(Boolean)
    persistLocalStore()
    res.json(mockSuccess(records.length === 1 ? records[0] : records))
  })
  app.post('/agent/story-canvas/update-canvas-asset', (req, res) => {
    const body = req.body || {}
    const id = String(body.assetId || body.materialId || body.id || '').trim()
    if (!id) return res.json(mockFail('assetId is required'))
    const rows = ensureAssetRecords()
    const index = rows.findIndex(item => String(item.assetId || item.materialId || item.id || '') === id)
    if (index < 0) return res.json(mockFail('asset not found'))
    const updated = assetRecordView({
      ...rows[index],
      assetId: id,
      id,
      assetName: body.assetName || body.name || rows[index].assetName || rows[index].name,
      assetCategory: body.assetCategory || body.category || rows[index].assetCategory || rows[index].category,
      remark: body.remark !== undefined ? body.remark : rows[index].remark,
      updateTime: nowIso(),
    })
    rows[index] = updated
    localStore.assetRecords = rows.map(assetRecordView)
    persistLocalStore()
    res.json(mockSuccess(updated))
  })
  app.post('/agent/story-canvas/delete-canvas-asset', (req, res) => {
    const body = req.body || {}
    const ids = (Array.isArray(body.assetIds) ? body.assetIds : [body.assetId || body.materialId || body.id]).map(item => String(item || '')).filter(Boolean)
    if (ids.length === 0) return res.json(mockFail('assetId is required'))
    const idSet = new Set(ids)
    localStore.assetRecords = ensureAssetRecords().filter(item => !idSet.has(String(item.assetId || item.materialId || item.id || '')))
    persistLocalStore()
    res.json(mockSuccess({ deletedCount: ids.length }))
  })
  app.get('/agent/story-canvas/query-asset-ref', (req, res) => res.json(mockSuccess(findLocalAssetRef(req.query?.taskId))))
  app.post('/agent/story-canvas/query-asset-ref', (req, res) => res.json(mockSuccess(findLocalAssetRef(req.body?.taskId))))
  app.post('/agent/story-canvas/remove-subtitle', (req, res) => res.json(mockSuccess({})))
  app.post('/agent/story-canvas/page-nodes', (req, res) => {
    const session = req.body?.sessionId ? localStore.sessions[req.body.sessionId] : null
    const nodes = Array.isArray(session?.nodes) ? session.nodes : []
    res.json({ success: true, data: nodes, totalCount: nodes.length, pageSize: req.body?.pageSize || 20, pageIndex: req.body?.pageNum || 1, totalPages: 1 })
  })
  app.get('/agent/story-canvas/page-nodes', (req, res) => {
    const session = req.query?.sessionId ? localStore.sessions[req.query.sessionId] : null
    const nodes = Array.isArray(session?.nodes) ? session.nodes : []
    res.json({ success: true, data: nodes, totalCount: nodes.length, pageSize: req.query?.pageSize || 20, pageIndex: req.query?.pageNum || 1, totalPages: 1 })
  })
  app.get('/agent/story-canvas/world-model-configs', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/story-canvas/generate-world-model', (req, res) => res.json(mockSuccess({ taskId: 'world_task_' + uid() })))
  app.post('/agent/story-canvas/lighting-modification', (req, res) => res.json(mockSuccess({ taskId: 'light_task_' + uid() })))
  app.post('/agent/story-canvas/upscale-image', (req, res) => res.json(mockSuccess({ taskId: 'upscale_task_' + uid() })))
  app.post('/agent/story-canvas/upscale-video', (req, res) => res.json(mockSuccess({ taskId: 'upscale_video_task_' + uid() })))
  app.post('/agent/story-canvas/upscale-image-v2', (req, res) => res.json(mockSuccess({ taskId: 'upscale_task_' + uid() })))
  app.post('/agent/story-canvas/upscale-image-v3', (req, res) => res.json(mockSuccess({ taskId: 'upscale_task_' + uid() })))
  app.post('/agent/story-canvas/upscale-video-v2', (req, res) => res.json(mockSuccess({ taskId: 'upscale_video_task_' + uid() })))
  app.post('/agent/story-canvas/estimate-video-enhance-points', (req, res) => res.json(mockSuccess({ needPoints: 0 })))
  app.get('/agent/story-canvas/session/template/categories', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/story-canvas/session/template/list', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/story-canvas/session/template/use', (req, res) => res.json(mockSuccess({ sessionId: 'session_' + uid() })))
  app.get('/agent/story-canvas/session/template/detail', (req, res) => res.json(mockSuccess({ nodes: [], edges: [] })))
  app.get('/agent/story-canvas/scene-template-records/page', sendSceneTemplateRecords)
  app.post('/agent/story-canvas/scene-template-records/page', sendSceneTemplateRecords)
  app.post('/agent/story-canvas/generate-scene-template', (req, res) => {
    const record = createLocalSceneTemplateRecord(req.body || {})
    res.json(mockSuccess(record.resultJson))
  })
  app.post('/agent/story-canvas/session/copy', (req, res) => {
    const source = req.body?.sessionId ? localStore.sessions[req.body.sessionId] : null
    const session = createLocalSession(source ? {
      ...sessionDetail(source),
      title: `${source.title || '无限画布'} 副本`,
    } : req.body || {})
    res.json(mockSuccess({ sessionId: session.sessionId }))
  })
  app.post('/agent/story-canvas/folder/create', (req, res) => res.json(mockSuccess({ id: 'folder_' + uid() })))
  app.put('/agent/story-canvas/folder/rename', (req, res) => res.json(mockSuccess()))
  app.post('/agent/story-canvas/folder/move', (req, res) => res.json(mockSuccess()))
  app.delete(/\/agent\/story-canvas\/folder\/([^/]+)/, (req, res) => res.json(mockSuccess()))
  // Session share
  app.get(/\/agent\/story-canvas\/session\/share\/info\/([^/]+)/, (req, res) => res.json(mockSuccess({ shareCode: null, status: 0 })))
  app.post('/agent/story-canvas/session/share/toggle', (req, res) => res.json(mockSuccess({ shareCode: 'share_' + uid(), status: 1 })))
  app.get('/agent/story-canvas/session/share/view', (req, res) => res.json(mockSuccess({})))
  app.post('/agent/story-canvas/session/share/clone', (req, res) => res.json(mockSuccess({ sessionId: 'session_' + uid() })))

  // ── AI ROUTES (check config at request time) ──
  app.post('/agent/ai-image-generation/generate', async (req, res) => {
    if (!useOpenAI()) return res.json(mockSuccess({ taskId: 'image_task_' + uid() }))
    try {
      const { prompt, imageCount = 1, size = '1024x1024', model } = req.body || {}
      if (!prompt) return res.json(mockFail('prompt is required'))
      const resp = await openAIRequest('POST', '/v1/images/generations', {
        model: model || OPENAI_MODEL, prompt, n: imageCount, size, response_format: 'url'
      })
      const images = (resp.data || []).map((img, i) => ({
        url: img.url, revised_prompt: img.revised_prompt || prompt
      }))
      const taskId = uid()
      const resultData = images.map(img => img.url).filter(Boolean)
      aiTasks.set(taskId, {
        status: 'completed',
        prompt,
        images,
        resultData,
        createdAt: Date.now(),
        source: 'ai-image-generation',
        nodeKey: '',
        sessionId: req.body?.sessionId || '',
        dataType: 'image',
        model: model || OPENAI_MODEL,
      })
      recordGenerationStart({
        taskId,
        nodeKey: '',
        sessionId: req.body?.sessionId || '',
        prompt,
        inputImageUrls: [],
        model: model || OPENAI_MODEL,
        size,
        source: 'ai-image-generation',
        dataType: 'image',
      })
      recordGenerationFinal(taskId)
      res.json(mockSuccess({ taskId }))
    } catch (err) {
      console.error('[OpenAI Image]', err.message)
      res.json(mockSuccess({ taskId: 'image_task_' + uid() }))
    }
  })

  app.get('/agent/ai-image-generation/result/:id', (req, res) => {
    const task = aiTasks.get(req.params.id)
    if (task && task.images && task.images.length > 0) {
      res.json(mockSuccess({ status: 'completed', imageUrl: task.images[0].url, images: task.images }))
    } else {
      res.json(mockSuccess({ status: 'completed', imageUrl: null, images: [] }))
    }
  })

  app.post('/agent/canvas/material/generate-image', async (req, res) => {
    if (!useOpenAI()) return res.json(mockSuccess({ taskId: 'material_task_' + uid() }))
    try {
      const { prompt } = req.body || {}
      if (!prompt) return res.json(mockSuccess({ taskId: 'material_task_' + uid() }))
      const resp = await openAIRequest('POST', '/v1/images/generations', {
        model: OPENAI_MODEL, prompt, n: 1, size: '1024x1024', response_format: 'url'
      })
      const taskId = uid()
      const resultData = (resp.data || []).map(img => img.url).filter(Boolean)
      aiTasks.set(taskId, {
        status: 'completed',
        prompt,
        images: resp.data || [],
        resultData,
        createdAt: Date.now(),
        source: 'material-generate-image',
        nodeKey: '',
        sessionId: req.body?.sessionId || '',
        dataType: 'image',
        model: OPENAI_MODEL,
      })
      recordGenerationStart({
        taskId,
        nodeKey: '',
        sessionId: req.body?.sessionId || '',
        prompt,
        inputImageUrls: [],
        model: OPENAI_MODEL,
        size: '1K',
        source: 'material-generate-image',
        dataType: 'image',
      })
      recordGenerationFinal(taskId)
      res.json(mockSuccess({ taskId }))
    } catch {
      res.json(mockSuccess({ taskId: 'material_task_' + uid() }))
    }
  })

  app.post('/agent/canvas/material/generate-video', (req, res) => {
    const taskId = 'video_task_' + uid()
    aiTasks.set(taskId, { status: 'processing', createdAt: Date.now() })
    setTimeout(() => { const t = aiTasks.get(taskId); if (t) t.status = 'completed' }, 30000)
    res.json(mockSuccess({ taskId }))
  })

  app.post('/agent/scope/conversations', (req, res) => {
    const { query } = req.body || {}
    const conversationId = 'conv_' + uid()
    const runId = 'run_' + uid()
    const emitter = new EventEmitter()
    runEvents.set(runId, emitter)

    if (useOpenAI()) {
      const messages = [{ role: 'user', content: query || '' }]
      const openaiBody = { model: OPENAI_MODEL, messages, max_tokens: 2048, temperature: 0.7 }

      if (OPENAI_STREAMING_ENABLED) {
        openAIStreamChat(
          openaiBody,
          (event) => {
            emitter.emit('event', {
              type: 'agent_result',
              data: {
                type: 'content', content: event.content, role: 'assistant',
                id: runId, model: OPENAI_MODEL,
                created: Math.floor(Date.now() / 1000)
              }
            })
          },
          (err) => {
            emitter.emit('event', { type: 'error', data: { message: err.message } })
            emitter.emit('event', { type: 'done', data: {} })
            setTimeout(() => emitter.emit('close'), 1000)
          },
          () => {
            emitter.emit('event', { type: 'done', data: { id: runId } })
            setTimeout(() => emitter.emit('close'), 500)
          }
        )
      } else {
        ;(async () => {
          try {
            const resp = await openAIRequest('POST', '/v1/chat/completions', { ...openaiBody, stream: false })
            const content = resp.choices?.[0]?.message?.content || ''
            if (content) {
              emitter.emit('event', {
                type: 'agent_result',
                data: {
                  type: 'content', content, role: 'assistant',
                  id: runId, model: OPENAI_MODEL,
                  created: Math.floor(Date.now() / 1000)
                }
              })
            }
            emitter.emit('event', { type: 'done', data: { id: runId } })
            setTimeout(() => emitter.emit('close'), 500)
          } catch (err) {
            emitter.emit('event', { type: 'error', data: { message: err.message } })
            emitter.emit('event', { type: 'done', data: {} })
            setTimeout(() => emitter.emit('close'), 1000)
          }
        })()
      }
    } else {
      // Mock response
      setTimeout(() => {
        emitter.emit('event', {
          type: 'agent_result', data: {
            type: 'content', content: '请在画布右上角 ⚙️ 配置 API 地址和密钥以获取真实 AI 回复。', role: 'assistant'
          }
        })
        emitter.emit('event', { type: 'done', data: { id: runId } })
        setTimeout(() => emitter.emit('close'), 500)
      }, 500)
    }

    res.json(mockSuccess({ id: conversationId, runId, title: query ? query.slice(0, 50) : 'New conversation' }))
  })

  app.get('/agent/scope/runs/:runId/events', (req, res) => {
    const { runId } = req.params
    const emitter = runEvents.get(runId)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    if (!emitter) {
      res.write(`event: agent_result\ndata: {"content":"已完成或会话不存在","role":"assistant"}\n\n`)
      res.write(`event: done\ndata: {}\n\n`)
      res.end()
      return
    }

    const onEvent = ({ type, data }) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
      if (type === 'done') {
        setTimeout(() => { res.end() }, 200)
      }
    }

    emitter.on('event', onEvent)
    emitter.on('close', () => { res.end() })

    req.on('close', () => { emitter.removeListener('event', onEvent) })
  })

  app.post('/agent/scope/runs/:runId/stop', (req, res) => res.json(mockSuccess()))
  app.post('/agent/scope/reply', (req, res) => res.json(mockSuccess({ replyId: 'reply_' + uid() })))

  app.get('/agent/scope/models', async (req, res) => {
    if (!useOpenAI()) return res.json(mockSuccess([]))
    try {
      const resp = await openAIRequest('GET', '/v1/models')
      const models = (resp.data || []).map(m => ({
        modelCode: m.id, name: m.id, description: '', tag: '', provider: 'openai', icon: '',
        isMultimodal: m.id.includes('vision') ? 1 : 0, requireMembership: 0,
        isDefault: m.id === OPENAI_MODEL ? 1 : 0, inputPrice: null, outputPrice: null,
      }))
      res.json(mockSuccess(models))
    } catch {
      res.json(mockSuccess([{
        modelCode: OPENAI_MODEL, name: OPENAI_MODEL, description: 'OpenAI compatible model',
        tag: '', provider: 'openai', icon: '', isMultimodal: 1,
        requireMembership: 0, isDefault: 1, inputPrice: null, outputPrice: null,
      }]))
    }
  })

  app.get(/^\/(agent\/ai-image-generation\/models)\/.*/, (req, res) => {
    if (!useOpenAI()) return res.json(mockSuccess([]))
    const models = [
      {
        model_name: 'gpt-image-2',
        model_display_name: 'GPT Image 2',
        membership_required: 0,
        allowed_membership_level_codes: [],
        model_description: 'OpenAI GPT-Image 2 图像生成模型，支持高质量图片生成、参考图编辑、灵活尺寸',
        image_size: '2048x2048',
        aspect_ratio: '16:9',
        supported_sizes: ['1K', '2K', '4K'],
        supported_aspect_ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '5:4', '3:2', '4:5', '2:3'],
        quality: ['low', 'medium', 'high'],
        supports_camera: false,
        supports_style_transfer: false,
        input_price: 0,
        output_price: 0,
      },
      {
        model_name: 'dall-e-3',
        model_display_name: 'DALL-E 3',
        membership_required: 0,
        allowed_membership_level_codes: [],
        model_description: 'DALL-E 3 高质量图像生成',
        image_size: '1792x1024',
        aspect_ratio: '16:9',
        supported_sizes: ['1K', '2K'],
        supported_aspect_ratios: ['1:1', '16:9', '9:16'],
        quality: ['low', 'medium', 'high'],
        supports_camera: false,
        supports_style_transfer: false,
        input_price: 0,
        output_price: 0,
      },
    ]
    if (OPENAI_MODEL && !models.some(m => m.model_name === OPENAI_MODEL)) {
      models.push({
        model_name: OPENAI_MODEL,
        model_display_name: OPENAI_MODEL,
        membership_required: 0,
        allowed_membership_level_codes: [],
        model_description: 'OpenAI 兼容模型',
        image_size: '2048x2048',
        aspect_ratio: '16:9',
        supported_sizes: ['1K', '2K', '4K'],
        supported_aspect_ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '5:4', '3:2', '4:5', '2:3'],
        quality: ['low', 'medium', 'high'],
        supports_camera: false,
        supports_style_transfer: false,
        input_price: 0,
        output_price: 0,
      })
    }
    res.json(mockSuccess(models))
  })

  app.post('/agent/ai-image/modify', (req, res) => {
    const taskId = uid(); aiTasks.set(taskId, { status: 'completed', imageUrl: null }); res.json(mockSuccess({ taskId }))
  })
  app.get('/agent/ai-image/modify/result/:id', (req, res) => res.json(mockSuccess({ status: 'completed', imageUrl: null })))
  app.post('/agent/ai-image/confirm', (req, res) => res.json(mockSuccess()))
  app.get('/agent/ai-image/modify/source-images', (req, res) => res.json(mockSuccess([])))
  app.post('/agent/shot-image-edit/submit', (req, res) => res.json(mockSuccess({ taskId: uid() })))
  app.post('/agent/image-style/extract', (req, res) => res.json(mockSuccess({ styleDescription: 'extracted style' })))

  function resolveSize(size, aspectRatio) {
    const table = {
      '1K:1:1': '1024x1024', '1K:5:4': '1120x896', '1K:9:16': '720x1280',
      '1K:21:9': '1456x624', '1K:16:9': '1280x720', '1K:4:3': '1152x864',
      '1K:3:2': '1248x832', '1K:4:5': '896x1120', '1K:3:4': '864x1152',
      '1K:2:3': '832x1248',
      '2K:1:1': '2048x2048', '2K:5:4': '2240x1792', '2K:9:16': '1440x2560',
      '2K:21:9': '3024x1296', '2K:16:9': '2560x1440', '2K:4:3': '2304x1728',
      '2K:3:2': '2496x1664', '2K:4:5': '1792x2240', '2K:3:4': '1728x2304',
      '2K:2:3': '1664x2496',
      '4K:1:1': '2880x2880', '4K:5:4': '3200x2560', '4K:9:16': '2160x3840',
      '4K:21:9': '3696x1584', '4K:16:9': '3840x2160', '4K:4:3': '3264x2448',
      '4K:3:2': '3504x2336', '4K:4:5': '2560x3200', '4K:3:4': '2448x3264',
      '4K:2:3': '2336x3504',
    }
    return table[`${size}:${aspectRatio}`] || '1024x1024'
  }

  function normalizeImageSizeLabel(size) {
    const value = String(size || '1K').trim()
    return ['1K', '2K', '4K'].includes(value) ? value : '1K'
  }

  function normalizeImageAspectRatio(aspectRatio) {
    const value = String(aspectRatio || '1:1').trim()
    return value && value !== 'auto' ? value : '1:1'
  }

  function crc32(buf) {
    let c = 0xFFFFFFFF
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0)
    }
    return (c ^ 0xFFFFFFFF) >>> 0
  }

  function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }

  function makePNG(w, h, r, g, b) {
    const rowLen = 1 + w * 4
    const raw = Buffer.alloc(h * rowLen)
    for (let y = 0; y < h; y++) {
      raw[y * rowLen] = 0
      for (let x = 0; x < w; x++) {
        const o = y * rowLen + 1 + x * 4
        raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255
      }
    }
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
  }

  function saveImage(taskId, index, buf, ext) {
    return saveImageBuffer(`${taskId}_${index}`, buf, ext || 'png')
  }

  function mockPlaceholder(taskId, i) {
    const hue = (i * 60 + parseInt(taskId.slice(-4), 16) % 360)
    const png = makePNG(512, 512, hue * 2 % 256, (hue + 120) * 2 % 256, (hue + 240) * 2 % 256)
    return saveImage(taskId, i, png, 'png')
  }

  function downloadImageFile(imageUrl, index, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error(`too many redirects for image: ${imageUrl}`))
      const parsed = new URL(imageUrl)
      const client = parsed.protocol === 'https:' ? https : http
      const req = client.get(parsed, res => {
        const location = res.headers.location
        if (res.statusCode >= 300 && res.statusCode < 400 && location) {
          res.resume()
          const nextUrl = new URL(location, imageUrl).toString()
          downloadImageFile(nextUrl, index, redirects + 1).then(resolve, reject)
          return
        }
        if (res.statusCode >= 400) {
          res.resume()
          reject(new Error(`failed to download image ${imageUrl}: HTTP ${res.statusCode}`))
          return
        }
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            name: 'image[]',
            filename: path.basename(parsed.pathname) || `input_${index}.png`,
            contentType: (res.headers['content-type'] || '').split(';')[0] || guessImageMime(parsed.pathname),
            data: Buffer.concat(chunks),
          })
        })
      })
      req.setTimeout(120000, () => req.destroy(new Error(`image download timeout: ${imageUrl}`)))
      req.on('error', reject)
    })
  }

  async function toImageFile(url, index) {
    if (url.startsWith('data:')) {
      url = saveDataImageUrl(url, `input_${index}`)
    }

    let pathname = url
    if (/^https?:\/\//.test(url)) {
      const parsed = new URL(url)
      const isLocal = ['localhost', '127.0.0.1'].includes(parsed.hostname)
      if (!isLocal) return downloadImageFile(url, index)
      pathname = parsed.pathname
    }

    if (!pathname.startsWith('/generated/') && !pathname.startsWith('/dify/')) {
      throw new Error(`unsupported image url for edit: ${url}`)
    }

    const relPath = pathname.startsWith('/generated/')
      ? pathname.replace(/^\/generated\//, '')
      : pathname.replace(/^\//, '')
    const baseDir = path.resolve(imgDir)
    const fp = path.resolve(imgDir, relPath)
    if (!fp.startsWith(baseDir + path.sep) || !fs.existsSync(fp)) {
      throw new Error(`image file not found: ${pathname}`)
    }

    return {
      name: 'image[]',
      filename: path.basename(fp) || `input_${index}.png`,
      contentType: guessImageMime(fp),
      data: fs.readFileSync(fp),
    }
  }

  function normalizeImageUrlList(value) {
    const list = Array.isArray(value) ? value : value ? [value] : []
    return list.map(item => String(item || '').trim()).filter(Boolean)
  }

  function buildAnglePrompt({ prompt, horizontalAngle, verticalAngle, zoomLevel, wideangle }) {
    if (String(prompt || '').trim()) return String(prompt).trim()

    const parts = []
    const horizontal = Number(horizontalAngle) || 0
    const vertical = Number(verticalAngle) || 0
    const zoom = Number(zoomLevel) || 0

    if (horizontal !== 0) {
      const english = horizontal > 0 ? 'left' : 'right'
      const chinese = horizontal > 0 ? '左' : '右'
      parts.push(`将镜头向${chinese}旋转${Math.abs(horizontal)}度 Rotate the camera ${Math.abs(horizontal)} degrees to the ${english}.`)
    }
    if (zoom > 5) {
      parts.push('将镜头转为特写镜头 Turn the camera to a close-up.')
    } else if (zoom >= 1) {
      parts.push('将镜头向前移动 Move the camera forward.')
    }
    if (vertical >= 1) {
      parts.push("将相机转向鸟瞰视角 Turn the camera to a bird's-eye view.")
    } else if (vertical <= -1) {
      parts.push("将相机切换到仰视视角 Turn the camera to a worm's-eye view.")
    }
    if (wideangle === true || wideangle === 1 || wideangle === 'true') {
      parts.push('将镜头转为广角镜头 Turn the camera to a wide-angle lens.')
    }

    return parts.join(' ') || '保持主体和画面内容一致，仅对相机视角进行自然调整。 Keep the subject and scene consistent, only adjust the camera view naturally.'
  }

  function startStoryImageTask({
    nodeKey = '',
    sessionId = '',
    prompt,
    imageUrls = [],
    modelName,
    aspectRatio = '1:1',
    numImages = 1,
    size: sizeLabel = '1K',
    quality,
    outputFormat,
    dataType = 'image',
    source = 'generate-image',
  } = {}) {
    const cleanPrompt = String(prompt || '').trim()
    if (!cleanPrompt) throw new Error('prompt is required')

    const taskId = 'gen_task_' + uid()
    const n = Math.min(Math.max(parseInt(numImages) || 1, 1), 10)
    const inputImageUrls = normalizeImageUrlList(imageUrls)
    const model = modelName || OPENAI_MODEL
    const normalizedSize = normalizeImageSizeLabel(sizeLabel)
    const normalizedAspectRatio = normalizeImageAspectRatio(aspectRatio)
    const apiSize = resolveSize(normalizedSize, normalizedAspectRatio)
    const taskMeta = {
      taskId,
      nodeKey,
      sessionId,
      prompt: cleanPrompt,
      inputImageUrls,
      model,
      aspectRatio: normalizedAspectRatio,
      size: normalizedSize,
      apiSize,
      quality,
      outputFormat,
      source,
      dataType,
      createdAt: Date.now(),
    }
    recordGenerationStart(taskMeta)

    if (!useOpenAI()) {
      aiTasks.set(taskId, { status: 'processing', resultData: null, ...taskMeta })
      setTimeout(() => {
        const resultData = Array.from({ length: n }, (_, i) => mockPlaceholder(taskId, i))
        aiTasks.set(taskId, { status: 'completed', resultData, ...taskMeta })
        recordGenerationFinal(taskId)
        syncTaskResultToLocalNodes(taskId)
        console.log('[generate-image] OpenAI 未配置，mock 完成 taskId=%s source=%s', taskId, source)
      }, 2000)
      return { taskId, status: 'PROCESSING' }
    }

    const isGpt2 = model === 'gpt-image-2'

    aiTasks.set(taskId, { status: 'processing', resultData: null, ...taskMeta })

    ;(async () => {
      try {
        const hasInputImages = inputImageUrls.length > 0
        const baseImageFields = {
          model,
          prompt: cleanPrompt,
          n,
          size: apiSize,
          quality: quality || undefined,
          output_format: isGpt2 ? (outputFormat || 'png') : undefined,
          response_format: 'url',
        }
        console.log('[generate-image] 请求 model=%s prompt=%s... size=%s n=%d images=%d endpoint=%s source=%s', model, cleanPrompt.slice(0, 60), apiSize, n, inputImageUrls.length, hasInputImages ? 'edits' : 'generations', source)
        const resp = hasInputImages
          ? await openAIFormRequest('POST', '/v1/images/edits', baseImageFields, await Promise.all(inputImageUrls.map((u, i) => toImageFile(u, i))))
          : await openAIRequest('POST', '/v1/images/generations', baseImageFields)
        const resultData = await Promise.all((resp.data || []).map(async (img, i) => {
          if (img.b64_json) {
            const ext = outputFormat || 'png'
            const buf = Buffer.from(img.b64_json, 'base64')
            return saveImage(taskId, i, buf, ext)
          }
          return img.url
        }))
        console.log('[generate-image] 成功 taskId=%s images=%d source=%s', taskId, resultData.length, source)
        aiTasks.set(taskId, { status: 'completed', resultData, ...taskMeta })
        recordGenerationFinal(taskId)
        syncTaskResultToLocalNodes(taskId)
      } catch (err) {
        console.error('[generate-image] 失败:', err.message)
        aiTasks.set(taskId, {
          status: 'failed',
          resultData: [],
          errorMessage: err.message || '图片生成失败',
          ...taskMeta,
        })
        recordGenerationFinal(taskId)
        syncTaskResultToLocalNodes(taskId)
      }
    })()

    return { taskId, status: 'PROCESSING' }
  }

  function handlePoseReferenceImageEdit(req, res) {
    try {
      const body = req.body || {}
      const imageUrls = normalizeImageUrlList(body.imageUrls)
      if (imageUrls.length === 0) return res.json(mockFail('imageUrls is required'))
      const prompt = body.prompt || (Number(body.type) === 1 ? '图一人物换成图二火柴人的姿势，禁止出现火柴人，去除噪点' : '根据参考图片对原图进行局部编辑')
      res.json(mockSuccess(startStoryImageTask({
        nodeKey: body.nodeKey,
        sessionId: body.sessionId,
        prompt,
        imageUrls,
        modelName: body.modelName,
        aspectRatio: body.aspectRatio,
        size: body.size,
        quality: body.quality,
        outputFormat: body.outputFormat,
        source: Number(body.type) === 1 ? 'pose-reference' : 'markup-reference',
      })))
    } catch (err) {
      res.json(mockFail(err.message || '图片编辑请求失败'))
    }
  }

  function handleConvertAngleImageEdit(req, res) {
    try {
      const body = req.body || {}
      const imageUrl = String(body.imageUrl || '').trim()
      if (!imageUrl) return res.json(mockFail('imageUrl is required'))
      const prompt = buildAnglePrompt(body)
      res.json(mockSuccess(startStoryImageTask({
        nodeKey: body.nodeKey,
        sessionId: body.sessionId,
        prompt,
        imageUrls: [imageUrl],
        modelName: body.modelName,
        aspectRatio: body.aspectRatio,
        size: body.size,
        quality: body.quality,
        outputFormat: body.outputFormat,
        source: 'convert-angle',
      })))
    } catch (err) {
      res.json(mockFail(err.message || '角度调节请求失败'))
    }
  }

  app.post('/agent/story-canvas/generate-image', (req, res) => {
    const body = req.body || {}
    try {
      const task = startStoryImageTask({
        nodeKey: body.nodeKey,
        sessionId: body.sessionId,
        prompt: body.prompt,
        imageUrls: body.imageUrls,
        modelName: body.modelName,
        aspectRatio: body.aspectRatio,
        numImages: body.numImages,
        size: body.size,
        quality: body.quality,
        outputFormat: body.outputFormat,
        source: 'generate-image',
      })
      res.json(mockSuccess(task))
    } catch (err) {
      res.json(mockFail(err.message || '图片生成请求失败'))
    }
  })

  app.post('/agent/story-canvas/batch-query-status', (req, res) => {
    const taskIds = req.body?.taskIds || []
    const results = taskIds.map(id => {
      const payload = localTaskStatusPayload(id) || { taskId: id, status: 'PROCESSING', resultData: null }
      syncTaskResultToLocalNodes(id, payload)
      return payload
    })
    res.json(mockSuccess(results))
  })
  app.get('/agent/story-canvas/generate-image/result/:id', (req, res) => {
    const task = aiTasks.get(req.params.id)
    if (task?.status === 'failed') {
      res.json(mockSuccess({ status: 'failed', imageUrl: null, images: [], errorMessage: task.errorMessage || '图片生成失败' }))
      return
    }
    if (task && task.resultData && task.resultData.length > 0) {
      res.json(mockSuccess({ status: 'completed', imageUrl: task.resultData[0], images: task.resultData.map(url => ({ url })) }))
    } else {
      res.json(mockSuccess({ status: 'completed', imageUrl: null }))
    }
  })
  app.post('/agent/story-canvas/pose-reference', handlePoseReferenceImageEdit)
  app.post('/agent/story-canvas/separate-voice', (req, res) => res.json(mockSuccess({ taskId: 'voice_task_' + uid() })))

  app.post('/agent/canvas/material/upscale-image', (req, res) => res.json(mockSuccess({ taskId: uid() })))
  app.post('/agent/canvas/material/shot-association', (req, res) => res.json(mockSuccess({ taskId: uid(), status: 'PENDING' })))
  app.post('/agent/canvas/material/lip-sync', (req, res) => res.json(mockSuccess({ taskId: uid(), status: 'PENDING' })))
  app.post('/agent/canvas/shot/extend-video', (req, res) => res.json(mockSuccess({ taskId: uid() })))
  app.post('/agent/canvas/shot/optimize-prompt', async (req, res) => {
    if (!useOpenAI()) return res.json(mockSuccess({ optimizedPrompt: req.body?.prompt || '' }))
    try {
      const { prompt } = req.body || {}
      if (prompt) {
        const resp = await openAIRequest('POST', '/v1/chat/completions', {
          model: OPENAI_MODEL,
          messages: [
            { role: 'system', content: '你是一个视频/图像提示词优化专家。请将用户的提示词优化为更详细、更专业的英文提示词，适合AI图像/视频生成模型使用。直接返回优化后的提示词，不要加解释。' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 512, temperature: 0.7,
        })
        const optimized = resp.choices?.[0]?.message?.content || prompt
        return res.json(mockSuccess({ optimizedPrompt: optimized }))
      }
    } catch { /* fallback */ }
    res.json(mockSuccess({ optimizedPrompt: req.body?.prompt || '' }))
  })

  app.get('/agent/scope/experience/whitelist', (req, res) => res.json(mockSuccess(false)))
  app.get('/agent/scope/conversations', (req, res) => res.json(mockSuccess([])))
  app.delete('/agent/scope/messages/:id', (req, res) => res.json(mockSuccess()))
  app.get('/agent/scope/conversations/:id/messages', (req, res) => res.json(mockSuccess([])))
  app.get('/agent/scope/user-skills/page', (req, res) => res.json(mockSuccess({ list: [], total: 0 })))
  app.post('/agent/scope/user-skills/upload', (req, res) => res.json(mockSuccess()))
  app.put('/agent/scope/user-skills/update', (req, res) => res.json(mockSuccess()))
  app.delete('/agent/scope/user-skills/:id', (req, res) => res.json(mockSuccess()))

// ── Catch-all for unmatched API routes ──
app.all(/^\/(api|user|agent|ucenter)\//, (req, res) => res.json(mockSuccess({})))

// ── Proxy to real backend (when API_BASE is set) ──
const proxyRequest = (req, res) => {
  const targetUrl = API_BASE.replace(/\/+$/, '') + req.originalUrl
  const parsed = new URL(targetUrl)

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: { ...req.headers, host: parsed.hostname }
  }

  if (API_KEY) options.headers['Authorization'] = `Bearer ${API_KEY}`
  if (AUTH_TOKEN) options.headers['Authorization'] = `Bearer ${AUTH_TOKEN}`
  if (MODEL) { options.headers['X-Model'] = MODEL; options.headers['X-AI-Model'] = MODEL }

  delete options.headers['connection']
  delete options.headers['content-length']

  const proxy = (parsed.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
    let body = Buffer.alloc(0)
    proxyRes.on('data', (chunk) => { body = Buffer.concat([body, chunk]) })
    proxyRes.on('end', () => {
      const responseHeaders = { ...proxyRes.headers }
      delete responseHeaders['transfer-encoding']
      res.writeHead(proxyRes.statusCode, responseHeaders)
      res.end(body)
    })
  })

  proxy.on('error', (err) => {
    console.error(`[Proxy Error] ${req.method} ${req.originalUrl}: ${err.message}`)
    res.status(502).json({ success: false, message: `Proxy error: ${err.message}` })
  })

  if (req.body && Object.keys(req.body).length > 0) {
    proxy.write(JSON.stringify(req.body))
  } else if (req.headers['content-type']?.includes('application/json')) {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => { if (body) proxy.write(body); proxy.end() })
    return
  }

  proxy.end()
}

// ── Start ──
const localServer = app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════╗`)
  console.log(`║     Wang Local Service                 ║`)
  console.log(`╠══════════════════════════════════════════╣`)
  console.log(`║  URL:    http://localhost:${PORT}`)
  console.log(`║  Workflow: http://localhost:${PORT}/workflow?workspaceId=demo`)
  if (API_BASE) {
    console.log(`║  Proxy:  ${API_BASE}`)
    console.log(`║  Model:  ${MODEL || '(default)'}`)
    console.log(`║  API Key: ${API_KEY ? '✓ set' : '✗ not set'}`)
  } else {
    console.log(`║  Mode:   Mock (no proxy)`)
  }
  if (useOpenAI()) {
    console.log(`║  OpenAI: ${OPENAI_BASE}`)
    console.log(`║  OpenAI Model: ${OPENAI_MODEL}`)
    console.log(`║  OpenAI Key: ${OPENAI_KEY ? '✓ set' : '✗ not set'}`)
  } else {
    console.log(`║  OpenAI: not configured (AI responses will be mock)`)
  }
  console.log(`╚══════════════════════════════════════════╝`)
})
