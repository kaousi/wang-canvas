;(function () {
  const dataImageCache = new Map()
  const DATA_IMAGE_PREFIX = 'data:image/'
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null
  const MAX_LOCAL_UPLOAD_REQUESTS = 4
  let localUploadActiveCount = 0
  const localUploadQueue = []

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

  async function cleanJsonBody(body) {
    if (!body || typeof body !== 'string' || !body.includes(DATA_IMAGE_PREFIX)) return body
    try {
      const json = JSON.parse(body)
      if (!hasDataImage(json)) return body
      await replaceDataImages(json)
      return JSON.stringify(json)
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
          init = { ...init, body: await cleanJsonBody(init.body) }
        } else if (input instanceof Request) {
          const contentType = input.headers.get('content-type') || ''
          if (isJsonContentType(contentType)) {
            const body = await input.clone().text()
            const cleanBody = await cleanJsonBody(body)
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
      if (!shouldSkipCleanup(url) && isJsonContentType(contentType) && typeof body === 'string' && body.includes(DATA_IMAGE_PREFIX)) {
        cleanJsonBody(body).then(cleanBody => {
          sendWithLocalUploadQueue(this, cleanBody, finalBody => originalSend.call(this, finalBody))
        })
        return
      }
      return sendWithLocalUploadQueue(this, body, finalBody => originalSend.call(this, finalBody))
    }
  }

  installDataUrlRequestCleanup()

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
