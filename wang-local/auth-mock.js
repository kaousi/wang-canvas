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
    let current = el
    for (let depth = 0; current && current !== document.body && depth < 16; depth += 1) {
      const text = compactUiText(current)
      if (current.classList?.contains('vue-flow__node')) {
        return isImageGenerationPanelText(text) ? current : null
      }
      if (
        text.length > 0 &&
        text.length < 12000 &&
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

  function injectInlineImagePromptPresetControls(root = document) {
    if (!root.querySelectorAll && !root.matches) return
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

  function installImagePromptPresetUi() {
    window.__wangImagePromptPresets = {
      presets: IMAGE_PROMPT_PRESETS,
      getSelected: selectedImagePromptPresetId,
      setSelected: setSelectedImagePromptPresetId,
      apply: applyImagePromptPresetText,
    }
    const start = () => {
      if (!document.body) return
      removeLegacyFloatingImagePromptPresetControls(document)
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
          if (pendingRoots.size === 0) injectInlineImagePromptPresetControls(document)
          else {
            const roots = Array.from(pendingRoots)
            pendingRoots.clear()
            roots.forEach(item => injectInlineImagePromptPresetControls(item))
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

  function ensureFullscreenPreviewStyles() {
    if (document.getElementById('wang-local-image-preview-style')) return
    const style = document.createElement('style')
    style.id = 'wang-local-image-preview-style'
    style.textContent = `
      .wang-local-image-preview {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 56px 24px 32px;
        box-sizing: border-box;
        color: #fff;
        background: rgba(4, 4, 4, 0.92);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }
      .wang-local-image-preview__bar {
        position: fixed;
        top: 12px;
        left: 16px;
        right: 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        pointer-events: none;
      }
      .wang-local-image-preview__title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: rgba(255, 255, 255, 0.78);
        font: 500 13px/32px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wang-local-image-preview__actions {
        display: flex;
        align-items: center;
        gap: 8px;
        pointer-events: auto;
      }
      .wang-local-image-preview__button {
        height: 32px;
        min-width: 32px;
        padding: 0 12px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 16px;
        color: rgba(255, 255, 255, 0.82);
        background: rgba(255, 255, 255, 0.08);
        font: 500 12px/30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-decoration: none;
        cursor: pointer;
        transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease;
      }
      .wang-local-image-preview__button:hover {
        color: #fff;
        border-color: rgba(255, 255, 255, 0.3);
        background: rgba(255, 255, 255, 0.16);
      }
      .wang-local-image-preview__stage {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        max-width: 100%;
        max-height: 100%;
      }
      .wang-local-image-preview__image {
        display: block;
        max-width: calc(100vw - 48px);
        max-height: calc(100vh - 112px);
        object-fit: contain;
        border-radius: 6px;
        background: #111;
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
      }
      .wang-local-image-preview__message {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        padding: 8px 12px;
        border-radius: 16px;
        color: rgba(255, 255, 255, 0.72);
        background: rgba(255, 255, 255, 0.08);
        font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: nowrap;
      }
      .wang-local-image-preview__message.is-hidden {
        display: none;
      }
    `
    document.head.appendChild(style)
  }

  function closeLocalFullscreenImagePreview() {
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

    const overlay = document.createElement('div')
    overlay.className = 'wang-local-image-preview'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')

    const bar = document.createElement('div')
    bar.className = 'wang-local-image-preview__bar'

    const titleEl = document.createElement('div')
    titleEl.className = 'wang-local-image-preview__title'
    titleEl.textContent = title || '图片预览'

    const actions = document.createElement('div')
    actions.className = 'wang-local-image-preview__actions'

    const download = document.createElement('a')
    download.className = 'wang-local-image-preview__button'
    download.textContent = '下载'
    download.target = '_blank'
    download.rel = 'noopener'

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'wang-local-image-preview__button'
    close.textContent = '关闭'
    close.addEventListener('click', closeLocalFullscreenImagePreview)

    actions.append(download, close)
    bar.append(titleEl, actions)

    const stage = document.createElement('div')
    stage.className = 'wang-local-image-preview__stage'

    const message = document.createElement('div')
    message.className = 'wang-local-image-preview__message'
    message.textContent = '加载中...'

    const image = document.createElement('img')
    image.className = 'wang-local-image-preview__image'
    image.alt = title || '图片预览'
    image.draggable = false
    image.addEventListener('click', event => event.stopPropagation())
    image.addEventListener('load', () => {
      message.classList.add('is-hidden')
    })
    image.addEventListener('error', () => {
      message.textContent = '图片加载失败'
      message.classList.remove('is-hidden')
    })

    stage.append(image, message)
    overlay.append(bar, stage)
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeLocalFullscreenImagePreview()
    })

    fullscreenPreviewEscHandler = event => {
      if (event.key === 'Escape') closeLocalFullscreenImagePreview()
    }
    document.addEventListener('keydown', fullscreenPreviewEscHandler)

    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.appendChild(overlay)
    fullscreenPreviewOverlay = overlay

    const resolvedUrl = await normalizePreviewImageUrl(imageUrl)
    if (!resolvedUrl) {
      message.textContent = '图片地址为空'
      return
    }
    image.src = resolvedUrl
    download.href = resolvedUrl
  }

  window.__wangOpenFullscreenImagePreviewFallback = openLocalFullscreenImagePreview
  window.__wangCloseFullscreenImagePreviewFallback = closeLocalFullscreenImagePreview
  try {
    Object.defineProperty(window, 'openFullscreenImagePreview', {
      configurable: true,
      get() {
        return openLocalFullscreenImagePreview
      },
      set(fn) {
        if (typeof fn === 'function' && fn !== openLocalFullscreenImagePreview) {
          nativeFullscreenImagePreview = fn
          window.__wangNativeFullscreenImagePreview = fn
        }
      }
    })
  } catch {
    window.openFullscreenImagePreview = openLocalFullscreenImagePreview
  }

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
