(function () {
  'use strict'

  const LS_KEY = 'wang_openai_config'

  let dialogEl = null
  let overlayEl = null
  let statusTimer = null
  let draftSettings = null

  function createProfileId() {
    return 'profile_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
  }

  function normalizeProfile(profile = {}, index = 0) {
    const fallbackId = index === 0 ? 'default' : `profile_${index + 1}`
    return {
      id: String(profile.id || fallbackId).trim() || fallbackId,
      name: String(profile.name || profile.label || (index === 0 ? '默认配置' : `配置 ${index + 1}`)).trim() || `配置 ${index + 1}`,
      baseUrl: String(profile.baseUrl || profile.openaiBaseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(profile.apiKey || profile.openaiApiKey || ''),
      model: String(profile.model || profile.openaiModel || 'gpt-4o').trim() || 'gpt-4o',
    }
  }

  function normalizeProfiles(profiles, fallback = {}) {
    profiles = Array.isArray(profiles)
      ? profiles.map((profile, index) => normalizeProfile(profile, index))
      : []
    if (profiles.length === 0) profiles = [normalizeProfile(fallback, 0)]
    const seen = new Set()
    return profiles.map((profile, index) => {
      let id = profile.id
      if (seen.has(id)) id = `${id}_${index + 1}`
      seen.add(id)
      return { ...profile, id }
    })
  }

  function normalizeSettings(source = {}) {
    const imageProfiles = normalizeProfiles(
      source.imageOpenaiProfiles || source.openaiProfiles,
      {
        id: source.activeImageOpenaiProfileId || source.activeOpenaiProfileId || 'default',
        name: source.openaiProfileName || '图片配置',
        baseUrl: source.openaiBaseUrl || '',
        apiKey: source.openaiApiKey || '',
        model: source.openaiModel || 'gpt-image-2',
      }
    )
    const textProfiles = normalizeProfiles(
      source.textOpenaiProfiles,
      {
        id: source.activeTextOpenaiProfileId || 'text_default',
        name: source.textOpenaiProfileName || '文本配置',
        baseUrl: source.textOpenaiBaseUrl || '',
        apiKey: source.textOpenaiApiKey || '',
        model: source.textOpenaiModel || 'gpt-4o',
      }
    )

    let activeImageOpenaiProfileId = source.activeImageOpenaiProfileId || source.activeOpenaiProfileId || source.activeImageOpenaiProfile?.id || source.activeOpenaiProfile?.id || imageProfiles[0].id
    if (!imageProfiles.some(profile => profile.id === activeImageOpenaiProfileId)) activeImageOpenaiProfileId = imageProfiles[0].id
    const activeImage = imageProfiles.find(profile => profile.id === activeImageOpenaiProfileId) || imageProfiles[0]

    let activeTextOpenaiProfileId = source.activeTextOpenaiProfileId || source.activeTextOpenaiProfile?.id || textProfiles[0].id
    if (!textProfiles.some(profile => profile.id === activeTextOpenaiProfileId)) activeTextOpenaiProfileId = textProfiles[0].id
    const activeText = textProfiles.find(profile => profile.id === activeTextOpenaiProfileId) || textProfiles[0]

    return {
      apiBaseUrl: String(source.apiBaseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(source.apiKey || ''),
      imageOpenaiProfiles: imageProfiles,
      activeImageOpenaiProfileId,
      openaiProfiles: imageProfiles,
      activeOpenaiProfileId: activeImageOpenaiProfileId,
      openaiBaseUrl: activeImage?.baseUrl || '',
      openaiApiKey: activeImage?.apiKey || '',
      openaiModel: activeImage?.model || 'gpt-image-2',
      textOpenaiProfiles: textProfiles,
      activeTextOpenaiProfileId,
      textOpenaiBaseUrl: activeText?.baseUrl || '',
      textOpenaiApiKey: activeText?.apiKey || '',
      textOpenaiModel: activeText?.model || 'gpt-4o',
      outputFormat: source.outputFormat === 'jpeg' ? 'jpeg' : 'png',
      openaiStreamingEnabled: source.openaiStreamingEnabled !== false,
    }
  }

  function mergeSettings(local = {}, server = {}) {
    const localHasProfiles = Array.isArray(local.imageOpenaiProfiles || local.openaiProfiles) && (local.imageOpenaiProfiles || local.openaiProfiles).length > 0
    const serverHasProfiles = Array.isArray(server.imageOpenaiProfiles || server.openaiProfiles) && (server.imageOpenaiProfiles || server.openaiProfiles).length > 0
    const localHasLegacy = !!(local.openaiBaseUrl || local.openaiApiKey || local.openaiModel)
    const profileSource = localHasProfiles ? local : serverHasProfiles ? server : localHasLegacy ? local : server
    const localHasTextProfiles = Array.isArray(local.textOpenaiProfiles) && local.textOpenaiProfiles.length > 0
    const serverHasTextProfiles = Array.isArray(server.textOpenaiProfiles) && server.textOpenaiProfiles.length > 0
    const localHasTextLegacy = !!(local.textOpenaiBaseUrl || local.textOpenaiApiKey || local.textOpenaiModel)
    const textProfileSource = localHasTextProfiles ? local : serverHasTextProfiles ? server : localHasTextLegacy ? local : server
    return normalizeSettings({
      ...server,
      ...local,
      imageOpenaiProfiles: profileSource.imageOpenaiProfiles || profileSource.openaiProfiles,
      openaiProfiles: profileSource.imageOpenaiProfiles || profileSource.openaiProfiles,
      activeImageOpenaiProfileId: local.activeImageOpenaiProfileId || local.activeOpenaiProfileId || server.activeImageOpenaiProfileId || server.activeOpenaiProfileId || profileSource.activeImageOpenaiProfileId || profileSource.activeOpenaiProfileId,
      activeOpenaiProfileId: local.activeImageOpenaiProfileId || local.activeOpenaiProfileId || server.activeImageOpenaiProfileId || server.activeOpenaiProfileId || profileSource.activeImageOpenaiProfileId || profileSource.activeOpenaiProfileId,
      openaiBaseUrl: profileSource.openaiBaseUrl,
      openaiApiKey: profileSource.openaiApiKey,
      openaiModel: profileSource.openaiModel,
      textOpenaiProfiles: textProfileSource.textOpenaiProfiles,
      activeTextOpenaiProfileId: local.activeTextOpenaiProfileId || server.activeTextOpenaiProfileId || textProfileSource.activeTextOpenaiProfileId,
      textOpenaiBaseUrl: textProfileSource.textOpenaiBaseUrl,
      textOpenaiApiKey: textProfileSource.textOpenaiApiKey,
      textOpenaiModel: textProfileSource.textOpenaiModel,
    })
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY)
      return raw ? normalizeSettings(JSON.parse(raw)) : normalizeSettings({})
    } catch {
      return normalizeSettings({})
    }
  }

  function saveLocal(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(normalizeSettings(data))) } catch {}
  }

  function getActiveProfile(settings = loadLocal(), kind = 'image') {
    const profiles = kind === 'text' ? settings.textOpenaiProfiles : settings.imageOpenaiProfiles
    const activeId = kind === 'text' ? settings.activeTextOpenaiProfileId : settings.activeImageOpenaiProfileId
    return profiles.find(profile => profile.id === activeId) || profiles[0]
  }

  function getApiUrl(path) {
    return window.location.origin + '/api/openai-config' + path
  }

  async function fetchServerConfig() {
    try {
      const r = await fetch(getApiUrl(''))
      return await r.json()
    } catch {
      return {}
    }
  }

  async function pushToServer(data) {
    try {
      await fetch(getApiUrl(''), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalizeSettings(data)),
      })
    } catch {}
  }

  async function syncSettings() {
    const localRaw = (() => {
      try {
        const raw = localStorage.getItem(LS_KEY)
        return raw ? JSON.parse(raw) : {}
      } catch {
        return {}
      }
    })()
    const server = await fetchServerConfig()
    const merged = mergeSettings(localRaw, server)
    saveLocal(merged)
    await pushToServer(merged)
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  function createStyles() {
    const style = document.createElement('style')
    style.textContent = `
#wang-settings-btn {
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 99999;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(24,24,27,0.9);
  backdrop-filter: blur(8px);
  color: #a1a1aa;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
#wang-settings-btn:hover {
  background: rgba(39,39,42,0.95);
  color: #fff;
  border-color: rgba(255,255,255,0.2);
}
#wang-settings-btn .indicator {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 2px solid rgba(24,24,27,0.9);
}
#wang-settings-btn .indicator.on { background: #22c55e; }
#wang-settings-btn .indicator.off { background: #ef4444; }

#wang-settings-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 100000;
  background: rgba(0,0,0,0.5);
  display: none;
  align-items: center;
  justify-content: center;
}
#wang-settings-overlay.open { display: flex; }

#wang-settings-dialog {
  width: 460px;
  max-width: 92vw;
  max-height: 92vh;
  overflow: auto;
  background: #18181b;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  padding: 24px;
  color: #e4e4e7;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
}
#wang-settings-dialog h2 {
  margin: 0 0 20px;
  font-size: 15px;
  font-weight: 600;
  color: #f4f4f5;
  display: flex;
  align-items: center;
  gap: 8px;
}
#wang-settings-dialog h2 svg {
  opacity: 0.5;
  width: 18px;
  height: 18px;
}
#wang-settings-dialog .section-title {
  font-size: 11px;
  font-weight: 600;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 16px 0 10px;
  padding-top: 12px;
  border-top: 1px solid rgba(255,255,255,0.06);
}
#wang-settings-dialog .field { margin-bottom: 14px; }
#wang-settings-dialog label {
  display: block;
  font-size: 12px;
  color: #a1a1aa;
  margin-bottom: 4px;
  font-weight: 500;
}
#wang-settings-dialog input,
#wang-settings-dialog select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  background: rgba(255,255,255,0.05);
  color: #e4e4e7;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
#wang-settings-dialog input:focus,
#wang-settings-dialog select:focus {
  border-color: rgba(99,102,241,0.5);
  background: rgba(255,255,255,0.08);
}
#wang-settings-dialog input::placeholder { color: rgba(255,255,255,0.2); }
#wang-settings-dialog .profile-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  margin-bottom: 14px;
}
#wang-settings-dialog .mini-btn {
  min-width: 54px;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.06);
  color: #d4d4d8;
  cursor: pointer;
}
#wang-settings-dialog .mini-btn:hover { background: rgba(255,255,255,0.1); }
#wang-settings-dialog .mini-btn.danger { color: #fca5a5; }
#wang-settings-dialog .status-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #a1a1aa;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(255,255,255,0.06);
}
#wang-settings-dialog .status-bar .dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
#wang-settings-dialog .status-bar .dot.green { background: #22c55e; }
#wang-settings-dialog .status-bar .dot.red { background: #ef4444; }
#wang-settings-dialog .status-bar .dot.yellow { background: #eab308; }
#wang-settings-dialog .actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  justify-content: flex-end;
}
#wang-settings-dialog .actions button {
  padding: 7px 14px;
  border-radius: 6px;
  border: none;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
#wang-settings-dialog .actions .btn-save {
  background: #6366f1;
  color: #fff;
}
#wang-settings-dialog .actions .btn-save:hover { background: #4f46e5; }
#wang-settings-dialog .actions .btn-cancel {
  background: rgba(255,255,255,0.06);
  color: #a1a1aa;
}
#wang-settings-dialog .actions .btn-cancel:hover { background: rgba(255,255,255,0.1); }
`
    document.head.appendChild(style)
  }

  function updateIndicator(hasKey) {
    const btn = document.getElementById('wang-settings-btn')
    if (!btn) return
    const dot = btn.querySelector('.indicator')
    if (!dot) return
    dot.className = 'indicator ' + (hasKey ? 'on' : 'off')
  }

  function buildDialog() {
    overlayEl = document.createElement('div')
    overlayEl.id = 'wang-settings-overlay'

    dialogEl = document.createElement('div')
    dialogEl.id = 'wang-settings-dialog'
    dialogEl.innerHTML = `
      <h2>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        服务配置
      </h2>
      <div class="section-title">API 代理</div>
      <div class="field">
        <label>代理地址</label>
        <input id="wang-input-apibase" type="text" placeholder="https://api.example.com">
      </div>
      <div class="field">
        <label>代理密钥</label>
        <input id="wang-input-apikey" type="password" placeholder="可选">
      </div>
      <div class="section-title">图片生成 API</div>
      <div class="field">
        <label>当前图片配置</label>
        <div class="profile-row">
          <select id="wang-image-profile-select"></select>
          <button type="button" class="mini-btn" id="wang-image-profile-add">新增</button>
          <button type="button" class="mini-btn danger" id="wang-image-profile-delete">删除</button>
        </div>
      </div>
      <div class="field">
        <label>配置名称</label>
        <input id="wang-input-image-profile-name" type="text" placeholder="例如：图片主账号 / 备用图像接口">
      </div>
      <div class="field">
        <label>图片 API 地址 (OpenAI 兼容)</label>
        <input id="wang-input-image-url" type="text" placeholder="https://sub.g-aisc.com">
      </div>
      <div class="field">
        <label>图片 API 密钥</label>
        <input id="wang-input-image-key" type="password" placeholder="sk-...">
      </div>
      <div class="field">
        <label>图片模型名称</label>
        <input id="wang-input-image-model" type="text" placeholder="gpt-image-2">
      </div>
      <div class="section-title">文本生成 API</div>
      <div class="field">
        <label>当前文本配置</label>
        <div class="profile-row">
          <select id="wang-text-profile-select"></select>
          <button type="button" class="mini-btn" id="wang-text-profile-add">新增</button>
          <button type="button" class="mini-btn danger" id="wang-text-profile-delete">删除</button>
        </div>
      </div>
      <div class="field">
        <label>配置名称</label>
        <input id="wang-input-text-profile-name" type="text" placeholder="例如：文本主账号 / 备用聊天接口">
      </div>
      <div class="field">
        <label>文本 API 地址 (OpenAI 兼容)</label>
        <input id="wang-input-text-url" type="text" placeholder="https://api.openai.com">
      </div>
      <div class="field">
        <label>文本 API 密钥</label>
        <input id="wang-input-text-key" type="password" placeholder="sk-...">
      </div>
      <div class="field">
        <label>文本模型名称</label>
        <input id="wang-input-text-model" type="text" placeholder="gpt-4o">
      </div>
      <div class="field">
        <label>输出格式</label>
        <select id="wang-input-format">
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </select>
      </div>
      <div class="field">
        <label>请求模式</label>
        <select id="wang-input-streaming">
          <option value="stream">流式</option>
          <option value="non_stream">非流式</option>
        </select>
      </div>
      <div class="status-bar" id="wang-status-bar">
        <span class="dot yellow"></span>
        <span>未检测</span>
      </div>
      <div class="actions">
        <button class="btn-cancel" id="wang-btn-cancel">取消</button>
        <button class="btn-save" id="wang-btn-save">保存</button>
      </div>
    `

    overlayEl.appendChild(dialogEl)
    document.body.appendChild(overlayEl)
  }

  function setProfileFields(kind, profile) {
    const prefix = kind === 'text' ? 'text' : 'image'
    const fallbackModel = kind === 'text' ? 'gpt-4o' : 'gpt-image-2'
    const values = {
      [`wang-input-${prefix}-profile-name`]: profile?.name || '',
      [`wang-input-${prefix}-url`]: profile?.baseUrl || '',
      [`wang-input-${prefix}-key`]: profile?.apiKey || '',
      [`wang-input-${prefix}-model`]: profile?.model || fallbackModel,
    }
    Object.entries(values).forEach(([id, value]) => {
      const el = document.getElementById(id)
      if (el) el.value = value
    })
  }

  function renderProfileSelect(kind, settings = draftSettings || loadLocal()) {
    const prefix = kind === 'text' ? 'text' : 'image'
    const select = document.getElementById(`wang-${prefix}-profile-select`)
    if (!select) return
    const profiles = kind === 'text' ? settings.textOpenaiProfiles : settings.imageOpenaiProfiles
    const activeId = kind === 'text' ? settings.activeTextOpenaiProfileId : settings.activeImageOpenaiProfileId
    select.innerHTML = profiles
      .map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`)
      .join('')
    select.value = activeId
  }

  function readSettingsFromDialog() {
    const settings = normalizeSettings(draftSettings || loadLocal())
    settings.apiBaseUrl = (document.getElementById('wang-input-apibase')?.value || '').trim().replace(/\/+$/, '')
    settings.apiKey = document.getElementById('wang-input-apikey')?.value || ''
    settings.outputFormat = document.getElementById('wang-input-format')?.value === 'jpeg' ? 'jpeg' : 'png'
    settings.openaiStreamingEnabled = document.getElementById('wang-input-streaming')?.value !== 'non_stream'

    const activeImage = getActiveProfile(settings, 'image')
    if (activeImage) {
      activeImage.name = (document.getElementById('wang-input-image-profile-name')?.value || activeImage.name || '图片配置').trim() || '图片配置'
      activeImage.baseUrl = (document.getElementById('wang-input-image-url')?.value || '').trim().replace(/\/+$/, '')
      activeImage.apiKey = document.getElementById('wang-input-image-key')?.value || ''
      activeImage.model = (document.getElementById('wang-input-image-model')?.value || 'gpt-image-2').trim() || 'gpt-image-2'
      settings.openaiBaseUrl = activeImage.baseUrl
      settings.openaiApiKey = activeImage.apiKey
      settings.openaiModel = activeImage.model
    }

    const activeText = getActiveProfile(settings, 'text')
    if (activeText) {
      activeText.name = (document.getElementById('wang-input-text-profile-name')?.value || activeText.name || '文本配置').trim() || '文本配置'
      activeText.baseUrl = (document.getElementById('wang-input-text-url')?.value || '').trim().replace(/\/+$/, '')
      activeText.apiKey = document.getElementById('wang-input-text-key')?.value || ''
      activeText.model = (document.getElementById('wang-input-text-model')?.value || 'gpt-4o').trim() || 'gpt-4o'
      settings.textOpenaiBaseUrl = activeText.baseUrl
      settings.textOpenaiApiKey = activeText.apiKey
      settings.textOpenaiModel = activeText.model
    }

    draftSettings = normalizeSettings(settings)
    return draftSettings
  }

  function showDialog() {
    draftSettings = loadLocal()
    const local = draftSettings
    document.getElementById('wang-input-apibase').value = local.apiBaseUrl || ''
    document.getElementById('wang-input-apikey').value = local.apiKey || ''
    const fmt = document.getElementById('wang-input-format')
    if (fmt) fmt.value = local.outputFormat || 'png'
    window.__outputFormat = fmt?.value || 'png'
    const streaming = document.getElementById('wang-input-streaming')
    if (streaming) streaming.value = local.openaiStreamingEnabled === false ? 'non_stream' : 'stream'
    window.__openaiStreamingEnabled = streaming?.value !== 'non_stream'
    renderProfileSelect('image', local)
    renderProfileSelect('text', local)
    setProfileFields('image', getActiveProfile(local, 'image'))
    setProfileFields('text', getActiveProfile(local, 'text'))
    overlayEl.classList.add('open')
    checkStatus()
  }

  function hideDialog() {
    overlayEl.classList.remove('open')
    draftSettings = null
  }

  async function checkStatus() {
    const bar = document.getElementById('wang-status-bar')
    if (!bar) return
    const proxyUrl = document.getElementById('wang-input-apibase')?.value || ''
    const imageUrl = document.getElementById('wang-input-image-url')?.value || ''
    const imageKey = document.getElementById('wang-input-image-key')?.value || ''
    const imageName = document.getElementById('wang-input-image-profile-name')?.value || '图片配置'
    const textUrl = document.getElementById('wang-input-text-url')?.value || ''
    const textKey = document.getElementById('wang-input-text-key')?.value || ''
    const textName = document.getElementById('wang-input-text-profile-name')?.value || '文本配置'
    if (!proxyUrl && !imageKey && !textKey) {
      bar.innerHTML = '<span class="dot red"></span><span>未配置任一服务</span>'
      return
    }
    const parts = []
    if (proxyUrl) parts.push('代理: ' + escapeHtml(proxyUrl))
    const checks = [
      { label: '图片', name: imageName, url: imageUrl, key: imageKey },
      { label: '文本', name: textName, url: textUrl, key: textKey },
    ].filter(item => item.key || item.url)
    if (checks.some(item => item.key && item.url)) {
      bar.innerHTML = '<span class="dot yellow"></span><span>检测 API 连接...</span>'
    }
    for (const item of checks) {
      if (item.key && !item.url) {
        parts.push(item.label + ': 缺少 API 地址')
        continue
      }
      if (!item.key && item.url) {
        parts.push(item.label + ': 缺少 API 密钥')
        continue
      }
      try {
        const r = await fetch(item.url.replace(/\/+$/, '') + '/v1/models', {
          headers: { 'Authorization': 'Bearer ' + item.key },
        })
        if (r.ok) {
          const data = await r.json()
          const count = data?.data?.length || 0
          parts.push(item.label + ' ' + escapeHtml(item.name) + ': 可用 (' + count + ' 模型)')
        } else {
          const err = await r.json().catch(() => ({}))
          parts.push(item.label + ' ' + escapeHtml(item.name) + ': ' + escapeHtml(err.error?.message || String(r.status)))
        }
      } catch {
        parts.push(item.label + ' ' + escapeHtml(item.name) + ': 连接失败')
      }
    }
    bar.innerHTML = '<span class="dot ' + (proxyUrl || imageKey || textKey ? 'green' : 'red') + '"></span><span>' + parts.join(' | ') + '</span>'
  }

  function scheduleStatusCheck() {
    clearTimeout(statusTimer)
    statusTimer = setTimeout(checkStatus, 350)
  }

  async function saveSettings() {
    const data = readSettingsFromDialog()
    window.__outputFormat = data.outputFormat
    window.__openaiStreamingEnabled = data.openaiStreamingEnabled !== false
    saveLocal(data)
    await pushToServer(data)
    updateIndicator(hasConfig(data))
    hideDialog()
  }

  function addProfile(kind = 'image') {
    const settings = readSettingsFromDialog()
    const profiles = kind === 'text' ? settings.textOpenaiProfiles : settings.imageOpenaiProfiles
    const profile = normalizeProfile({
      id: createProfileId(),
      name: `${kind === 'text' ? '文本配置' : '图片配置'} ${profiles.length + 1}`,
      baseUrl: '',
      apiKey: '',
      model: getActiveProfile(settings, kind)?.model || (kind === 'text' ? 'gpt-4o' : 'gpt-image-2'),
    }, profiles.length)
    profiles.push(profile)
    if (kind === 'text') settings.activeTextOpenaiProfileId = profile.id
    else {
      settings.activeImageOpenaiProfileId = profile.id
      settings.activeOpenaiProfileId = profile.id
    }
    draftSettings = normalizeSettings(settings)
    renderProfileSelect(kind, draftSettings)
    setProfileFields(kind, profile)
    scheduleStatusCheck()
  }

  function deleteProfile(kind = 'image') {
    const settings = readSettingsFromDialog()
    const profiles = kind === 'text' ? settings.textOpenaiProfiles : settings.imageOpenaiProfiles
    if (profiles.length <= 1) {
      const profile = profiles[0]
      profile.name = kind === 'text' ? '文本配置' : '图片配置'
      profile.baseUrl = ''
      profile.apiKey = ''
      profile.model = kind === 'text' ? 'gpt-4o' : 'gpt-image-2'
      draftSettings = normalizeSettings(settings)
      renderProfileSelect(kind, draftSettings)
      setProfileFields(kind, profile)
      scheduleStatusCheck()
      return
    }
    const activeId = kind === 'text' ? settings.activeTextOpenaiProfileId : settings.activeImageOpenaiProfileId
    const nextProfiles = profiles.filter(profile => profile.id !== activeId)
    if (kind === 'text') {
      settings.textOpenaiProfiles = nextProfiles
      settings.activeTextOpenaiProfileId = nextProfiles[0].id
    } else {
      settings.imageOpenaiProfiles = nextProfiles
      settings.openaiProfiles = nextProfiles
      settings.activeImageOpenaiProfileId = nextProfiles[0].id
      settings.activeOpenaiProfileId = nextProfiles[0].id
    }
    draftSettings = normalizeSettings(settings)
    renderProfileSelect(kind, draftSettings)
    setProfileFields(kind, getActiveProfile(draftSettings, kind))
    scheduleStatusCheck()
  }

  function switchProfile(kind, profileId) {
    const settings = readSettingsFromDialog()
    if (kind === 'text') settings.activeTextOpenaiProfileId = profileId
    else {
      settings.activeImageOpenaiProfileId = profileId
      settings.activeOpenaiProfileId = profileId
    }
    const normalized = normalizeSettings(settings)
    draftSettings = normalized
    renderProfileSelect(kind, normalized)
    setProfileFields(kind, getActiveProfile(normalized, kind))
    scheduleStatusCheck()
  }

  function hasConfig(settings = loadLocal()) {
    const image = getActiveProfile(settings, 'image')
    const text = getActiveProfile(settings, 'text')
    return !!(settings.apiBaseUrl || image?.apiKey || text?.apiKey)
  }

  function createButton() {
    const btn = document.createElement('button')
    btn.id = 'wang-settings-btn'
    btn.title = '服务配置'
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
      <span class="indicator ${hasConfig() ? 'on' : 'off'}"></span>
    `
    btn.addEventListener('click', showDialog)
    const tryAppend = () => {
      if (document.body.contains(document.getElementById('wang-settings-btn'))) return
      if (document.querySelector('#app') && document.querySelector('#app').children.length > 0) {
        document.body.appendChild(btn)
      } else {
        setTimeout(tryAppend, 500)
      }
    }
    tryAppend()
  }

  function bindEvents() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('#wang-settings-overlay') && !e.target.closest('#wang-settings-dialog')) hideDialog()
      if (e.target.id === 'wang-btn-cancel') hideDialog()
      if (e.target.id === 'wang-btn-save') saveSettings()
      if (e.target.id === 'wang-image-profile-add') addProfile('image')
      if (e.target.id === 'wang-image-profile-delete') deleteProfile('image')
      if (e.target.id === 'wang-text-profile-add') addProfile('text')
      if (e.target.id === 'wang-text-profile-delete') deleteProfile('text')
    })
    document.addEventListener('change', (e) => {
      if (e.target.id === 'wang-image-profile-select') switchProfile('image', e.target.value)
      if (e.target.id === 'wang-text-profile-select') switchProfile('text', e.target.value)
      if (e.target.id === 'wang-input-format') window.__outputFormat = e.target.value || 'png'
      if (e.target.id === 'wang-input-streaming') window.__openaiStreamingEnabled = e.target.value !== 'non_stream'
    })
    document.addEventListener('input', (e) => {
      if (
        e.target.id === 'wang-input-image-url' ||
        e.target.id === 'wang-input-image-key' ||
        e.target.id === 'wang-input-image-profile-name' ||
        e.target.id === 'wang-input-text-url' ||
        e.target.id === 'wang-input-text-key' ||
        e.target.id === 'wang-input-text-profile-name' ||
        e.target.id === 'wang-input-apibase'
      ) {
        scheduleStatusCheck()
      }
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.closest('#wang-settings-dialog')) {
        e.preventDefault()
        saveSettings()
      }
    })
  }

  async function init() {
    await syncSettings()
    const local = loadLocal()
    window.__outputFormat = local.outputFormat || 'png'
    window.__openaiStreamingEnabled = local.openaiStreamingEnabled !== false
    createStyles()
    buildDialog()
    createButton()
    bindEvents()
    updateIndicator(hasConfig(local))
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
