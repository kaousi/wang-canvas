(function () {
  'use strict'

  const playbackPositions = new WeakMap()
  const playbackPositionsBySrc = new Map()
  const primedVideos = new WeakSet()
  const fullscreenButtons = new WeakMap()
  const posterFrames = new WeakMap()
  const posterOverlays = new WeakMap()
  const posterLoadTokens = new WeakMap()
  const firstFrameCaptureTasks = new WeakMap()
  const invalidPosterUrls = new Set()
  const VIDEO_HIDDEN_BEHIND_POSTER_CLASS = 'wang-video-hidden-behind-poster'

  function ensurePreviewStyles() {
    if (document.getElementById('wang-video-preview-fix-style')) return
    const style = document.createElement('style')
    style.id = 'wang-video-preview-fix-style'
    style.textContent = `
      video.${VIDEO_HIDDEN_BEHIND_POSTER_CLASS} {
        opacity: 0 !important;
        transition: none !important;
      }
      .vue-flow__node video.node-preview-video,
      .vue-flow__node .video-preview-shell video,
      .vue-flow__node .video-preview-shell .wang-video-poster-frame,
      .vue-flow__node .node-result-container .wang-video-poster-frame {
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
        object-fit: contain !important;
        object-position: center center !important;
      }
      .vue-flow__node .video-preview-shell,
      .vue-flow__node .node-result-container:has(video) {
        position: relative !important;
        overflow: hidden !important;
      }
      .vue-flow__node .wang-video-poster-frame {
        position: absolute;
        inset: 0;
        z-index: 3;
        display: block;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: inherit;
        background: #000;
        pointer-events: none;
        opacity: 0;
        transition: opacity 120ms ease;
      }
      .wang-video-node-fullscreen-btn {
        position: absolute;
        top: 8px;
        right: 44px;
        z-index: 24;
        width: 30px;
        height: 30px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: rgba(255, 255, 255, 0.9);
        background: rgba(0, 0, 0, 0.62);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        cursor: pointer;
        opacity: 0.82;
        transition: opacity 0.16s ease, background 0.16s ease, transform 0.16s ease;
        pointer-events: auto;
      }
      .video-preview-shell:not(:has(.upload-replace-btn)) > .wang-video-node-fullscreen-btn,
      .media-preview-wrapper > .wang-video-node-fullscreen-btn {
        right: 8px;
      }
      .vue-flow__node:hover .wang-video-node-fullscreen-btn,
      .wang-video-node-fullscreen-btn:focus-visible {
        opacity: 1;
      }
      .wang-video-node-fullscreen-btn:hover {
        background: rgba(0, 0, 0, 0.82);
        transform: scale(1.04);
      }
      .wang-video-node-fullscreen-btn svg {
        width: 15px;
        height: 15px;
        display: block;
      }
    `
    document.head.appendChild(style)
  }

  function isWorkflowVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return false
    if (video.closest('.aa-overlay')) return false
    if (video.closest('.wang-local-video-preview')) return false
    if (video.closest('.workflow-container, .vue-flow, .image-grid-modal-overlay')) return true
    const src = video.currentSrc || video.src || video.getAttribute('src') || video.poster || ''
    return src.includes('/generated/') || src.includes('/dify/')
  }

  function normalizeVideoUrl(url) {
    if (!url) return ''
    try {
      return new URL(url, window.location.href).href
    } catch {
      return url
    }
  }

  function stripOssVideoSnapshot(url) {
    if (!url) return ''
    const raw = String(url).trim()
    if (!raw) return ''
    try {
      const parsed = new URL(raw, window.location.href)
      if (parsed.searchParams.has('x-oss-process')) {
        const processValue = parsed.searchParams.get('x-oss-process') || ''
        if (processValue.includes('video/snapshot')) {
          parsed.searchParams.delete('x-oss-process')
        }
      }
      return parsed.href
    } catch {
      return raw.replace(/\?x-oss-process=video\/snapshot.*$/i, '')
    }
  }

  function videoSnapshotUrl(videoUrl) {
    if (!videoUrl) return ''
    const base = stripOssVideoSnapshot(videoUrl)
    if (!base || base.startsWith('data:') || base.startsWith('blob:')) return ''
    try {
      const parsed = new URL(base, window.location.href)
      if (!parsed.searchParams.has('x-oss-process')) {
        parsed.searchParams.set('x-oss-process', 'video/snapshot,t_1000,f_jpg,w_400')
      }
      return parsed.href
    } catch {
      return base.includes('?')
        ? `${base}&x-oss-process=video/snapshot,t_1000,f_jpg,w_400`
        : `${base}?x-oss-process=video/snapshot,t_1000,f_jpg,w_400`
    }
  }

  function currentVideoUrl(video) {
    const direct = video.currentSrc || video.src || video.getAttribute('src') || ''
    if (direct) return normalizeVideoUrl(direct)
    return normalizeVideoUrl(stripOssVideoSnapshot(video.poster || ''))
  }

  function mediaKeys(video) {
    const posterSource = stripOssVideoSnapshot(video.poster || '')
    const values = [
      video.currentSrc,
      video.src,
      video.getAttribute('src'),
      posterSource,
    ].filter(Boolean)
    const keys = new Set()
    values.forEach(value => {
      const raw = String(value || '').trim()
      if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return
      keys.add(raw)
      try {
        const url = new URL(raw, window.location.href)
        keys.add(url.href)
        keys.add(url.pathname + url.search)
        keys.add(url.pathname)
      } catch {
        /* ignore */
      }
    })
    return Array.from(keys)
  }

  function finiteDuration(video) {
    const duration = Number(video.duration)
    return Number.isFinite(duration) && duration > 0 ? duration : 0
  }

  function recordPlaybackPosition(video) {
    if (!isWorkflowVideo(video)) return
    const time = Number(video.currentTime)
    if (!Number.isFinite(time) || time <= 0.08) return

    const duration = finiteDuration(video)
    if (duration > 0 && time >= duration - 0.2) return

    playbackPositions.set(video, time)
    mediaKeys(video).forEach(key => playbackPositionsBySrc.set(key, time))
  }

  function clearPlaybackPosition(video) {
    playbackPositions.delete(video)
    mediaKeys(video).forEach(key => playbackPositionsBySrc.delete(key))
  }

  function storedPlaybackPosition(video) {
    const own = playbackPositions.get(video)
    if (Number.isFinite(own)) return own
    for (const key of mediaKeys(video)) {
      const stored = playbackPositionsBySrc.get(key)
      if (Number.isFinite(stored)) return stored
    }
    return 0
  }

  function restorePlaybackPosition(video) {
    if (!isWorkflowVideo(video) || video.readyState < 1) return false
    if (Number(video.currentTime) > 0.12) return false

    const time = storedPlaybackPosition(video)
    const duration = finiteDuration(video)
    if (!Number.isFinite(time) || time <= 0.12) return false
    if (duration > 0 && time >= duration - 0.2) return false

    try {
      video.currentTime = time
      return true
    } catch {
      return false
    }
  }

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
  }

  function videoNodeTitle(video) {
    const node = video.closest('.vue-flow__node')
    if (!node) return '视频预览'
    const titleEl = node.querySelector('.ai-node-title, .ai-node-external-title')
    return compactText(titleEl?.textContent) || video.getAttribute('aria-label') || '视频预览'
  }

  function previewShell(video) {
    return video.closest('.video-preview-shell, .media-preview-wrapper, .node-result-container') || video.parentElement
  }

  function ensurePosterOverlay(video) {
    if (!isWorkflowVideo(video)) return null
    const shell = previewShell(video)
    if (!shell) return null

    let overlay = posterOverlays.get(video)
    if (overlay && overlay.isConnected && overlay.parentElement === shell) return overlay

    overlay = shell.querySelector(':scope > .wang-video-poster-frame')
    if (!overlay) {
      overlay = document.createElement('img')
      overlay.className = 'wang-video-poster-frame'
      overlay.alt = ''
      overlay.setAttribute('aria-hidden', 'true')
      shell.insertBefore(overlay, shell.firstChild)
    }
    if (getComputedStyle(shell).position === 'static') shell.style.position = 'relative'
    posterOverlays.set(video, overlay)
    return overlay
  }

  function capturePosterFrame(video) {
    if (!isWorkflowVideo(video)) return ''
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      try {
        const canvas = document.createElement('canvas')
        const maxSide = 720
        const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight))
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const poster = canvas.toDataURL('image/jpeg', 0.84)
          posterFrames.set(video, poster)
          return poster
        }
      } catch {
        /* Cross-origin videos fall back to the server snapshot. */
      }
    }
    const cachedPoster = posterFrames.get(video)
    if (cachedPoster && !invalidPosterUrls.has(cachedPoster)) return cachedPoster
    if (video.poster && !invalidPosterUrls.has(video.poster)) return video.poster

    const snapshot = videoSnapshotUrl(currentVideoUrl(video))
    return snapshot && !invalidPosterUrls.has(snapshot) ? snapshot : ''
  }

  function showLoadedPoster(video, overlay, poster) {
    const token = Symbol('poster-load')
    posterLoadTokens.set(video, token)
    overlay.style.opacity = '0'

    const image = new Image()
    image.onload = () => {
      if (posterLoadTokens.get(video) !== token || !video.isConnected) return
      overlay.src = poster
      overlay.style.opacity = '1'
      video.classList.add(VIDEO_HIDDEN_BEHIND_POSTER_CLASS)
    }
    image.onerror = () => {
      if (posterLoadTokens.get(video) !== token) return
      invalidPosterUrls.add(poster)
      overlay.removeAttribute('src')
      overlay.style.opacity = '0'
      video.classList.remove(VIDEO_HIDDEN_BEHIND_POSTER_CLASS)
      if (video.poster === poster) video.removeAttribute('poster')
      scheduleFirstFramePoster(video)
    }
    image.src = poster
  }

  function scheduleFirstFramePoster(video) {
    if (!isWorkflowVideo(video) || firstFrameCaptureTasks.has(video)) return
    const url = currentVideoUrl(video)
    if (!url) return

    const task = document.createElement('video')
    firstFrameCaptureTasks.set(video, task)
    task.muted = true
    task.playsInline = true
    task.preload = 'auto'
    task.crossOrigin = 'anonymous'
    task.setAttribute('playsinline', '')

    const cleanup = () => {
      firstFrameCaptureTasks.delete(video)
      task.removeAttribute('src')
      try {
        task.load()
      } catch {
        /* ignore */
      }
    }
    const capture = () => {
      if (!task.videoWidth || !task.videoHeight) return cleanup()
      try {
        const canvas = document.createElement('canvas')
        const maxSide = 720
        const scale = Math.min(1, maxSide / Math.max(task.videoWidth, task.videoHeight))
        canvas.width = Math.max(1, Math.round(task.videoWidth * scale))
        canvas.height = Math.max(1, Math.round(task.videoHeight * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) return cleanup()
        ctx.drawImage(task, 0, 0, canvas.width, canvas.height)
        const poster = canvas.toDataURL('image/jpeg', 0.84)
        posterFrames.set(video, poster)
        cleanup()
        if (video.paused) showPoster(video)
      } catch {
        cleanup()
      }
    }

    task.addEventListener('loadedmetadata', () => {
      try {
        task.currentTime = Math.min(0.08, Math.max(0, Number(task.duration) || 0))
      } catch {
        capture()
      }
    }, { once: true })
    task.addEventListener('seeked', capture, { once: true })
    task.addEventListener('loadeddata', () => {
      if (!Number.isFinite(task.duration) || task.duration <= 0.12) capture()
    }, { once: true })
    task.addEventListener('error', cleanup, { once: true })
    task.src = url
    try {
      task.load()
    } catch {
      cleanup()
    }
  }

  function showPoster(video) {
    if (!isWorkflowVideo(video) || !video.isConnected || !video.paused) return
    ensurePreviewStyles()
    const overlay = ensurePosterOverlay(video)
    if (!overlay) return
    const poster = capturePosterFrame(video)
    if (!poster) {
      scheduleFirstFramePoster(video)
      return
    }
    showLoadedPoster(video, overlay, poster)
  }

  function hidePoster(video) {
    posterLoadTokens.set(video, Symbol('poster-hidden'))
    video.classList.remove(VIDEO_HIDDEN_BEHIND_POSTER_CLASS)
    const overlay = posterOverlays.get(video)
    if (overlay) overlay.style.opacity = '0'
  }

  function validateNativePoster(video) {
    const poster = video.poster
    if (!poster || invalidPosterUrls.has(poster)) return
    const image = new Image()
    image.onerror = () => {
      invalidPosterUrls.add(poster)
      if (video.poster === poster) video.removeAttribute('poster')
      if (video.paused) scheduleFirstFramePoster(video)
    }
    image.src = poster
  }

  function openNodeFullscreenPreview(video) {
    const url = currentVideoUrl(video)
    if (!url) return

    recordPlaybackPosition(video)
    const startTime = Number(video.currentTime)
    const storedStartTime = Number.isFinite(startTime) && startTime > 0 ? startTime : storedPlaybackPosition(video)
    const options = {
      title: videoNodeTitle(video),
      startTime: Number.isFinite(storedStartTime) ? storedStartTime : 0,
      fullscreen: true
    }
    try {
      video.pause()
    } catch {
      /* ignore */
    }

    const openPreview = window.__wangOpenVideoPreviewFallback || window.openVideoPreviewModal || window.openVideoPreview
    if (typeof openPreview !== 'function') return

    if (openPreview === window.openVideoPreviewModal) {
      openPreview({ url, info: options, startTime: options.startTime, fullscreen: true })
      return
    }
    openPreview(url, '', options)
  }

  function ensureFullscreenButton(video) {
    if (!isWorkflowVideo(video)) return
    const shell = previewShell(video)
    if (!shell) return
    ensurePreviewStyles()

    let button = fullscreenButtons.get(video)
    if (button && button.isConnected && button.parentElement === shell) return

    button = shell.querySelector(':scope > .wang-video-node-fullscreen-btn')
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = 'wang-video-node-fullscreen-btn nodrag nopan'
      button.title = '全屏预览'
      button.setAttribute('aria-label', '全屏预览')
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>'
      ;['pointerdown', 'mousedown', 'mouseup', 'dblclick'].forEach(eventName => {
        button.addEventListener(eventName, event => {
          event.preventDefault()
          event.stopPropagation()
        }, true)
      })
      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        openNodeFullscreenPreview(video)
      }, true)
      shell.appendChild(button)
    }
    if (getComputedStyle(shell).position === 'static') shell.style.position = 'relative'
    fullscreenButtons.set(video, button)
  }

  function primeVideo(video) {
    if (!isWorkflowVideo(video)) return
    ensureFullscreenButton(video)
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    validateNativePoster(video)
    setTimeout(() => {
      if (video.paused) showPoster(video)
    }, 0)
    if (primedVideos.has(video)) return
    primedVideos.add(video)
    video.addEventListener('timeupdate', () => {
      recordPlaybackPosition(video)
      if (!video.paused) hidePoster(video)
    })
    video.addEventListener('pause', () => {
      recordPlaybackPosition(video)
      setTimeout(() => {
        if (video.paused) showPoster(video)
      }, 30)
    })
    video.addEventListener('seeked', () => {
      if (Number(video.currentTime) <= 0.08) clearPlaybackPosition(video)
      else recordPlaybackPosition(video)
      if (video.paused) showPoster(video)
    })
    video.addEventListener('play', () => {
      hidePoster(video)
      ;[0, 80, 180].forEach(delay => setTimeout(() => restorePlaybackPosition(video), delay))
    })
    video.addEventListener('loadedmetadata', () => {
      restorePlaybackPosition(video)
      recordPlaybackPosition(video)
      if (video.paused) showPoster(video)
    })
    video.addEventListener('loadeddata', () => {
      capturePosterFrame(video)
      if (video.paused) showPoster(video)
    })
    video.addEventListener('ended', () => {
      clearPlaybackPosition(video)
      showPoster(video)
    })
    video.addEventListener('emptied', () => showPoster(video))
  }

  function primeAll(root) {
    const scope = root && root.querySelectorAll ? root : document
    scope.querySelectorAll('video').forEach(primeVideo)
    if (root instanceof HTMLVideoElement) primeVideo(root)
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element) primeAll(node)
      })
    })
  })

  window.addEventListener('DOMContentLoaded', () => {
    primeAll(document)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    setInterval(() => primeAll(document), 1200)
  })

  window.addEventListener('resize', () => primeAll(document))
})()
