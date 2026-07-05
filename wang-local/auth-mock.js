;(function () {
  const dataImageCache = new Map()
  const DATA_IMAGE_PREFIX = 'data:image/'
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null
  const MAX_LOCAL_UPLOAD_REQUESTS = 4
  let localUploadActiveCount = 0
  const localUploadQueue = []
  const IMAGE_PROMPT_PRESET_STORAGE_KEY = 'wang_image_node_prompt_preset'
  const LEGACY_IMAGE_PROMPT_PRESET_STORAGE_KEY = 'wang_image_prompt_preset'
  const IMAGE_PROMPT_PRESET_UNLOCK_TEXT = '\u2060'
  const IMAGE_PROMPT_PRESET_UNLOCK_RE = /[\u200B\u2060]/g
  const IMAGE_PROMPT_PRESETS = {
    character_three_view: {
      id: 'character_three_view',
      label: '人物三视图',
      prompt: '生成全身三视图以及一张正面面部特写(最左边占满三分之一的位置是超大面部正面特写，面部特写为黑白素描风格，一定要是素描风格)，右边三分之二放正视图，侧视图，后视图（右侧的三视图脸部打码，打码是一个白色的正方形色块），无背景，头发没有任何装饰物品，',
    },
  }
  const IMAGE_PROMPT_PRESET_ALIASES = {
    '人物三视图': 'character_three_view',
    character_three_view: 'character_three_view',
    person_three_view: 'character_three_view',
    three_view: 'character_three_view',
    char_three_view: 'character_three_view',
  }

  function getImagePromptPreset(value) {
    const raw = String(value || '').trim()
    if (!raw || raw === 'none' || raw === 'default') return null
    const key = IMAGE_PROMPT_PRESET_ALIASES[raw] || IMAGE_PROMPT_PRESET_ALIASES[raw.toLowerCase()] || raw
    return IMAGE_PROMPT_PRESETS[key] || null
  }

  function selectedImagePromptPresetId() {
    try {
      return localStorage.getItem(IMAGE_PROMPT_PRESET_STORAGE_KEY) ||
        localStorage.getItem(LEGACY_IMAGE_PROMPT_PRESET_STORAGE_KEY) ||
        ''
    } catch {
      return ''
    }
  }

  function setSelectedImagePromptPresetId(value) {
    const preset = getImagePromptPreset(value)
    const nextValue = preset ? preset.id : ''
    try {
      if (nextValue) localStorage.setItem(IMAGE_PROMPT_PRESET_STORAGE_KEY, nextValue)
      else localStorage.removeItem(IMAGE_PROMPT_PRESET_STORAGE_KEY)
      localStorage.removeItem(LEGACY_IMAGE_PROMPT_PRESET_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    updateImagePromptPresetControls()
    applyImagePromptPresetUnlockToPromptFields(document)
    unlockImagePromptPresetGenerateButtons(document)
  }

  function isStoryCanvasGenerateImageUrl(value) {
    const raw = String(value || '')
    if (!raw) return false
    try {
      return new URL(raw, window.location.href).pathname === '/agent/story-canvas/generate-image'
    } catch {
      return raw.includes('/agent/story-canvas/generate-image')
    }
  }

  function applyImagePromptPresetText(prompt, presetId) {
    const cleanPrompt = normalizePromptInputText(prompt)
    const preset = getImagePromptPreset(presetId)
    if (!preset) return cleanPrompt
    if (cleanPrompt.startsWith(preset.prompt)) return cleanPrompt
    return preset.prompt + cleanPrompt
  }

  function normalizePromptInputText(value) {
    return String(value || '').replace(IMAGE_PROMPT_PRESET_UNLOCK_RE, '').trim()
  }

  function applyImagePromptPresetToPayload(payload, requestUrl) {
    if (!payload || typeof payload !== 'object' || !isStoryCanvasGenerateImageUrl(requestUrl)) return false
    const preset = getImagePromptPreset(payload.promptPresetId || payload.promptPreset || payload.presetId || selectedImagePromptPresetId())
    if (!preset) return false
    const beforePrompt = payload.prompt
    const beforePresetId = payload.promptPresetId
    const beforePresetLabel = payload.promptPresetLabel
    const nextPrompt = applyImagePromptPresetText(beforePrompt, preset.id)
    payload.prompt = nextPrompt
    payload.promptPresetId = preset.id
    payload.promptPresetLabel = preset.label
    return beforePrompt !== nextPrompt || beforePresetId !== preset.id || beforePresetLabel !== preset.label
  }

  function isLocalUploadUrl(value) {
    const raw = String(value || '')
    if (!raw) return false
    try {
      return new URL(raw, window.location.href).pathname.startsWith('/dify/')
    } catch {
      return raw.startsWith('/dify/') || raw.includes('/dify/')
    }
  }

  function enqueueLocalUpload(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        localUploadActiveCount += 1
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            localUploadActiveCount = Math.max(0, localUploadActiveCount - 1)
            const next = localUploadQueue.shift()
            if (next) next()
          })
      }
      if (localUploadActiveCount < MAX_LOCAL_UPLOAD_REQUESTS) run()
      else localUploadQueue.push(run)
    })
  }

  function sendWithLocalUploadQueue(xhr, body, sender) {
    const url = xhr.__wangUrl || ''
    if (!isLocalUploadUrl(url)) return sender(body)
    enqueueLocalUpload(() => new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        xhr.removeEventListener('loadend', release)
        xhr.removeEventListener('error', release)
        xhr.removeEventListener('abort', release)
        xhr.removeEventListener('timeout', release)
      }
      const release = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      xhr.addEventListener('loadend', release)
      xhr.addEventListener('error', release)
      xhr.addEventListener('abort', release)
      xhr.addEventListener('timeout', release)
      try {
        sender(body)
      } catch (err) {
        cleanup()
        reject(err)
      }
    })).catch(err => {
      console.warn('[Upload] local queue send failed:', err?.message || err)
    })
    return undefined
  }

  function hasDataImage(value, seen = new WeakSet()) {
    if (typeof value === 'string') return value.startsWith(DATA_IMAGE_PREFIX) && value.includes(';base64,')
    if (!value || typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.some(item => hasDataImage(item, seen))
    return Object.keys(value).some(key => hasDataImage(value[key], seen))
  }

  async function dataUrlToLocalUrl(dataUrl) {
    if (dataImageCache.has(dataUrl)) return dataImageCache.get(dataUrl)
    if (!nativeFetch) return dataUrl
    const promise = nativeFetch('/agent/upload-data-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl })
    })
      .then(r => r.json())
      .then(resp => {
        const localUrl = resp?.data?.url || resp?.url
        if (!localUrl) throw new Error(resp?.message || 'data url upload failed')
        return localUrl
      })
    dataImageCache.set(dataUrl, promise)
    return promise
  }

  async function replaceDataImages(value, seen = new WeakSet()) {
    if (typeof value === 'string') {
      if (value.startsWith(DATA_IMAGE_PREFIX) && value.includes(';base64,')) {
        return dataUrlToLocalUrl(value)
      }
      return value
    }
    if (!value || typeof value !== 'object') return value
    if (seen.has(value)) return value
    seen.add(value)
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        value[i] = await replaceDataImages(value[i], seen)
      }
      return value
    }
    for (const key of Object.keys(value)) {
      value[key] = await replaceDataImages(value[key], seen)
    }
    return value
  }

  window.__wangHasDataImage = hasDataImage
  window.__wangCleanInlineImages = replaceDataImages

  async function cleanJsonBody(body, requestUrl = '') {
    const shouldApplyPreset = isStoryCanvasGenerateImageUrl(requestUrl)
    if (!body || typeof body !== 'string' || (!shouldApplyPreset && !body.includes(DATA_IMAGE_PREFIX))) return body
    try {
      const json = JSON.parse(body)
      let changed = applyImagePromptPresetToPayload(json, requestUrl)
      if (hasDataImage(json)) {
        await replaceDataImages(json)
        changed = true
      }
      return changed ? JSON.stringify(json) : body
    } catch {
      return body
    }
  }

  function requestUrlOf(input) {
    return typeof input === 'string' ? input : input?.url || ''
  }

  function shouldSkipCleanup(url) {
    if (!url) return false
    return url.includes('/agent/upload-data-url') ||
      url.includes('/dify/') ||
      url.includes('/generated/') ||
      url.includes('x-oss-process=')
  }

  function isJsonContentType(contentType) {
    return String(contentType || '').toLowerCase().includes('application/json')
  }

  function installDataUrlRequestCleanup() {
    const originalFetch = window.fetch
    if (typeof originalFetch === 'function') {
      window.fetch = async function patchedFetch(input, init) {
        const requestUrl = requestUrlOf(input)
        const runFetch = () => originalFetch.call(this, input, init)
        if (shouldSkipCleanup(requestUrl)) {
          return isLocalUploadUrl(requestUrl) ? enqueueLocalUpload(runFetch) : runFetch()
        }
        const initContentType = init?.headers instanceof Headers
          ? init.headers.get('content-type')
          : init?.headers && (init.headers['Content-Type'] || init.headers['content-type'])
        if (init && typeof init.body === 'string' && isJsonContentType(initContentType)) {
          init = { ...init, body: await cleanJsonBody(init.body, requestUrl) }
        } else if (input instanceof Request) {
          const contentType = input.headers.get('content-type') || ''
          if (isJsonContentType(contentType)) {
            const body = await input.clone().text()
            const cleanBody = await cleanJsonBody(body, requestUrl)
            if (cleanBody !== body) {
              input = new Request(input, { body: cleanBody })
            }
          }
        }
        return isLocalUploadUrl(requestUrl) ? enqueueLocalUpload(runFetch) : runFetch()
      }
    }

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__wangMethod = method
      this.__wangUrl = requestUrlOf(url)
      this.__wangHeaders = {}
      return originalOpen.apply(this, arguments)
    }
    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      this.__wangHeaders = this.__wangHeaders || {}
      this.__wangHeaders[String(name).toLowerCase()] = String(value || '')
      return originalSetRequestHeader.apply(this, arguments)
    }
    XMLHttpRequest.prototype.send = function patchedSend(body) {
      if (this.__wangSkipDataUrlCleanup) {
        return sendWithLocalUploadQueue(this, body, finalBody => originalSend.call(this, finalBody))
      }
      const url = this.__wangUrl || ''
      const contentType = this.__wangHeaders?.['content-type'] || ''
      if (!shouldSkipCleanup(url) && isJsonContentType(contentType) && typeof body === 'string' && (body.includes(DATA_IMAGE_PREFIX) || isStoryCanvasGenerateImageUrl(url))) {
        cleanJsonBody(body, url).then(cleanBody => {
          sendWithLocalUploadQueue(this, cleanBody, finalBody => originalSend.call(this, finalBody))
        })
        return
      }
      return sendWithLocalUploadQueue(this, body, finalBody => originalSend.call(this, finalBody))
    }
  }

  function ensureImagePromptPresetStyles() {
    if (document.getElementById('wang-image-prompt-preset-style')) return
    const style = document.createElement('style')
    style.id = 'wang-image-prompt-preset-style'
    style.textContent = `
      .wang-image-prompt-preset {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 36px;
        padding: 6px;
        box-sizing: border-box;
        color: #e4e4e7;
        font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: rgba(20, 20, 24, 0.82);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }
      .wang-image-prompt-preset--inline {
        margin: 6px 0 8px;
        background: rgba(255, 255, 255, 0.03);
      }
      .wang-image-prompt-preset__label {
        flex: 0 0 auto;
        padding: 0 4px 0 6px;
        white-space: nowrap;
        color: rgba(228, 228, 231, 0.72);
        font-size: 12px;
        font-weight: 500;
      }
      .wang-image-prompt-preset__options {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .wang-image-prompt-preset__option {
        height: 28px;
        min-width: 44px;
        padding: 0 12px;
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 8px;
        color: #a1a1aa;
        background: rgba(255, 255, 255, 0.03);
        font: 500 12px/26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
      }
      .wang-image-prompt-preset__option:hover {
        color: #e4e4e7;
        border-color: rgba(255, 255, 255, 0.16);
        background: rgba(255, 255, 255, 0.07);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
      }
      .wang-image-prompt-preset__option:active {
        transform: scale(0.98);
      }
      .wang-image-prompt-preset__option.is-active {
        color: #c7d2fe;
        border-color: rgba(129, 140, 248, 0.48);
        background: rgba(99, 102, 241, 0.1);
        box-shadow: 0 0 12px rgba(99, 102, 241, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.02);
      }
      @media (max-width: 720px) {
        .wang-image-prompt-preset__option {
          min-width: 36px;
          padding: 0 8px;
        }
      }
    `
    document.head.appendChild(style)
  }

  function createImagePromptPresetControl(mode = 'inline') {
    const control = document.createElement('div')
    control.className = `wang-image-prompt-preset wang-image-prompt-preset--${mode}`
    control.dataset.wangImagePromptPreset = 'true'
    if (mode === 'inline') control.dataset.wangImagePromptPresetInline = 'true'
    const label = document.createElement('span')
    label.className = 'wang-image-prompt-preset__label'
    label.textContent = '预设提示词'
    const options = document.createElement('div')
    options.className = 'wang-image-prompt-preset__options'
    const none = document.createElement('button')
    none.type = 'button'
    none.className = 'wang-image-prompt-preset__option'
    none.dataset.wangImagePresetOption = ''
    none.textContent = '无'
    const threeView = document.createElement('button')
    threeView.type = 'button'
    threeView.className = 'wang-image-prompt-preset__option'
    threeView.dataset.wangImagePresetOption = 'character_three_view'
    threeView.textContent = '人物三视图'
    options.append(none, threeView)
    control.append(label, options)
    updateImagePromptPresetControl(control)
    return control
  }

  function updateImagePromptPresetControl(control) {
    const selected = selectedImagePromptPresetId()
    control.querySelectorAll('[data-wang-image-preset-option]').forEach(button => {
      const active = String(button.dataset.wangImagePresetOption || '') === selected
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    })
  }

  function updateImagePromptPresetControls() {
    document.querySelectorAll('[data-wang-image-prompt-preset]').forEach(updateImagePromptPresetControl)
  }

  function compactUiText(el) {
    return String(el?.textContent || '').replace(/\s+/g, '').trim()
  }

  function relaxedUiText(el) {
    return String(el?.textContent || '').replace(/\s+/g, '')
  }

  function promptFieldHint(el) {
    return [
      el.getAttribute?.('placeholder'),
      el.getAttribute?.('data-placeholder'),
      el.getAttribute?.('aria-label'),
      el.id,
      el.name,
      el.className,
    ].map(value => String(value || '')).join(' ')
  }

  function isPromptInput(el) {
    if (!el || el.nodeType !== 1) return false
    const tag = String(el.tagName || '').toLowerCase()
    if (tag === 'input') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase()
      if (!['text', 'search', ''].includes(type)) return false
    } else if (tag !== 'textarea' && el.getAttribute('contenteditable') !== 'true') {
      return false
    }
    return /提示词|prompt|描述|画面|内容/i.test(promptFieldHint(el))
  }

  function promptFieldText(field) {
    if (!field) return ''
    if (field.getAttribute?.('contenteditable') === 'true') return field.textContent || ''
    return field.value || ''
  }

  function setPromptFieldText(field, value) {
    if (!field) return
    if (field.getAttribute?.('contenteditable') === 'true') {
      field.textContent = value
    } else {
      const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
      if (descriptor?.set) descriptor.set.call(field, value)
      else field.value = value
    }
  }

  function dispatchPromptFieldInput(field) {
    try {
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '' }))
    } catch {
      field.dispatchEvent(new Event('input', { bubbles: true }))
    }
    field.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function isImageGenerationPromptField(field) {
    return isPromptInput(field) && !!findImageGenerationPanel(field)
  }

  function isImageGenerationPanelText(text) {
    if (!text) return false
    return /图片生成|图像生成|生成图片|AI图像|图片节点/i.test(text)
  }

  function isImageGenerationNode(node) {
    if (!node || node.nodeType !== 1) return false
    const className = String(node.className || '')
    if (/\bvue-flow__node-(text|video|audio)\b/.test(className)) return false
    if (/\bvue-flow__node-image\b/.test(className)) return true

    const text = compactUiText(node)
    if (/文本生成|视频生成|音频生成|语音|声音|文案|文本节点|视频节点/i.test(text)) return false
    return isImageGenerationPanelText(text)
  }

  function applyImagePromptPresetUnlockToPromptFields(root = document) {
    if (!root.querySelectorAll && !root.matches) return
    const selectedPreset = getImagePromptPreset(selectedImagePromptPresetId())
    const fields = []
    if (root.matches?.('textarea, input, [contenteditable="true"]')) fields.push(root)
    root.querySelectorAll?.('textarea, input, [contenteditable="true"]').forEach(el => fields.push(el))
    fields.forEach(field => {
      if (!isImageGenerationPromptField(field)) return
      const rawText = promptFieldText(field)
      const normalizedText = normalizePromptInputText(rawText)
      if (selectedPreset) {
        if (!normalizedText && rawText !== IMAGE_PROMPT_PRESET_UNLOCK_TEXT) {
          setPromptFieldText(field, IMAGE_PROMPT_PRESET_UNLOCK_TEXT)
          dispatchPromptFieldInput(field)
        }
        return
      }
      if (IMAGE_PROMPT_PRESET_UNLOCK_RE.test(String(rawText || ''))) {
        IMAGE_PROMPT_PRESET_UNLOCK_RE.lastIndex = 0
        setPromptFieldText(field, String(rawText || '').replace(IMAGE_PROMPT_PRESET_UNLOCK_RE, ''))
        dispatchPromptFieldInput(field)
      }
    })
  }

  function findImageGenerationPanel(el) {
    const nearestNode = el?.closest?.('.vue-flow__node')
    if (nearestNode) return isImageGenerationNode(nearestNode) ? nearestNode : null

    let current = el
    for (let depth = 0; current && current !== document.body && depth < 16; depth += 1) {
      const text = compactUiText(current)
      if (current.classList?.contains('vue-flow__node')) {
        return isImageGenerationNode(current) ? current : null
      }
      if (
        current.matches?.('.ai-node-wrapper, .ai-node, .node-generation') &&
        text.length > 0 &&
        text.length < 4000 &&
        isImageGenerationPanelText(text) &&
        /提示词|prompt|描述|画面|内容|生成/i.test(text)
      ) {
        return current
      }
      current = current.parentElement
    }
    return null
  }

  function isGenerateButton(el) {
    if (!el || el.nodeType !== 1) return false
    const tag = String(el.tagName || '').toLowerCase()
    const role = String(el.getAttribute?.('role') || '').toLowerCase()
    if (tag !== 'button' && role !== 'button') return false
    const text = relaxedUiText(el)
    if (!text) return false
    if (/生成中|加载中|上传中/.test(text)) return false
    return /^(生成|开始生成|立即生成|重新生成)$/.test(text) || /开始.*生成|立即.*生成/.test(text)
  }

  function setElementDisabledState(el, disabled) {
    if (!el) return
    if (disabled) {
      el.setAttribute('disabled', 'disabled')
      el.setAttribute('aria-disabled', 'true')
      return
    }
    el.removeAttribute('disabled')
    el.setAttribute('aria-disabled', 'false')
    el.classList?.remove('is-disabled', 'disabled', 'ant-btn-disabled', 'el-button--disabled')
    el.style.pointerEvents = 'auto'
    el.style.cursor = 'pointer'
  }

  function unlockImagePromptPresetGenerateButtons(root = document) {
    if (!root.querySelectorAll && !root.matches) return
    const selectedPreset = getImagePromptPreset(selectedImagePromptPresetId())
    const buttons = []
    if (root.matches?.('button, [role="button"]')) buttons.push(root)
    root.querySelectorAll?.('button, [role="button"]').forEach(button => buttons.push(button))
    buttons.forEach(button => {
      if (!isGenerateButton(button)) return
      const panel = findImageGenerationPanel(button)
      if (!panel) return
      if (selectedPreset) {
        button.dataset.wangPromptPresetUnlocked = 'true'
        setElementDisabledState(button, false)
      } else if (button.dataset.wangPromptPresetUnlocked === 'true') {
        delete button.dataset.wangPromptPresetUnlocked
        button.style.pointerEvents = ''
        button.style.cursor = ''
      }
    })
  }

  function promptControlAnchor(field) {
    return field.closest?.('.el-form-item, .ant-form-item, .form-item, .setting-item, .input-section, .prompt-section, .mention-input-container') || field.parentElement
  }

  function removeInvalidInlineImagePromptPresetControls(root = document) {
    if (!root.querySelectorAll && !root.matches) return
    const controls = []
    if (root.matches?.('[data-wang-image-prompt-preset-inline="true"]')) controls.push(root)
    root.querySelectorAll?.('[data-wang-image-prompt-preset-inline="true"]').forEach(el => controls.push(el))
    controls.forEach(control => {
      if (!findImageGenerationPanel(control)) control.remove()
    })
  }

  function injectInlineImagePromptPresetControls(root = document) {
    if (!root.querySelectorAll && !root.matches) return
    removeInvalidInlineImagePromptPresetControls(root)
    const fields = []
    if (root.matches?.('textarea, input, [contenteditable="true"]')) fields.push(root)
    root.querySelectorAll?.('textarea, input, [contenteditable="true"]').forEach(el => fields.push(el))
    fields.forEach(field => {
      if (!isPromptInput(field)) return
      const panel = findImageGenerationPanel(field)
      if (!panel || panel.querySelector('[data-wang-image-prompt-preset-inline="true"]')) return
      const anchor = promptControlAnchor(field)
      if (!anchor?.parentElement) return
      ensureImagePromptPresetStyles()
      anchor.parentElement.insertBefore(createImagePromptPresetControl('inline'), anchor)
    })
  }

  function removeLegacyFloatingImagePromptPresetControls(root = document) {
    if (!root.querySelectorAll && !root.matches) return
    const controls = []
    if (root.matches?.('[data-wang-image-prompt-preset-floating="true"], .wang-image-prompt-preset--floating')) controls.push(root)
    root.querySelectorAll?.('[data-wang-image-prompt-preset-floating="true"], .wang-image-prompt-preset--floating').forEach(el => controls.push(el))
    controls.forEach(el => el.remove())
  }

  function ensureImageColorPaletteRemovalStyles() {
    if (document.getElementById('wang-hide-image-color-palette-style')) return
    const style = document.createElement('style')
    style.id = 'wang-hide-image-color-palette-style'
    style.textContent = `
      .color-palette-panel,
      .btn-palette-preview {
        display: none !important;
      }
      .vue-flow__node-image button:has(.btn-palette-preview),
      .vue-flow__node-image [role="button"]:has(.btn-palette-preview),
      .vue-flow__node-image .toolbar-btns-row > *:has(.btn-palette-preview) {
        display: none !important;
      }
    `
    document.head.appendChild(style)
  }

  function imagePaletteControlTarget(el) {
    return el?.closest?.('button, [role="button"], .toolbar-btn, .setting-item, .color-palette-trigger') || el
  }

  function isImageColorPaletteControl(el) {
    if (!el || el.nodeType !== 1) return false
    const className = String(el.className || '')
    const text = [
      relaxedUiText(el),
      el.getAttribute?.('title'),
      el.getAttribute?.('aria-label'),
      className,
    ].map(value => String(value || '')).join(' ')
    if (!/调色盘|调色板|color[-_ ]?palette|palette/i.test(text)) return false
    if (/预设提示词|人物三视图/.test(text)) return false
    const node = el.closest?.('.vue-flow__node')
    if (node) return isImageGenerationNode(node)
    return /btn-palette-preview|color[-_ ]?palette|colorpalette|palette/i.test(className)
  }

  function removeImageColorPaletteUi(root = document) {
    if (!root.querySelectorAll && !root.matches) return
    ensureImageColorPaletteRemovalStyles()
    const targets = new Set()
    if (root.matches?.('.color-palette-panel')) targets.add(root)
    root.querySelectorAll?.('.color-palette-panel').forEach(el => targets.add(el))
    if (root.matches?.('.btn-palette-preview')) targets.add(imagePaletteControlTarget(root))
    root.querySelectorAll?.('.btn-palette-preview').forEach(el => targets.add(imagePaletteControlTarget(el)))

    const clickableSelector = 'button, [role="button"], .toolbar-btn, .setting-item, .color-palette-trigger'
    if (root.matches?.(clickableSelector) && isImageColorPaletteControl(root)) {
      targets.add(imagePaletteControlTarget(root))
    }
    root.querySelectorAll?.(clickableSelector).forEach(el => {
      if (isImageColorPaletteControl(el)) targets.add(imagePaletteControlTarget(el))
    })
    targets.forEach(el => el?.remove?.())
  }

  function installImagePromptPresetUi() {
    window.__wangImagePromptPresets = {
      presets: IMAGE_PROMPT_PRESETS,
      getSelected: selectedImagePromptPresetId,
      setSelected: setSelectedImagePromptPresetId,
      apply: applyImagePromptPresetText,
    }
    const start = () => {
      if (!document.body) return
      ensureImageColorPaletteRemovalStyles()
      removeLegacyFloatingImagePromptPresetControls(document)
      removeImageColorPaletteUi(document)
      injectInlineImagePromptPresetControls(document)
      applyImagePromptPresetUnlockToPromptFields(document)
      unlockImagePromptPresetGenerateButtons(document)
      document.addEventListener('mousedown', event => {
        const button = event.target?.closest?.('[data-wang-image-preset-option]')
        if (!button) return
        event.preventDefault()
        event.stopPropagation()
      }, true)
      document.addEventListener('click', event => {
        const button = event.target?.closest?.('[data-wang-image-preset-option]')
        if (!button) return
        event.preventDefault()
        event.stopPropagation()
        setSelectedImagePromptPresetId(button.dataset.wangImagePresetOption || '')
      }, true)
      window.addEventListener('storage', event => {
        if (event.key === IMAGE_PROMPT_PRESET_STORAGE_KEY || event.key === LEGACY_IMAGE_PROMPT_PRESET_STORAGE_KEY) {
          updateImagePromptPresetControls()
          applyImagePromptPresetUnlockToPromptFields(document)
          unlockImagePromptPresetGenerateButtons(document)
        }
      })
      document.addEventListener('input', event => {
        const field = event.target
        if (!isImageGenerationPromptField(field)) return
        setTimeout(() => applyImagePromptPresetUnlockToPromptFields(field), 0)
        setTimeout(() => unlockImagePromptPresetGenerateButtons(document), 0)
      }, true)
      const pendingRoots = new Set()
      let scheduled = false
      const schedule = root => {
        if (root) pendingRoots.add(root)
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          removeLegacyFloatingImagePromptPresetControls(document)
          removeImageColorPaletteUi(document)
          removeInvalidInlineImagePromptPresetControls(document)
          if (pendingRoots.size === 0) injectInlineImagePromptPresetControls(document)
          else {
            const roots = Array.from(pendingRoots)
            pendingRoots.clear()
            roots.forEach(item => {
              removeImageColorPaletteUi(item)
              injectInlineImagePromptPresetControls(item)
            })
          }
          updateImagePromptPresetControls()
          applyImagePromptPresetUnlockToPromptFields(document)
          unlockImagePromptPresetGenerateButtons(document)
        })
      }
      const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) schedule(node)
          })
        })
      })
      observer.observe(document.body, { childList: true, subtree: true })
      setInterval(() => schedule(document), 800)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
    else start()
  }

  installDataUrlRequestCleanup()
  installImagePromptPresetUi()

  let fullscreenPreviewOverlay = null
  let fullscreenPreviewEscHandler = null
  let previousBodyOverflow = ''
  let nativeFullscreenImagePreview = null
  let nativeFullscreenFallbackTimer = null

  function ensureFullscreenPreviewStyles() {
    if (document.getElementById('wang-local-image-preview-style')) return
    const style = document.createElement('style')
    style.id = 'wang-local-image-preview-style'
    style.textContent = `
      .wang-local-image-preview {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        width: 100vw;
        height: 100vh;
        display: block;
        box-sizing: border-box;
        color: #fff;
        background: rgba(0, 0, 0, 0.9);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        user-select: none;
      }
      .wang-local-image-preview__stage {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        cursor: default;
      }
      .wang-local-image-preview__stage.is-draggable {
        cursor: grab;
      }
      .wang-local-image-preview__stage.is-dragging {
        cursor: grabbing;
      }
      .wang-local-image-preview__image {
        display: block;
        max-width: calc(100vw - 48px);
        max-height: calc(100vh - 64px);
        object-fit: contain;
        border-radius: 8px;
        background: transparent;
        transform-origin: center center;
        will-change: transform;
        transition: transform 0.16s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.18s ease;
      }
      .wang-local-image-preview__image.is-loading {
        opacity: 0;
      }
      .wang-local-image-preview__toolbar,
      .wang-local-image-preview__title,
      .wang-local-image-preview__actions {
        position: absolute;
        top: 12px;
        z-index: 10;
        display: flex;
        align-items: center;
        gap: 4px;
        background: rgba(30, 30, 30, 0.85);
        padding: 6px 12px;
        border-radius: 20px;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 1px 12px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.05);
      }
      .wang-local-image-preview__toolbar {
        left: 50%;
        transform: translateX(-50%);
      }
      .wang-local-image-preview__title {
        left: 16px;
        max-width: min(360px, calc(100vw - 420px));
        min-height: 28px;
        color: rgba(255, 255, 255, 0.78);
        font: 500 12px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .wang-local-image-preview__actions {
        right: 16px;
      }
      .wang-local-image-preview__button {
        position: relative;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        background: rgba(255, 255, 255, 0.15);
        cursor: pointer;
        transition: background 0.16s ease, transform 0.16s ease, color 0.16s ease;
        text-decoration: none;
        flex: 0 0 auto;
      }
      .wang-local-image-preview__button:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.25);
        transform: scale(1.08);
      }
      .wang-local-image-preview__button:active {
        transform: scale(0.95);
      }
      .wang-local-image-preview__button svg {
        width: 15px;
        height: 15px;
        display: block;
      }
      .wang-local-image-preview__zoom-text {
        min-width: 44px;
        padding: 0 4px;
        color: rgba(255, 255, 255, 0.9);
        text-align: center;
        font: 600 12px/28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wang-local-image-preview__divider {
        width: 1px;
        height: 16px;
        margin: 0 2px;
        background: rgba(255, 255, 255, 0.25);
      }
      .wang-local-image-preview__message {
        position: absolute;
        left: 50%;
        top: 50%;
        z-index: 5;
        transform: translate(-50%, -50%);
        color: rgba(255, 255, 255, 0.68);
        font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: nowrap;
        pointer-events: none;
      }
      .wang-local-image-preview__spinner {
        width: 40px;
        height: 40px;
        margin: 0 auto 12px;
        border: 3px solid rgba(255, 255, 255, 0.15);
        border-top-color: rgba(255, 255, 255, 0.85);
        border-radius: 50%;
        animation: wang-local-image-preview-spin 0.7s linear infinite;
      }
      .wang-local-image-preview__message.is-hidden {
        display: none;
      }
      @keyframes wang-local-image-preview-spin {
        to { transform: rotate(360deg); }
      }
      @media (max-width: 760px) {
        .wang-local-image-preview__title {
          display: none;
        }
        .wang-local-image-preview__toolbar {
          top: auto;
          left: 50%;
          bottom: 18px;
        }
        .wang-local-image-preview__actions {
          top: 12px;
          right: 12px;
        }
        .wang-local-image-preview__image {
          max-width: calc(100vw - 24px);
          max-height: calc(100vh - 112px);
        }
      }
    `
    document.head.appendChild(style)
  }

  function fullscreenPreviewIcon(name) {
    const icons = {
      zoomOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M8 11h6"></path><path d="M16.5 16.5 21 21"></path></svg>',
      zoomIn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M11 8v6"></path><path d="M8 11h6"></path><path d="M16.5 16.5 21 21"></path></svg>',
      reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path></svg>',
      download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path></svg>',
      maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>',
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
    }
    return icons[name] || ''
  }

  function createFullscreenPreviewButton(label, iconName, tagName = 'button') {
    const button = document.createElement(tagName)
    if (tagName === 'button') button.type = 'button'
    button.className = 'wang-local-image-preview__button'
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML = fullscreenPreviewIcon(iconName)
    return button
  }

  function nativeFullscreenPreviewVisible() {
    return Array.from(document.querySelectorAll('.image-viewer, .viewer-backdrop, .el-image-viewer__wrapper')).some(el => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    })
  }

  function closeLocalFullscreenImagePreview() {
    if (nativeFullscreenFallbackTimer) {
      clearTimeout(nativeFullscreenFallbackTimer)
      nativeFullscreenFallbackTimer = null
    }
    if (fullscreenPreviewEscHandler) {
      document.removeEventListener('keydown', fullscreenPreviewEscHandler)
      fullscreenPreviewEscHandler = null
    }
    if (fullscreenPreviewOverlay) {
      fullscreenPreviewOverlay.remove()
      fullscreenPreviewOverlay = null
    }
    document.body.style.overflow = previousBodyOverflow
  }

  async function normalizePreviewImageUrl(imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') return ''
    if (imageUrl.startsWith(DATA_IMAGE_PREFIX) && imageUrl.includes(';base64,')) {
      try {
        return await dataUrlToLocalUrl(imageUrl)
      } catch {
        return imageUrl
      }
    }
    try {
      return new URL(imageUrl, window.location.href).href
    } catch {
      return imageUrl
    }
  }

  async function openLocalFullscreenImagePreview(imageUrl, title = '') {
    closeLocalFullscreenImagePreview()
    ensureFullscreenPreviewStyles()

    let scale = 1
    let translateX = 0
    let translateY = 0
    let dragStartX = 0
    let dragStartY = 0
    let dragOriginX = 0
    let dragOriginY = 0
    let isDragging = false

    const overlay = document.createElement('div')
    overlay.className = 'wang-local-image-preview'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')

    const titleEl = document.createElement('div')
    titleEl.className = 'wang-local-image-preview__title'
    titleEl.textContent = title || '图片预览'

    const toolbar = document.createElement('div')
    toolbar.className = 'wang-local-image-preview__toolbar'
    const zoomOut = createFullscreenPreviewButton('缩小', 'zoomOut')
    const zoomIn = createFullscreenPreviewButton('放大', 'zoomIn')
    const reset = createFullscreenPreviewButton('复位', 'reset')
    const zoomText = document.createElement('span')
    zoomText.className = 'wang-local-image-preview__zoom-text'
    const divider = document.createElement('span')
    divider.className = 'wang-local-image-preview__divider'
    toolbar.append(zoomOut, zoomText, zoomIn, divider, reset)

    const actions = document.createElement('div')
    actions.className = 'wang-local-image-preview__actions'

    const download = createFullscreenPreviewButton('下载', 'download', 'a')
    download.target = '_blank'
    download.rel = 'noopener'

    const close = createFullscreenPreviewButton('关闭', 'close')
    close.addEventListener('click', closeLocalFullscreenImagePreview)

    actions.append(download, close)

    const stage = document.createElement('div')
    stage.className = 'wang-local-image-preview__stage'

    const message = document.createElement('div')
    message.className = 'wang-local-image-preview__message'
    message.innerHTML = '<div class="wang-local-image-preview__spinner"></div><span>加载中...</span>'

    const image = document.createElement('img')
    image.className = 'wang-local-image-preview__image is-loading'
    image.alt = title || '图片预览'
    image.draggable = false

    const clampScale = value => Math.min(6, Math.max(0.2, value))
    const applyTransform = () => {
      image.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`
      zoomText.textContent = `${Math.round(scale * 100)}%`
      stage.classList.toggle('is-draggable', scale > 1.01)
    }
    const setScale = (nextScale, anchorEvent) => {
      const previousScale = scale
      scale = clampScale(nextScale)
      if (scale <= 1.01) {
        scale = 1
        translateX = 0
        translateY = 0
      } else if (anchorEvent && previousScale > 0) {
        const rect = stage.getBoundingClientRect()
        const dx = anchorEvent.clientX - rect.left - rect.width / 2
        const dy = anchorEvent.clientY - rect.top - rect.height / 2
        const ratio = scale / previousScale
        translateX = translateX * ratio - dx * (ratio - 1)
        translateY = translateY * ratio - dy * (ratio - 1)
      }
      applyTransform()
    }
    const resetTransform = () => {
      scale = 1
      translateX = 0
      translateY = 0
      applyTransform()
    }

    zoomOut.addEventListener('click', event => {
      event.stopPropagation()
      setScale(scale / 1.25)
    })
    zoomIn.addEventListener('click', event => {
      event.stopPropagation()
      setScale(scale * 1.25)
    })
    reset.addEventListener('click', event => {
      event.stopPropagation()
      resetTransform()
    })
    stage.addEventListener('wheel', event => {
      event.preventDefault()
      event.stopPropagation()
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      setScale(scale * factor, event)
    }, { passive: false })
    stage.addEventListener('dblclick', event => {
      event.preventDefault()
      event.stopPropagation()
      if (scale === 1) setScale(2, event)
      else resetTransform()
    })
    stage.addEventListener('pointerdown', event => {
      if (scale <= 1.01 || event.button !== 0) return
      event.preventDefault()
      isDragging = true
      dragStartX = event.clientX
      dragStartY = event.clientY
      dragOriginX = translateX
      dragOriginY = translateY
      stage.classList.add('is-dragging')
      stage.setPointerCapture?.(event.pointerId)
    })
    stage.addEventListener('pointermove', event => {
      if (!isDragging) return
      translateX = dragOriginX + event.clientX - dragStartX
      translateY = dragOriginY + event.clientY - dragStartY
      applyTransform()
    })
    const stopDrag = event => {
      if (!isDragging) return
      isDragging = false
      stage.classList.remove('is-dragging')
      stage.releasePointerCapture?.(event.pointerId)
    }
    stage.addEventListener('pointerup', stopDrag)
    stage.addEventListener('pointercancel', stopDrag)

    image.addEventListener('click', event => event.stopPropagation())
    image.addEventListener('load', () => {
      image.classList.remove('is-loading')
      message.classList.add('is-hidden')
      resetTransform()
    })
    image.addEventListener('error', () => {
      image.classList.remove('is-loading')
      message.innerHTML = '<span>图片加载失败</span>'
      message.classList.remove('is-hidden')
    })

    stage.append(image, message)
    overlay.append(stage, titleEl, toolbar, actions)
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeLocalFullscreenImagePreview()
    })

    fullscreenPreviewEscHandler = event => {
      if (event.key === 'Escape') closeLocalFullscreenImagePreview()
      if ((event.metaKey || event.ctrlKey) && ['+', '=', '-'].includes(event.key)) {
        event.preventDefault()
        setScale(event.key === '-' ? scale / 1.25 : scale * 1.25)
      }
    }
    document.addEventListener('keydown', fullscreenPreviewEscHandler)

    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.appendChild(overlay)
    fullscreenPreviewOverlay = overlay
    applyTransform()

    const resolvedUrl = await normalizePreviewImageUrl(imageUrl)
    if (!resolvedUrl) {
      message.innerHTML = '<span>图片地址为空</span>'
      return
    }
    image.src = resolvedUrl
    download.href = resolvedUrl
  }

  function openFullscreenImagePreviewWithNativeFallback(imageUrl, title = '') {
    const nativePreview = nativeFullscreenImagePreview
    if (typeof nativePreview === 'function' && nativePreview !== openFullscreenImagePreviewWithNativeFallback && nativePreview !== openLocalFullscreenImagePreview) {
      try {
        closeLocalFullscreenImagePreview()
        const result = nativePreview(imageUrl, title)
        nativeFullscreenFallbackTimer = setTimeout(() => {
          nativeFullscreenFallbackTimer = null
          if (!nativeFullscreenPreviewVisible()) openLocalFullscreenImagePreview(imageUrl, title)
        }, 700)
        if (result && typeof result.catch === 'function') {
          result.catch(() => openLocalFullscreenImagePreview(imageUrl, title))
        }
        return result
      } catch {
        return openLocalFullscreenImagePreview(imageUrl, title)
      }
    }
    return openLocalFullscreenImagePreview(imageUrl, title)
  }

  window.__wangOpenFullscreenImagePreviewFallback = openLocalFullscreenImagePreview
  window.__wangCloseFullscreenImagePreviewFallback = closeLocalFullscreenImagePreview
  try {
    Object.defineProperty(window, 'openFullscreenImagePreview', {
      configurable: true,
      get() {
        return openFullscreenImagePreviewWithNativeFallback
      },
      set(fn) {
        if (typeof fn === 'function' && fn !== openLocalFullscreenImagePreview && fn !== openFullscreenImagePreviewWithNativeFallback) {
          nativeFullscreenImagePreview = fn
          window.__wangNativeFullscreenImagePreview = fn
        }
      }
    })
  } catch {
    window.openFullscreenImagePreview = openFullscreenImagePreviewWithNativeFallback
  }

  let videoPreviewOverlay = null
  let videoPreviewEscHandler = null
  let videoPreviewFullscreenChangeHandler = null
  let previousVideoBodyOverflow = ''
  let nativeVideoPreview = null
  let nativeVideoPreviewModal = null
  let nativeFullscreenVideoPreview = null
  let nativeVideoFallbackTimer = null

  function ensureVideoPreviewStyles() {
    if (document.getElementById('wang-local-video-preview-style')) return
    const style = document.createElement('style')
    style.id = 'wang-local-video-preview-style'
    style.textContent = `
      .wang-local-video-preview {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        width: 100vw;
        height: 100vh;
        color: #fff;
        background: rgba(0, 0, 0, 0.92);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        box-sizing: border-box;
      }
      .wang-local-video-preview__container {
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
      }
      .wang-local-video-preview__content {
        min-width: 0;
        min-height: 0;
        width: 100%;
        height: 100%;
        display: flex;
        background: #101010;
      }
      .wang-local-video-preview__video-section {
        position: relative;
        flex: 3 1 0;
        min-width: 0;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #000;
        overflow: hidden;
      }
      .wang-local-video-preview__video {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
        background: #000;
      }
      .wang-local-video-preview__info {
        flex: 0 0 min(380px, 32vw);
        min-width: 300px;
        max-width: 420px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        padding: 28px 24px;
        box-sizing: border-box;
        background: rgba(20, 20, 20, 0.94);
        border-left: 1px solid rgba(255, 255, 255, 0.08);
        overflow-y: auto;
      }
      .wang-local-video-preview__title {
        margin: 0;
        color: rgba(255, 255, 255, 0.92);
        font: 700 18px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        word-break: break-word;
      }
      .wang-local-video-preview__section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .wang-local-video-preview__label {
        color: rgba(255, 255, 255, 0.48);
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wang-local-video-preview__text {
        margin: 0;
        color: rgba(255, 255, 255, 0.78);
        font: 500 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        word-break: break-word;
        white-space: pre-wrap;
      }
      .wang-local-video-preview__meta {
        display: grid;
        gap: 8px;
      }
      .wang-local-video-preview__meta-row {
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 9px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .wang-local-video-preview__meta-row span:first-child {
        flex: 0 0 auto;
        color: rgba(255, 255, 255, 0.45);
        font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wang-local-video-preview__meta-row span:last-child {
        min-width: 0;
        color: rgba(255, 255, 255, 0.82);
        font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wang-local-video-preview__actions {
        position: absolute;
        top: 16px;
        right: 16px;
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .wang-local-video-preview__button {
        width: 36px;
        height: 36px;
        border: 0;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        background: rgba(30, 30, 30, 0.78);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
        cursor: pointer;
        transition: background 0.16s ease, transform 0.16s ease;
        text-decoration: none;
      }
      .wang-local-video-preview__button:hover {
        background: rgba(50, 50, 50, 0.9);
        transform: scale(1.06);
      }
      .wang-local-video-preview__button:active {
        transform: scale(0.95);
      }
      .wang-local-video-preview__button svg {
        width: 17px;
        height: 17px;
      }
      .wang-local-video-preview.is-video-expanded .wang-local-video-preview__content {
        background: #000;
      }
      .wang-local-video-preview.is-video-expanded .wang-local-video-preview__video-section {
        flex: 1 1 100%;
      }
      .wang-local-video-preview.is-video-expanded .wang-local-video-preview__info,
      .wang-local-video-preview.is-video-expanded .wang-local-video-preview__nav {
        display: none !important;
      }
      .wang-local-video-preview__message {
        position: absolute;
        left: 50%;
        top: 50%;
        z-index: 2;
        transform: translate(-50%, -50%);
        color: rgba(255, 255, 255, 0.68);
        font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: none;
      }
      .wang-local-video-preview__message.is-hidden {
        display: none;
      }
      .wang-local-video-preview__nav {
        position: absolute;
        left: 50%;
        bottom: 18px;
        z-index: 4;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-radius: 20px;
        color: rgba(255, 255, 255, 0.82);
        background: rgba(24, 24, 24, 0.76);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wang-local-video-preview__nav button {
        width: 26px;
        height: 26px;
        border: 0;
        border-radius: 50%;
        color: #fff;
        background: rgba(255, 255, 255, 0.16);
        cursor: pointer;
      }
      .wang-local-video-preview__nav button:disabled {
        opacity: 0.35;
        cursor: default;
      }
      @media (max-width: 760px) {
        .wang-local-video-preview__content {
          flex-direction: column;
        }
        .wang-local-video-preview__video-section {
          flex: 1 1 auto;
          min-height: 52vh;
        }
        .wang-local-video-preview__info {
          flex: 0 0 auto;
          width: 100%;
          max-width: none;
          min-width: 0;
          max-height: 38vh;
          padding: 18px 16px 22px;
          border-left: 0;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        .wang-local-video-preview__actions {
          top: 12px;
          right: 12px;
        }
      }
    `
    document.head.appendChild(style)
  }

  function createVideoPreviewButton(label, iconName, tagName = 'button') {
    const button = document.createElement(tagName)
    if (tagName === 'button') button.type = 'button'
    button.className = 'wang-local-video-preview__button'
    button.title = label
    button.setAttribute('aria-label', label)
    button.innerHTML = fullscreenPreviewIcon(iconName)
    return button
  }

  function normalizePreviewVideoUrl(videoUrl) {
    if (!videoUrl || typeof videoUrl !== 'string') return ''
    try {
      return new URL(videoUrl, window.location.href).href
    } catch {
      return videoUrl
    }
  }

  function getVideoNameFromUrl(url) {
    if (!url) return ''
    try {
      return decodeURIComponent(new URL(url, window.location.href).pathname.split('/').pop() || '')
    } catch {
      return String(url).split('/').pop() || ''
    }
  }

  function pickVideoPreviewEntry(payload) {
    if (payload && typeof payload === 'object' && Array.isArray(payload.videos) && payload.videos.length > 0) {
      const index = Math.min(Math.max(Number(payload.index) || 0, 0), payload.videos.length - 1)
      const entry = payload.videos[index] || {}
      return { entry, index, videos: payload.videos }
    }
    return { entry: payload && typeof payload === 'object' ? payload : null, index: 0, videos: [] }
  }

  function buildVideoPreviewState(source, prompt = '', options = {}) {
    const { entry, index, videos } = pickVideoPreviewEntry(source)
    const data = entry || {}
    const info = data.info || source?.info || {}
    const url = normalizePreviewVideoUrl(
      typeof source === 'string'
        ? source
        : data.url || data.videoUrl || data.src || source?.url || source?.videoUrl || source?.src || ''
    )
    const resolvedPrompt = String(
      info.prompt || source?.prompt || data.prompt || prompt || ''
    ).trim()
    const title = String(
      options.title || info.title || source?.title || data.title || getVideoNameFromUrl(url) || '视频预览'
    ).trim()
    const meta = [
      ['模型', info.model || options.model || source?.model],
      ['类型', info.type || options.type || source?.type],
      ['参数', info.settings || options.resolution || source?.resolution],
      ['时间', info.createdAt || options.createdAt || source?.createdAt],
    ].filter(item => item[1])
    const startTime = Number(options.startTime ?? info.startTime ?? source?.startTime ?? data.startTime ?? 0)
    return { url, title, prompt: resolvedPrompt, meta, videos, index, startTime: Number.isFinite(startTime) ? startTime : 0 }
  }

  function nativeVideoPreviewVisible() {
    const selectors = [
      '.video-viewer',
      '.video-preview-viewer',
      '.video-preview-modal',
      '.video-preview-modal-overlay',
      '.creation-video-viewer',
      '.video-detail-dialog'
    ].join(',')
    return Array.from(document.querySelectorAll(selectors)).some(el => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    })
  }

  function currentPreviewFullscreenElement() {
    return document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null
  }

  function requestPreviewFullscreen(primaryEl, fallbackEl) {
    const candidates = [primaryEl, fallbackEl].filter(Boolean)
    for (const el of candidates) {
      const request = el.requestFullscreen ||
        el.webkitRequestFullscreen ||
        el.webkitRequestFullScreen ||
        el.mozRequestFullScreen ||
        el.msRequestFullscreen
      if (typeof request === 'function') {
        try {
          const result = request.call(el)
          return result && typeof result.catch === 'function' ? result : Promise.resolve()
        } catch {
          /* try the next fullscreen API */
        }
      }
    }
    if (primaryEl && typeof primaryEl.webkitEnterFullscreen === 'function') {
      try {
        primaryEl.webkitEnterFullscreen()
        return Promise.resolve()
      } catch {
        /* ignore */
      }
    }
    return Promise.reject(new Error('Fullscreen API is not available'))
  }

  function exitPreviewFullscreen(video) {
    if (video && typeof video.webkitExitFullscreen === 'function' && video.webkitDisplayingFullscreen) {
      try {
        video.webkitExitFullscreen()
        return Promise.resolve()
      } catch {
        /* fall through */
      }
    }
    const exit = document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.webkitCancelFullScreen ||
      document.mozCancelFullScreen ||
      document.msExitFullscreen
    if (typeof exit === 'function') {
      try {
        const result = exit.call(document)
        return result && typeof result.catch === 'function' ? result : Promise.resolve()
      } catch {
        /* ignore */
      }
    }
    return Promise.resolve()
  }

  function closeLocalVideoPreview() {
    if (nativeVideoFallbackTimer) {
      clearTimeout(nativeVideoFallbackTimer)
      nativeVideoFallbackTimer = null
    }
    if (videoPreviewEscHandler) {
      document.removeEventListener('keydown', videoPreviewEscHandler)
      videoPreviewEscHandler = null
    }
    if (videoPreviewFullscreenChangeHandler) {
      document.removeEventListener('fullscreenchange', videoPreviewFullscreenChangeHandler)
      document.removeEventListener('webkitfullscreenchange', videoPreviewFullscreenChangeHandler)
      document.removeEventListener('mozfullscreenchange', videoPreviewFullscreenChangeHandler)
      document.removeEventListener('MSFullscreenChange', videoPreviewFullscreenChangeHandler)
      videoPreviewFullscreenChangeHandler = null
    }
    if (videoPreviewOverlay) {
      const video = videoPreviewOverlay.querySelector('video')
      const fullscreenElement = currentPreviewFullscreenElement()
      if (fullscreenElement && videoPreviewOverlay.contains(fullscreenElement)) {
        exitPreviewFullscreen(video).catch?.(() => {})
      }
      if (video) {
        try {
          video.pause()
          video.removeAttribute('src')
          video.load()
        } catch {
          /* ignore */
        }
      }
      videoPreviewOverlay.remove()
      videoPreviewOverlay = null
    }
    document.body.style.overflow = previousVideoBodyOverflow
  }

  function openLocalVideoPreview(source, prompt = '', options = {}) {
    closeLocalVideoPreview()
    ensureVideoPreviewStyles()

    let state = buildVideoPreviewState(source, prompt, options)
    const shouldOpenExpanded = Boolean(options.fullscreen || options.expanded || source?.fullscreen || source?.expanded)

    const overlay = document.createElement('div')
    overlay.className = 'wang-local-video-preview'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')

    const container = document.createElement('div')
    container.className = 'wang-local-video-preview__container'

    const content = document.createElement('div')
    content.className = 'wang-local-video-preview__content'

    const videoSection = document.createElement('div')
    videoSection.className = 'wang-local-video-preview__video-section'

    const message = document.createElement('div')
    message.className = 'wang-local-video-preview__message'
    message.textContent = '加载中...'

    const video = document.createElement('video')
    video.className = 'wang-local-video-preview__video'
    video.controls = true
    video.autoplay = true
    video.playsInline = true
    video.preload = 'auto'
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')

    const infoPanel = document.createElement('aside')
    infoPanel.className = 'wang-local-video-preview__info'

    const titleEl = document.createElement('h2')
    titleEl.className = 'wang-local-video-preview__title'

    const promptSection = document.createElement('div')
    promptSection.className = 'wang-local-video-preview__section'
    const promptLabel = document.createElement('div')
    promptLabel.className = 'wang-local-video-preview__label'
    promptLabel.textContent = '提示词'
    const promptText = document.createElement('p')
    promptText.className = 'wang-local-video-preview__text'
    promptSection.append(promptLabel, promptText)

    const metaSection = document.createElement('div')
    metaSection.className = 'wang-local-video-preview__meta'

    const actions = document.createElement('div')
    actions.className = 'wang-local-video-preview__actions'
    const fullscreen = createVideoPreviewButton('全屏播放', 'maximize')
    const download = createVideoPreviewButton('下载', 'download', 'a')
    download.target = '_blank'
    download.rel = 'noopener'
    const close = createVideoPreviewButton('关闭', 'close')
    actions.append(fullscreen, download, close)

    const nav = document.createElement('div')
    nav.className = 'wang-local-video-preview__nav'
    const prev = document.createElement('button')
    prev.type = 'button'
    prev.textContent = '‹'
    const counter = document.createElement('span')
    const next = document.createElement('button')
    next.type = 'button'
    next.textContent = '›'
    nav.append(prev, counter, next)

    function renderInfo() {
      titleEl.textContent = state.title || '视频预览'
      promptText.textContent = state.prompt || '无'
      promptSection.style.display = state.prompt ? '' : 'none'
      metaSection.innerHTML = ''
      state.meta.forEach(([label, value]) => {
        const row = document.createElement('div')
        row.className = 'wang-local-video-preview__meta-row'
        const labelEl = document.createElement('span')
        labelEl.textContent = label
        const valueEl = document.createElement('span')
        valueEl.textContent = value
        valueEl.title = value
        row.append(labelEl, valueEl)
        metaSection.appendChild(row)
      })
      const hasInfo = state.title || state.prompt || state.meta.length > 0
      infoPanel.style.display = hasInfo ? '' : 'none'
      if (state.videos.length > 1) {
        nav.style.display = ''
        counter.textContent = `${state.index + 1} / ${state.videos.length}`
        prev.disabled = state.index <= 0
        next.disabled = state.index >= state.videos.length - 1
      } else {
        nav.style.display = 'none'
      }
    }

    function loadVideo(nextState) {
      state = nextState
      renderInfo()
      message.textContent = state.url ? '加载中...' : '视频地址为空'
      message.classList.toggle('is-hidden', !!state.url)
      if (!state.url) {
        video.removeAttribute('src')
        download.removeAttribute('href')
        return
      }
      video.src = state.url
      download.href = state.url
      video.load()
      const applyStartTime = () => {
        const startTime = Number(state.startTime)
        if (!Number.isFinite(startTime) || startTime <= 0) return
        const duration = Number(video.duration)
        try {
          video.currentTime = Number.isFinite(duration) && duration > 0
            ? Math.min(startTime, Math.max(0, duration - 0.2))
            : startTime
        } catch {
          /* ignore */
        }
      }
      if (video.readyState >= 1) applyStartTime()
      else video.addEventListener('loadedmetadata', applyStartTime, { once: true })
      video.play().catch(() => {})
    }
    function setVideoExpanded(expanded) {
      overlay.classList.toggle('is-video-expanded', expanded)
      fullscreen.title = expanded ? '退出全屏' : '全屏播放'
      fullscreen.setAttribute('aria-label', expanded ? '退出全屏' : '全屏播放')
    }

    video.addEventListener('click', event => event.stopPropagation())
    video.addEventListener('loadeddata', () => message.classList.add('is-hidden'))
    video.addEventListener('canplay', () => message.classList.add('is-hidden'))
    video.addEventListener('error', () => {
      message.textContent = '视频加载失败'
      message.classList.remove('is-hidden')
    })

    fullscreen.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      const fullscreenElement = currentPreviewFullscreenElement()
      const isExpanded = overlay.classList.contains('is-video-expanded')
      if (isExpanded || (fullscreenElement && overlay.contains(fullscreenElement))) {
        setVideoExpanded(false)
        exitPreviewFullscreen(video).catch?.(() => {})
        return
      }
      setVideoExpanded(true)
      video.play().catch(() => {})
      requestPreviewFullscreen(video, overlay).catch(() => {
        setVideoExpanded(true)
      })
    })
    videoPreviewFullscreenChangeHandler = () => {
      if (!videoPreviewOverlay || videoPreviewOverlay !== overlay) return
      const fullscreenElement = currentPreviewFullscreenElement()
      if (!fullscreenElement && !video.webkitDisplayingFullscreen) setVideoExpanded(false)
    }
    document.addEventListener('fullscreenchange', videoPreviewFullscreenChangeHandler)
    document.addEventListener('webkitfullscreenchange', videoPreviewFullscreenChangeHandler)
    document.addEventListener('mozfullscreenchange', videoPreviewFullscreenChangeHandler)
    document.addEventListener('MSFullscreenChange', videoPreviewFullscreenChangeHandler)
    close.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      closeLocalVideoPreview()
    })
    prev.addEventListener('click', event => {
      event.stopPropagation()
      if (state.index <= 0) return
      const payload = { videos: state.videos, index: state.index - 1 }
      loadVideo(buildVideoPreviewState(payload, prompt, options))
    })
    next.addEventListener('click', event => {
      event.stopPropagation()
      if (state.index >= state.videos.length - 1) return
      const payload = { videos: state.videos, index: state.index + 1 }
      loadVideo(buildVideoPreviewState(payload, prompt, options))
    })

    videoSection.append(video, message)
    infoPanel.append(titleEl, promptSection, metaSection)
    content.append(videoSection, infoPanel)
    container.append(content, actions, nav)
    overlay.appendChild(container)
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeLocalVideoPreview()
    })

    videoPreviewEscHandler = event => {
      if (event.key === 'Escape') closeLocalVideoPreview()
    }
    document.addEventListener('keydown', videoPreviewEscHandler)

    previousVideoBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.appendChild(overlay)
    videoPreviewOverlay = overlay
    if (shouldOpenExpanded) setVideoExpanded(true)
    loadVideo(state)
  }

  function withNativeVideoFallback(nativeFn, fallbackFn, args) {
    if (typeof nativeFn === 'function' && nativeFn !== fallbackFn && nativeFn !== openLocalVideoPreview) {
      try {
        closeLocalVideoPreview()
        const result = nativeFn(...args)
        nativeVideoFallbackTimer = setTimeout(() => {
          nativeVideoFallbackTimer = null
          if (!nativeVideoPreviewVisible()) fallbackFn(...args)
        }, 700)
        if (result && typeof result.catch === 'function') {
          result.catch(() => fallbackFn(...args))
        }
        return result
      } catch {
        return fallbackFn(...args)
      }
    }
    return fallbackFn(...args)
  }

  function openVideoPreviewWithNativeFallback(videoUrl, prompt = '', options = {}) {
    return openLocalVideoPreview(videoUrl, prompt, options)
  }

  function openVideoPreviewModalWithNativeFallback(payload) {
    return openLocalVideoPreview(payload)
  }

  function openFullscreenVideoPreviewWithNativeFallback(videoUrl, title = '', options = {}) {
    const nextOptions = typeof options === 'object' && options ? { ...options, title, fullscreen: true } : { title, fullscreen: true }
    return openLocalVideoPreview(videoUrl, '', nextOptions)
  }

  function installVideoPreviewGlobal(name, wrapper, nativeSetter) {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          return wrapper
        },
        set(fn) {
          if (typeof fn === 'function' && fn !== wrapper && fn !== openLocalVideoPreview) {
            nativeSetter(fn)
          }
        }
      })
    } catch {
      window[name] = wrapper
    }
  }

  window.__wangOpenVideoPreviewFallback = openLocalVideoPreview
  window.__wangCloseVideoPreviewFallback = closeLocalVideoPreview
  installVideoPreviewGlobal('openVideoPreview', openVideoPreviewWithNativeFallback, fn => {
    nativeVideoPreview = fn
    window.__wangNativeVideoPreview = fn
  })
  installVideoPreviewGlobal('openVideoPreviewModal', openVideoPreviewModalWithNativeFallback, fn => {
    nativeVideoPreviewModal = fn
    window.__wangNativeVideoPreviewModal = fn
  })
  installVideoPreviewGlobal('openFullscreenVideoPreview', openFullscreenVideoPreviewWithNativeFallback, fn => {
    nativeFullscreenVideoPreview = fn
    window.__wangNativeFullscreenVideoPreview = fn
  })

  function installRemovedModulesGuard() {
    const removedModuleFns = Object.create(null)
    const removedNoop = function () {}
    const lockedGlobals = [
      'openNotifications',
      'openSystemNotice',
      'openMembershipModal',
      'openEnterpriseMembershipModal',
      'switchToPersonalModal',
      'switchToEnterpriseModal',
      'showPaymentModal',
      'showInsufficientPoints',
      'openActivityPromotion',
      'openVersionAnnouncement',
      'closeActiveAnnouncementDialog',
      'openInviteCodeDialog',
      'openInvoiceDialog',
      'openActiveSessionsDialog',
      'showPointsDetailsDialog',
      'showPointsUsageStats',
      'openMyGiftCards',
      'openGiftCardPurchase',
      'openRewardDialog'
    ]
    const hiddenSelectors = [
      '.convert-project-button',
      '.share-dropdown-wrapper',
      '.share-icon-button',
      '.collaboration-indicator',
      '.points-display',
      '.share-dialog-overlay',
      '.project-report-overlay',
      '.project-points-overlay',
      '.payment-modal-overlay',
      '.membership-modal-overlay',
      '.enterprise-membership-modal',
      '.notifications-panel',
      '.notification-panel',
      '.active-announcement-fade'
    ]
    const exactTexts = new Set([
      '协作',
      '成员管理',
      '成员查看',
      '邀请成员',
      '邀请协作者',
      '操作日志',
      '转为私有',
      '退出项目',
      '会员',
      '开通会员',
      '立即升级',
      '升级会员',
      '支付',
      '确认支付',
      '微信支付',
      '支付宝支付',
      '充值',
      '通知',
      '消息通知',
      '系统通知',
      '活动',
      '公告',
      '版本公告',
      '试用包',
      '社区商品',
      '比赛',
      '分享画布',
      '分享链接',
      '开启链接分享',
      '复制链接',
      '项目报表',
      '项目消耗报表',
      '积分记录',
      '交流社群',
      '优惠码',
      '有优惠码？',
      '我的礼品卡',
      '礼品卡',
      '奖励'
    ])
    const containsTexts = [
      '邀请成员',
      '开通会员',
      '确认支付',
      '微信支付',
      '支付宝支付',
      '项目消耗报表',
      '分享链接',
      '开启链接分享',
      '复制链接',
      '试用包',
      '社区商品',
      '比赛活动'
    ]
    const actionSelector = [
      'button',
      'a',
      'li',
      '[role="button"]',
      '.dropdown-item',
      '.settings-dropdown-item',
      '.share-dropdown-item',
      '.el-dropdown-menu__item',
      '.ant-dropdown-menu-item',
      '.member-level',
      '.share-detail-item'
    ].join(',')

    function lockGlobalFunction(name) {
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          get() {
            return removedNoop
          },
          set(fn) {
            if (typeof fn === 'function') removedModuleFns[name] = fn
          }
        })
      } catch {
        window[name] = removedNoop
      }
    }

    function ensureRemovedModuleStyles() {
      if (document.getElementById('wang-removed-modules-style')) return
      const style = document.createElement('style')
      style.id = 'wang-removed-modules-style'
      style.textContent = `
        ${hiddenSelectors.join(',\n        ')} {
          display: none !important;
          pointer-events: none !important;
        }
      `
      document.head.appendChild(style)
    }

    function normalizedText(el) {
      return String(el?.textContent || '').replace(/\s+/g, '').trim()
    }

    function isRemovedText(text) {
      if (!text) return false
      if (exactTexts.has(text)) return true
      return containsTexts.some(item => text.includes(item))
    }

    function closestActionElement(el) {
      if (!el || el === document.body || el === document.documentElement) return null
      const action = el.closest?.(actionSelector)
      if (action && action !== document.body && action !== document.documentElement) return action
      return null
    }

    function eachMatchedElement(root, selector, callback) {
      if (root.matches?.(selector)) callback(root)
      if (root.querySelectorAll) root.querySelectorAll(selector).forEach(callback)
    }

    function cleanupRemovedModulesUi(root = document) {
      if (!root.querySelectorAll && !root.matches) return
      hiddenSelectors.forEach(selector => {
        eachMatchedElement(root, selector, el => el.remove())
      })
      const actionElements = []
      eachMatchedElement(root, actionSelector, el => actionElements.push(el))
      actionElements.forEach(el => {
        if (isRemovedText(normalizedText(el))) el.remove()
      })
      const textElements = []
      eachMatchedElement(root, 'span, div', el => textElements.push(el))
      textElements.forEach(el => {
        const text = normalizedText(el)
        if (!isRemovedText(text)) return
        const action = closestActionElement(el)
        if (action) action.remove()
      })
    }

    function isRemovedModuleClickTarget(target) {
      if (!target || !target.closest) return false
      if (target.closest(hiddenSelectors.join(','))) return true
      const action = closestActionElement(target)
      return !!action && isRemovedText(normalizedText(action))
    }

    function startDomGuard() {
      if (!document.body) return
      const pendingRoots = new Set()
      let scheduled = false
      const scheduleCleanup = () => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          if (pendingRoots.size === 0) {
            cleanupRemovedModulesUi(document)
            return
          }
          const roots = Array.from(pendingRoots)
          pendingRoots.clear()
          roots.forEach(root => cleanupRemovedModulesUi(root))
        })
      }
      cleanupRemovedModulesUi(document)
      document.addEventListener('click', event => {
        if (!isRemovedModuleClickTarget(event.target)) return
        event.preventDefault()
        event.stopImmediatePropagation()
      }, true)
      const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) pendingRoots.add(node)
          })
        })
        scheduleCleanup()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      setInterval(() => {
        pendingRoots.clear()
        scheduleCleanup()
      }, 2000)
    }

    lockedGlobals.forEach(lockGlobalFunction)
    ensureRemovedModuleStyles()
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startDomGuard, { once: true })
    } else {
      startDomGuard()
    }
    window.__wangRemovedModulesGuard = {
      cleanup: () => cleanupRemovedModulesUi(document),
      ignoredGlobals: removedModuleFns
    }
  }

  installRemovedModulesGuard()

  // Try to load token from server config via fetch
  fetch('/config.json')
    .then(r => r.json())
    .then(config => {
      const token = config.authToken || 'mock-token-' + Date.now()
      const userInfo = {
        userId: 'local_user_001',
        mobile: '138****8888',
        nickname: '本地用户',
        avatar: null,
        status: 'active',
        lastLoginTime: new Date().toISOString(),
        authorization: token
      }
      localStorage.setItem('token', token)
      localStorage.setItem('userInfo', JSON.stringify(userInfo))
      localStorage.setItem('debug_platform', 'Wang')
      localStorage.setItem('asset_agreement_accepted', 'true')
      console.log('[Auth] Initialized with token from config')
    })
    .catch(() => {
      // Fallback: generate mock token
      const token = 'mock-token-' + Date.now()
      const userInfo = {
        userId: 'local_user_001',
        mobile: '138****8888',
        nickname: '本地用户',
        avatar: null,
        status: 'active',
        lastLoginTime: new Date().toISOString(),
        authorization: token
      }
      localStorage.setItem('token', token)
      localStorage.setItem('userInfo', JSON.stringify(userInfo))
      localStorage.setItem('debug_platform', 'Wang')
      localStorage.setItem('asset_agreement_accepted', 'true')
      console.log('[Auth] Initialized with mock token (config not available)')
    })

  window.showAssetAgreementDialog = function () { return Promise.resolve(true) }
  window.openLogin = function () {}
  window.openNotifications = function () {}
  window.openMembershipModal = function () {}
  window.__pendingOpenRegister = false
})()
