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

  function normalizeSettings(source = {}) {
    let profiles = Array.isArray(source.openaiProfiles)
      ? source.openaiProfiles.map((profile, index) => normalizeProfile(profile, index))
      : []

    if (profiles.length === 0) {
      profiles = [normalizeProfile({
        id: source.activeOpenaiProfileId || 'default',
        name: source.openaiProfileName || '默认配置',
        baseUrl: source.openaiBaseUrl || '',
        apiKey: source.openaiApiKey || '',
        model: source.openaiModel || 'gpt-4o',
      }, 0)]
    }

    const seen = new Set()
    profiles = profiles.map((profile, index) => {
      let id = profile.id
      if (seen.has(id)) id = `${id}_${index + 1}`
      seen.add(id)
      return { ...profile, id }
    })

    let activeOpenaiProfileId = source.activeOpenaiProfileId || source.activeOpenaiProfile?.id || profiles[0].id
    if (!profiles.some(profile => profile.id === activeOpenaiProfileId)) activeOpenaiProfileId = profiles[0].id
    const active = profiles.find(profile => profile.id === activeOpenaiProfileId) || profiles[0]

    return {
      apiBaseUrl: String(source.apiBaseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(source.apiKey || ''),
      openaiProfiles: profiles,
      activeOpenaiProfileId,
      openaiBaseUrl: active?.baseUrl || '',
      openaiApiKey: active?.apiKey || '',
      openaiModel: active?.model || 'gpt-4o',
      outputFormat: source.outputFormat === 'jpeg' ? 'jpeg' : 'png',
      openaiStreamingEnabled: source.openaiStreamingEnabled !== false,
    }
  }

  function mergeSettings(local = {}, server = {}) {
    const localHasProfiles = Array.isArray(local.openaiProfiles) && local.openaiProfiles.length > 0
    const serverHasProfiles = Array.isArray(server.openaiProfiles) && server.openaiProfiles.length > 0
    const localHasLegacy = !!(local.openaiBaseUrl || local.openaiApiKey || local.openaiModel)
    const profileSource = localHasProfiles ? local : serverHasProfiles ? server : localHasLegacy ? local : server
    return normalizeSettings({
      ...server,
      ...local,
      openaiProfiles: profileSource.openaiProfiles,
      activeOpenaiProfileId: local.activeOpenaiProfileId || server.activeOpenaiProfileId || profileSource.activeOpenaiProfileId,
      openaiBaseUrl: profileSource.openaiBaseUrl,
      openaiApiKey: profileSource.openaiApiKey,
      openaiModel: profileSource.openaiModel,
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

  function getActiveProfile(settings = loadLocal()) {
    return settings.openaiProfiles.find(profile => profile.id === settings.activeOpenaiProfileId) || settings.openaiProfiles[0]
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
      <div class="section-title">AI 模型</div>
      <div class="field">
        <label>当前使用</label>
        <div class="profile-row">
          <select id="wang-profile-select"></select>
          <button type="button" class="mini-btn" id="wang-profile-add">新增</button>
          <button type="button" class="mini-btn danger" id="wang-profile-delete">删除</button>
        </div>
      </div>
      <div class="field">
        <label>配置名称</label>
        <input id="wang-input-profile-name" type="text" placeholder="例如：主账号 / 备用 / 本地代理">
      </div>
      <div class="field">
        <label>API 地址 (OpenAI 兼容)</label>
        <input id="wang-input-url" type="text" placeholder="https://sub.g-aisc.com">
      </div>
      <div class="field">
        <label>API 密钥</label>
        <input id="wang-input-key" type="password" placeholder="sk-...">
      </div>
      <div class="field">
        <label>模型名称</label>
        <input id="wang-input-model" type="text" placeholder="gpt-4o">
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

  function setProfileFields(profile) {
    const values = {
      'wang-input-profile-name': profile?.name || '',
      'wang-input-url': profile?.baseUrl || '',
      'wang-input-key': profile?.apiKey || '',
      'wang-input-model': profile?.model || 'gpt-4o',
    }
    Object.entries(values).forEach(([id, value]) => {
      const el = document.getElementById(id)
      if (el) el.value = value
    })
  }

  function renderProfileSelect(settings = draftSettings || loadLocal()) {
    const select = document.getElementById('wang-profile-select')
    if (!select) return
    select.innerHTML = settings.openaiProfiles
      .map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`)
      .join('')
    select.value = settings.activeOpenaiProfileId
  }

  function readSettingsFromDialog() {
    const settings = normalizeSettings(draftSettings || loadLocal())
    settings.apiBaseUrl = (document.getElementById('wang-input-apibase')?.value || '').trim().replace(/\/+$/, '')
    settings.apiKey = document.getElementById('wang-input-apikey')?.value || ''
    settings.outputFormat = document.getElementById('wang-input-format')?.value === 'jpeg' ? 'jpeg' : 'png'
    settings.openaiStreamingEnabled = document.getElementById('wang-input-streaming')?.value !== 'non_stream'

    const active = getActiveProfile(settings)
    if (active) {
      active.name = (document.getElementById('wang-input-profile-name')?.value || active.name || '默认配置').trim() || '默认配置'
      active.baseUrl = (document.getElementById('wang-input-url')?.value || '').trim().replace(/\/+$/, '')
      active.apiKey = document.getElementById('wang-input-key')?.value || ''
      active.model = (document.getElementById('wang-input-model')?.value || 'gpt-4o').trim() || 'gpt-4o'
      settings.openaiBaseUrl = active.baseUrl
      settings.openaiApiKey = active.apiKey
      settings.openaiModel = active.model
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
    renderProfileSelect(local)
    setProfileFields(getActiveProfile(local))
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
    const aiUrl = document.getElementById('wang-input-url')?.value || ''
    const aiKey = document.getElementById('wang-input-key')?.value || ''
    const profileName = document.getElementById('wang-input-profile-name')?.value || '当前配置'
    if (!proxyUrl && !aiKey) {
      bar.innerHTML = '<span class="dot red"></span><span>未配置任一服务</span>'
      return
    }
    const parts = []
    if (proxyUrl) parts.push('代理: ' + escapeHtml(proxyUrl))
    if (aiKey && !aiUrl) parts.push(escapeHtml(profileName) + ': 缺少 API 地址')
    if (aiKey && aiUrl) {
      bar.innerHTML = '<span class="dot yellow"></span><span>检测 AI 连接...</span>'
      try {
        const r = await fetch(aiUrl.replace(/\/+$/, '') + '/v1/models', {
          headers: { 'Authorization': 'Bearer ' + aiKey },
        })
        if (r.ok) {
          const data = await r.json()
          const count = data?.data?.length || 0
          parts.push(escapeHtml(profileName) + ': 可用 (' + count + ' 模型)')
        } else {
          const err = await r.json().catch(() => ({}))
          parts.push(escapeHtml(profileName) + ': ' + escapeHtml(err.error?.message || String(r.status)))
        }
      } catch {
        parts.push(escapeHtml(profileName) + ': 连接失败')
      }
    }
    bar.innerHTML = '<span class="dot ' + (proxyUrl || aiKey ? 'green' : 'red') + '"></span><span>' + parts.join(' | ') + '</span>'
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

  function addProfile() {
    const settings = readSettingsFromDialog()
    const profile = normalizeProfile({
      id: createProfileId(),
      name: `配置 ${settings.openaiProfiles.length + 1}`,
      baseUrl: '',
      apiKey: '',
      model: getActiveProfile(settings)?.model || 'gpt-4o',
    }, settings.openaiProfiles.length)
    settings.openaiProfiles.push(profile)
    settings.activeOpenaiProfileId = profile.id
    draftSettings = normalizeSettings(settings)
    renderProfileSelect(settings)
    setProfileFields(profile)
    scheduleStatusCheck()
  }

  function deleteProfile() {
    const settings = readSettingsFromDialog()
    if (settings.openaiProfiles.length <= 1) {
      const profile = settings.openaiProfiles[0]
      profile.name = '默认配置'
      profile.baseUrl = ''
      profile.apiKey = ''
      profile.model = 'gpt-4o'
      draftSettings = normalizeSettings(settings)
      renderProfileSelect(settings)
      setProfileFields(profile)
      scheduleStatusCheck()
      return
    }
    const activeId = settings.activeOpenaiProfileId
    settings.openaiProfiles = settings.openaiProfiles.filter(profile => profile.id !== activeId)
    settings.activeOpenaiProfileId = settings.openaiProfiles[0].id
    draftSettings = normalizeSettings(settings)
    renderProfileSelect(settings)
    setProfileFields(getActiveProfile(settings))
    scheduleStatusCheck()
  }

  function switchProfile(profileId) {
    const settings = readSettingsFromDialog()
    settings.activeOpenaiProfileId = profileId
    const normalized = normalizeSettings(settings)
    draftSettings = normalized
    renderProfileSelect(normalized)
    setProfileFields(getActiveProfile(normalized))
    scheduleStatusCheck()
  }

  function hasConfig(settings = loadLocal()) {
    const active = getActiveProfile(settings)
    return !!(settings.apiBaseUrl || active?.apiKey)
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
      if (e.target.id === 'wang-profile-add') addProfile()
      if (e.target.id === 'wang-profile-delete') deleteProfile()
    })
    document.addEventListener('change', (e) => {
      if (e.target.id === 'wang-profile-select') switchProfile(e.target.value)
      if (e.target.id === 'wang-input-format') window.__outputFormat = e.target.value || 'png'
      if (e.target.id === 'wang-input-streaming') window.__openaiStreamingEnabled = e.target.value !== 'non_stream'
    })
    document.addEventListener('input', (e) => {
      if (
        e.target.id === 'wang-input-url' ||
        e.target.id === 'wang-input-key' ||
        e.target.id === 'wang-input-profile-name' ||
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
