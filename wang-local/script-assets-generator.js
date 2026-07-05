(function () {
  'use strict'

  const BUTTON_ATTR = 'data-script-assets-generate'
  const BATCH_BUTTON_ATTR = 'data-script-assets-batch-download'
  const GROUP_BATCH_BUTTON_ATTR = 'data-group-batch-generate'
  const BUS_EVENT_CREATE_NODE = 'agent-create-node'
  const BUS_EVENT_UPDATE_NODE = 'update-node-data'
  const DEFAULT_SESSION_ID = 'demo'
  const DEFAULT_CONCURRENCY_LIMIT = 20
  const RENDER_MODES = [
    { value: '插画', label: '插画' },
    { value: '3D', label: '3D' },
    { value: '真人', label: '真人' },
  ]
  const activeRequests = new Set()
  const activeGroupRequests = new Set()
  const pendingPolls = new Map()
  const batchPanels = new Map()
  const sessionNodesCache = { sessionId: '', nodes: [], fetchedAt: 0 }

  function ensureStyles() {
    if (document.getElementById('wang-script-assets-style')) return
    const style = document.createElement('style')
    style.id = 'wang-script-assets-style'
    style.textContent = `
      .wang-script-assets-row {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 8px 12px 10px;
        pointer-events: auto;
      }
      .wang-script-assets-btn {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 8px;
        min-height: 30px;
        padding: 0 11px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: rgba(255, 255, 255, 0.92);
        background: rgba(255, 255, 255, 0.075);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
        font-size: 12px;
        line-height: 1;
        font-weight: 500;
        white-space: nowrap;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
      }
      .wang-script-assets-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.26);
        transform: translateY(-1px);
      }
      .wang-script-assets-btn:disabled {
        cursor: default;
        opacity: 0.58;
        transform: none;
      }
      .wang-script-assets-btn svg {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
      }
      .wang-group-batch-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 20;
        min-height: 28px;
        padding: 0 10px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 8px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: rgba(255, 255, 255, 0.92);
        background: rgba(22, 22, 24, 0.74);
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        font-size: 12px;
        line-height: 1;
        font-weight: 560;
        white-space: nowrap;
        cursor: pointer;
        pointer-events: auto;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
      }
      .wang-group-batch-btn:hover {
        background: rgba(34, 34, 38, 0.9);
        border-color: rgba(255, 255, 255, 0.3);
        transform: translateY(-1px);
      }
      .wang-group-batch-btn:disabled {
        cursor: default;
        opacity: 0.6;
        transform: none;
      }
      .wang-group-batch-btn svg {
        width: 13px;
        height: 13px;
        flex: 0 0 auto;
      }
      .wang-script-assets-toast {
        position: fixed;
        left: 50%;
        bottom: 30px;
        z-index: 100000;
        transform: translateX(-50%);
        max-width: min(520px, calc(100vw - 32px));
        padding: 10px 14px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        color: rgba(255, 255, 255, 0.94);
        background: rgba(18, 18, 20, 0.92);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        font-size: 13px;
        line-height: 1.45;
        pointer-events: none;
      }
      .wang-script-assets-batch-panel {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 99980;
        width: min(360px, calc(100vw - 36px));
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 10px;
        color: rgba(255, 255, 255, 0.92);
        background: rgba(18, 18, 20, 0.94);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        overflow: hidden;
      }
      .wang-script-assets-batch-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 12px 8px;
      }
      .wang-script-assets-batch-title {
        font-size: 13px;
        font-weight: 650;
      }
      .wang-script-assets-batch-close {
        width: 26px;
        height: 26px;
        border: 0;
        border-radius: 7px;
        color: rgba(255, 255, 255, 0.68);
        background: transparent;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      .wang-script-assets-batch-close:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.08);
      }
      .wang-script-assets-batch-body {
        display: grid;
        gap: 10px;
        padding: 0 12px 12px;
      }
      .wang-script-assets-batch-meta {
        color: rgba(255, 255, 255, 0.62);
        font-size: 12px;
      }
      .wang-script-assets-batch-progress {
        height: 6px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.1);
      }
      .wang-script-assets-batch-bar {
        width: 0%;
        height: 100%;
        border-radius: inherit;
        background: rgba(255, 255, 255, 0.82);
        transition: width 0.2s ease;
      }
      .wang-script-assets-batch-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .wang-script-assets-batch-download {
        min-height: 32px;
        padding: 0 12px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 8px;
        color: #111;
        background: rgba(255, 255, 255, 0.94);
        cursor: pointer;
        font-size: 12px;
      }
      .wang-script-assets-batch-download:disabled {
        cursor: default;
        opacity: 0.56;
      }
      .wang-script-assets-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 99990;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.58);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
      }
      .wang-script-assets-modal {
        width: min(840px, calc(100vw - 32px));
        max-height: min(760px, calc(100vh - 32px));
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 10px;
        color: rgba(255, 255, 255, 0.94);
        background: rgba(20, 20, 22, 0.96);
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.48);
        overflow: hidden;
      }
      .wang-script-assets-modal-header,
      .wang-script-assets-modal-footer {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .wang-script-assets-modal-footer {
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        border-bottom: 0;
      }
      .wang-script-assets-modal-title {
        font-size: 15px;
        font-weight: 650;
      }
      .wang-script-assets-modal-close {
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 8px;
        color: rgba(255, 255, 255, 0.72);
        background: transparent;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
      }
      .wang-script-assets-modal-close:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.08);
      }
      .wang-script-assets-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 16px;
      }
      .wang-script-assets-section {
        display: grid;
        gap: 10px;
        margin-bottom: 16px;
      }
      .wang-script-assets-section-title {
        color: rgba(255, 255, 255, 0.7);
        font-size: 12px;
      }
      .wang-script-assets-mode-group {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .wang-script-assets-mode {
        min-height: 42px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 8px;
        color: rgba(255, 255, 255, 0.88);
        background: rgba(255, 255, 255, 0.055);
        cursor: pointer;
        font-size: 13px;
      }
      .wang-script-assets-mode.active {
        border-color: rgba(255, 255, 255, 0.38);
        background: rgba(255, 255, 255, 0.16);
        color: #fff;
      }
      .wang-script-assets-mode:hover {
        border-color: rgba(255, 255, 255, 0.26);
        background: rgba(255, 255, 255, 0.1);
      }
      .wang-script-assets-settings-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .wang-script-assets-field {
        display: grid;
        gap: 6px;
      }
      .wang-script-assets-field-label {
        color: rgba(255, 255, 255, 0.7);
        font-size: 12px;
      }
      .wang-script-assets-input {
        width: 100%;
        min-height: 36px;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        padding: 0 10px;
        color: rgba(255, 255, 255, 0.92);
        background: rgba(255, 255, 255, 0.06);
        outline: none;
        font-size: 13px;
      }
      .wang-script-assets-input:focus {
        border-color: rgba(255, 255, 255, 0.34);
        background: rgba(255, 255, 255, 0.09);
      }
      .wang-script-assets-field-hint {
        color: rgba(255, 255, 255, 0.45);
        font-size: 11px;
        line-height: 1.35;
      }
      .wang-script-assets-preview-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .wang-script-assets-list-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin: 0 0 10px;
        color: rgba(255, 255, 255, 0.72);
        font-size: 12px;
      }
      .wang-script-assets-list-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .wang-script-assets-list {
        display: grid;
        gap: 8px;
      }
      .wang-script-assets-item {
        display: grid;
        grid-template-columns: 24px 1fr;
        gap: 10px;
        padding: 10px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.045);
      }
      .wang-script-assets-item-check {
        margin-top: 2px;
        width: 16px;
        height: 16px;
      }
      .wang-script-assets-item-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
      }
      .wang-script-assets-badge {
        flex: 0 0 auto;
        min-width: 34px;
        padding: 2px 6px;
        border-radius: 6px;
        color: #fff;
        background: rgba(255, 255, 255, 0.14);
        font-size: 11px;
        text-align: center;
      }
      .wang-script-assets-item-name {
        flex: 1 1 auto;
        min-width: 0;
        height: 30px;
        box-sizing: border-box;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 7px;
        padding: 0 8px;
        color: rgba(255, 255, 255, 0.94);
        background: rgba(255, 255, 255, 0.055);
        outline: none;
        font-size: 13px;
        font-weight: 600;
      }
      .wang-script-assets-item-prompt {
        width: 100%;
        min-height: 82px;
        box-sizing: border-box;
        resize: vertical;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 7px;
        padding: 8px;
        color: rgba(255, 255, 255, 0.7);
        background: rgba(255, 255, 255, 0.045);
        outline: none;
        font-size: 12px;
        line-height: 1.55;
      }
      .wang-script-assets-item-name:focus,
      .wang-script-assets-item-prompt:focus {
        border-color: rgba(255, 255, 255, 0.34);
        background: rgba(255, 255, 255, 0.08);
      }
      .wang-script-assets-empty {
        min-height: 98px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 18px;
        border: 1px dashed rgba(255, 255, 255, 0.13);
        border-radius: 8px;
        color: rgba(255, 255, 255, 0.5);
        background: rgba(255, 255, 255, 0.035);
        font-size: 13px;
        text-align: center;
      }
      .wang-script-assets-error {
        padding: 10px 12px;
        border: 1px solid rgba(248, 113, 113, 0.25);
        border-radius: 8px;
        color: #fecaca;
        background: rgba(127, 29, 29, 0.22);
        font-size: 12px;
      }
      .wang-script-assets-modal-meta {
        color: rgba(255, 255, 255, 0.56);
        font-size: 12px;
      }
      .wang-script-assets-primary,
      .wang-script-assets-secondary {
        min-height: 34px;
        padding: 0 13px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        cursor: pointer;
        font-size: 13px;
      }
      .wang-script-assets-primary {
        color: #111;
        background: rgba(255, 255, 255, 0.94);
      }
      .wang-script-assets-secondary {
        color: rgba(255, 255, 255, 0.86);
        background: rgba(255, 255, 255, 0.07);
      }
      .wang-script-assets-link-btn {
        border: 0;
        padding: 0;
        color: rgba(255, 255, 255, 0.72);
        background: transparent;
        cursor: pointer;
        font-size: 12px;
      }
      .wang-script-assets-link-btn:hover {
        color: #fff;
      }
      .wang-script-assets-primary:disabled,
      .wang-script-assets-secondary:disabled,
      .wang-script-assets-link-btn:disabled {
        cursor: default;
        opacity: 0.55;
      }
      .wang-script-assets-footer-left,
      .wang-script-assets-footer-right {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      @media (max-width: 640px) {
        .wang-script-assets-modal-backdrop {
          padding: 12px;
        }
        .wang-script-assets-mode-group {
          grid-template-columns: 1fr;
        }
        .wang-script-assets-settings-grid {
          grid-template-columns: 1fr;
        }
        .wang-script-assets-preview-actions,
        .wang-script-assets-modal-footer {
          align-items: stretch;
          flex-direction: column;
        }
        .wang-script-assets-footer-left,
        .wang-script-assets-footer-right {
          width: 100%;
          justify-content: flex-end;
        }
      }
    `
    document.head.appendChild(style)
  }

  function toast(message, timeout = 2600) {
    const old = document.querySelector('.wang-script-assets-toast')
    if (old) old.remove()
    const el = document.createElement('div')
    el.className = 'wang-script-assets-toast'
    el.textContent = message
    document.body.appendChild(el)
    setTimeout(() => el.remove(), timeout)
  }

  function getSessionId() {
    const params = new URLSearchParams(window.location.search || '')
    return params.get('workspaceId') || params.get('sessionId') || params.get('id') || DEFAULT_SESSION_ID
  }

  function normalizeConcurrencyLimit(value) {
    const n = Math.floor(Number(value))
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_CONCURRENCY_LIMIT
  }

  function cleanAssetName(value, fallback = '资产') {
    const name = String(value || '')
      .trim()
      .replace(/^(人物|物品|场景|资产)\s*[-—－:：]\s*/i, '')
      .trim()
    return name || fallback
  }

  function safeFileName(value, fallback = '资产') {
    return cleanAssetName(value, fallback)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .slice(0, 120) || fallback
  }

  function extensionFromContentType(contentType = '') {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase()
    if (type === 'image/jpeg') return 'jpg'
    if (type === 'image/png') return 'png'
    if (type === 'image/webp') return 'webp'
    if (type === 'image/gif') return 'gif'
    if (type === 'video/mp4') return 'mp4'
    return ''
  }

  function extensionFromUrl(url = '') {
    try {
      const pathname = new URL(url, window.location.href).pathname
      const ext = decodeURIComponent(pathname.split('/').pop() || '').split('.').pop()
      return /^[a-z0-9]{2,5}$/i.test(ext) ? ext.toLowerCase() : ''
    } catch {
      return ''
    }
  }

  function uniqueFileName(baseName, ext, used) {
    const cleanBase = safeFileName(baseName)
    const cleanExt = String(ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
    let name = `${cleanBase}.${cleanExt}`
    let index = 2
    while (used.has(name.toLowerCase())) {
      name = `${cleanBase}_${index}.${cleanExt}`
      index += 1
    }
    used.add(name.toLowerCase())
    return name
  }

  function nodeIdFromElement(nodeEl) {
    return nodeEl?.getAttribute('data-id') || nodeEl?.dataset?.id || ''
  }

  async function fetchSessionNodes(sessionId) {
    if (!sessionId) return []
    if (sessionNodesCache.sessionId === sessionId && Date.now() - sessionNodesCache.fetchedAt < 1600) {
      return sessionNodesCache.nodes
    }
    try {
      const resp = await fetch(`/agent/story-canvas/session/${encodeURIComponent(sessionId)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const json = await resp.json()
      const nodes = json?.data?.nodes || json?.nodes || []
      sessionNodesCache.sessionId = sessionId
      sessionNodesCache.nodes = Array.isArray(nodes) ? nodes : []
      sessionNodesCache.fetchedAt = Date.now()
      return sessionNodesCache.nodes
    } catch {
      return []
    }
  }

  async function fetchSessionNode(sessionId, nodeId) {
    if (!sessionId || !nodeId) return null
    const nodes = await fetchSessionNodes(sessionId)
    return nodes.find(item => String(item.id || '') === String(nodeId)) || null
  }

  function textFromDom(nodeEl) {
    const textareas = Array.from(nodeEl.querySelectorAll('textarea'))
    const textarea = textareas
      .map(item => String(item.value || '').trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0]
    if (textarea) return textarea

    const editable = Array.from(nodeEl.querySelectorAll('[contenteditable="true"]'))
      .map(item => String(item.innerText || item.textContent || '').trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0]
    return editable || ''
  }

  function textFromNodeData(node) {
    const data = node?.data || {}
    const candidates = [
      data.prompt,
      data.textContent,
      data.content,
      data.result,
      data.generatedText,
      data.outputText,
    ]
    for (const item of candidates) {
      if (typeof item === 'string' && item.trim()) return item.trim()
      if (item && typeof item === 'object') {
        const values = [item.textContent, item.content, item.text, item.output_text, item.imageUrl, item.url]
        const text = values.find(value => typeof value === 'string' && value.trim())
        if (text) return text.trim()
      }
    }
    return ''
  }

  function updateNodeData(nodeId, data, sync = true) {
    if (!nodeId || !window.workflowEventBus?.emit) return
    window.workflowEventBus.emit(BUS_EVENT_UPDATE_NODE, { nodeId, data, sync })
  }

  function emitImageNodes(nodeEvents) {
    if (!window.workflowEventBus?.emit) return false
    nodeEvents.forEach((event, index) => {
      setTimeout(() => {
        window.workflowEventBus.emit(BUS_EVENT_CREATE_NODE, {
          ...event,
          positionIndex: index,
          totalCount: nodeEvents.length,
        })
      }, index * 20)
    })
    return true
  }

  async function pollGeneratedImages(tasks) {
    const active = tasks
      .filter(item => item?.taskId && item?.nodeId)
      .filter(item => !pendingPolls.has(item.taskId))
    if (active.length === 0) return
    active.forEach(item => pendingPolls.set(item.taskId, item))

    const startedAt = Date.now()
    const tick = async () => {
      const taskIds = active.map(item => item.taskId).filter(taskId => pendingPolls.has(taskId))
      if (taskIds.length === 0) return
      try {
        const resp = await fetch('/agent/story-canvas/batch-query-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ taskIds }),
        })
        const json = await resp.json()
        const rows = Array.isArray(json?.data) ? json.data : []
        rows.forEach(row => {
          const taskId = row.taskId
          const status = String(row.status || '').toUpperCase()
          const target = pendingPolls.get(taskId)
          if (!target) return
          if (status === 'PROCESSING') {
            const queueStatus = String(row.queueStatus || '').toUpperCase()
            updateNodeData(target.nodeId, {
              status: 'PENDING',
              isGenerating: true,
              generatingMessage: queueStatus === 'QUEUED' ? '排队中...' : '图片生成中...',
              hasError: false,
              errorMessage: '',
            })
            return
          }
          if (!['SUCCESS', 'FAILED'].includes(status)) return
          const resultData = Array.isArray(row.resultData) ? row.resultData.filter(Boolean) : row.resultData ? [row.resultData] : []
          if (status === 'SUCCESS') {
            updateNodeData(target.nodeId, {
              status: 'SUCCESS',
              isGenerating: false,
              generatingMessage: '',
              inputImageUrls: resultData,
              result: null,
              hasError: false,
              errorMessage: '',
            })
          } else {
            updateNodeData(target.nodeId, {
              status: 'FAILED',
              isGenerating: false,
              generatingMessage: '',
              hasError: true,
              errorMessage: row.errorMessage || '图片生成失败',
            })
          }
          pendingPolls.delete(taskId)
        })
      } catch (err) {
        console.warn('[script-assets] poll failed:', err)
      }
      if (active.some(item => pendingPolls.has(item.taskId)) && Date.now() - startedAt < 15 * 60 * 1000) {
        setTimeout(tick, 4000)
      }
    }
    setTimeout(tick, 1200)
  }

  function normalizeBatchItems(items = []) {
    return (Array.isArray(items) ? items : []).map((item, index) => ({
      taskId: item.taskId || '',
      nodeId: item.nodeId || item.nodeKey || '',
      status: String(item.status || 'PROCESSING').toUpperCase(),
      queueStatus: String(item.queueStatus || '').toUpperCase(),
      assetName: cleanAssetName(item.assetName || item.name || item.item?.name || `资产${index + 1}`, `资产${index + 1}`),
      urls: Array.isArray(item.urls) ? item.urls.filter(Boolean) : item.url ? [item.url] : [],
      errorMessage: item.errorMessage || '',
    }))
  }

  async function fetchScriptAssetBatch(batchId) {
    const resp = await fetch(`/api/script-assets/batch/${encodeURIComponent(batchId)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    const json = await resp.json()
    if (!json?.success) throw new Error(json?.errMessage || json?.message || '获取资产组失败')
    return {
      ...(json.data || {}),
      items: normalizeBatchItems(json?.data?.items || []),
    }
  }

  async function downloadBatchToFolder(state) {
    const doneItems = normalizeBatchItems(state.items)
      .filter(item => item.status === 'SUCCESS' && item.urls.length > 0)
    if (doneItems.length === 0) {
      toast('本组还没有可下载的图片')
      return
    }

    let directoryHandle = null
    const canPickFolder = typeof window.showDirectoryPicker === 'function'
    if (canPickFolder) {
      directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
    }

    state.downloading = true
    renderBatchPanel(state)
    const usedNames = new Set()
    let savedCount = 0

    try {
      for (const item of doneItems) {
        for (const url of item.urls) {
          const resp = await fetch(`/api/script-assets/download-file?url=${encodeURIComponent(url)}`, {
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (!resp.ok) throw new Error(`${item.assetName} 下载失败`)
          const blob = await resp.blob()
          const ext = resp.headers.get('X-File-Extension') || extensionFromContentType(blob.type) || extensionFromUrl(url) || 'png'
          const fileName = uniqueFileName(item.assetName, ext, usedNames)

          if (directoryHandle) {
            const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true })
            const writable = await fileHandle.createWritable()
            await writable.write(blob)
            await writable.close()
          } else {
            const objectUrl = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = objectUrl
            link.download = fileName
            document.body.appendChild(link)
            link.click()
            link.remove()
            setTimeout(() => URL.revokeObjectURL(objectUrl), 15000)
          }
          savedCount += 1
        }
      }
      toast(directoryHandle ? `已保存 ${savedCount} 个资产到所选文件夹` : `浏览器不支持选择文件夹，已下载 ${savedCount} 个资产`, 3600)
    } finally {
      state.downloading = false
      renderBatchPanel(state)
    }
  }

  function renderBatchPanel(state) {
    const items = normalizeBatchItems(state.items)
    const total = Math.max(state.totalCount || items.length || 0, 0)
    const completed = items.filter(item => item.status === 'SUCCESS' && item.urls.length > 0).length
    const failed = items.filter(item => item.status === 'FAILED').length
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0
    state.metaEl.textContent = total > 0
      ? `已完成 ${completed} / ${total}${failed ? `，失败 ${failed}` : ''}`
      : '等待资产任务创建'
    state.barEl.style.width = `${Math.min(Math.max(percent, 0), 100)}%`
    state.downloadButton.textContent = state.downloading ? '下载中...' : '选择文件夹下载本组'
    state.downloadButton.disabled = state.downloading || completed === 0
  }

  function showBatchDownloadPanel({ batchId, tasks = [], totalCount = 0 }) {
    if (!batchId) return
    ensureStyles()
    const old = batchPanels.get(batchId)
    if (old?.panelEl) old.panelEl.remove()

    const panel = document.createElement('div')
    panel.className = 'wang-script-assets-batch-panel'
    const head = document.createElement('div')
    head.className = 'wang-script-assets-batch-head'
    const title = document.createElement('div')
    title.className = 'wang-script-assets-batch-title'
    title.textContent = '本组资产下载'
    const closeButton = document.createElement('button')
    closeButton.type = 'button'
    closeButton.className = 'wang-script-assets-batch-close'
    closeButton.textContent = '×'
    closeButton.setAttribute('aria-label', '关闭')
    head.appendChild(title)
    head.appendChild(closeButton)

    const body = document.createElement('div')
    body.className = 'wang-script-assets-batch-body'
    const meta = document.createElement('div')
    meta.className = 'wang-script-assets-batch-meta'
    const progress = document.createElement('div')
    progress.className = 'wang-script-assets-batch-progress'
    const bar = document.createElement('div')
    bar.className = 'wang-script-assets-batch-bar'
    progress.appendChild(bar)
    const actions = document.createElement('div')
    actions.className = 'wang-script-assets-batch-actions'
    const downloadButton = document.createElement('button')
    downloadButton.type = 'button'
    downloadButton.className = 'wang-script-assets-batch-download'
    downloadButton.textContent = '选择文件夹下载本组'
    actions.appendChild(downloadButton)
    body.appendChild(meta)
    body.appendChild(progress)
    body.appendChild(actions)
    panel.appendChild(head)
    panel.appendChild(body)
    document.body.appendChild(panel)

    const state = {
      batchId,
      panelEl: panel,
      metaEl: meta,
      barEl: bar,
      downloadButton,
      totalCount: totalCount || tasks.length,
      items: normalizeBatchItems(tasks),
      downloading: false,
      timer: null,
    }
    batchPanels.set(batchId, state)

    const refresh = async () => {
      try {
        const data = await fetchScriptAssetBatch(batchId)
        state.items = data.items
        state.totalCount = data.totalCount || state.totalCount || data.items.length
        renderBatchPanel(state)
        const allFinished = state.totalCount > 0 && state.items.length >= state.totalCount && state.items.every(item => item.status === 'SUCCESS' || item.status === 'FAILED')
        if (!allFinished && document.body.contains(panel)) {
          state.timer = setTimeout(refresh, 3500)
        }
      } catch {
        renderBatchPanel(state)
        if (document.body.contains(panel)) state.timer = setTimeout(refresh, 5000)
      }
    }

    closeButton.addEventListener('click', () => {
      if (state.timer) clearTimeout(state.timer)
      batchPanels.delete(batchId)
      panel.remove()
    })
    downloadButton.addEventListener('click', () => {
      downloadBatchToFolder(state).catch(err => {
        if (err?.name !== 'AbortError') toast(err.message || '批量下载失败', 4200)
        state.downloading = false
        renderBatchPanel(state)
      })
    })
    renderBatchPanel(state)
    refresh()
  }

  function setButtonBusy(button, busy, label = '打开中') {
    if (!button) return
    button.disabled = busy
    button.dataset.busy = busy ? 'true' : 'false'
    const labelEl = button.querySelector('.wang-script-assets-label')
    if (labelEl) labelEl.textContent = busy ? label : '根据剧本生成资产'
  }

  function setGroupBatchBusy(button, busy) {
    if (!button) return
    button.disabled = busy
    button.dataset.busy = busy ? 'true' : 'false'
    const labelEl = button.querySelector('.wang-group-batch-label')
    if (labelEl) labelEl.textContent = busy ? '生产中...' : '生产本组'
  }

  function textButton(text, className = 'wang-script-assets-secondary') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.textContent = text
    return button
  }

  function closeAssetModal(backdrop) {
    const target = backdrop || document.querySelector('.wang-script-assets-modal-backdrop')
    if (!target) return
    if (target.__wangScriptAssetsKeydown) {
      document.removeEventListener('keydown', target.__wangScriptAssetsKeydown, true)
    }
    target.remove()
  }

  function selectedAssetItems(state) {
    return state.items.filter(item => state.selectedIds.has(item.id))
  }

  function setModalError(state, message = '') {
    state.error = message
    updateModalControls(state)
  }

  function updateModalControls(state) {
    const selectedCount = selectedAssetItems(state).length
    state.modeButtons.forEach(button => {
      const active = button.dataset.value === state.renderMode
      button.classList.toggle('active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    })

    state.errorEl.textContent = state.error || ''
    state.errorEl.style.display = state.error ? 'block' : 'none'
    state.metaEl.textContent = state.items.length ? `已选择 ${selectedCount} / ${state.items.length}` : ''
    state.previewButton.textContent = state.previewLoading ? '清单生成中...' : state.items.length ? '重新生成清单' : '生成资产清单'
    state.createButton.textContent = state.createLoading ? '生成中...' : '生成选中资产'
    state.previewButton.disabled = state.previewLoading || state.createLoading
    state.createButton.disabled = state.previewLoading || state.createLoading || selectedCount === 0
    state.selectAllButton.disabled = state.previewLoading || state.createLoading || state.items.length === 0
    state.selectNoneButton.disabled = state.previewLoading || state.createLoading || state.items.length === 0
    state.closeButton.disabled = state.createLoading
    state.cancelButton.disabled = state.createLoading
    if (state.concurrencyInput) state.concurrencyInput.disabled = state.previewLoading || state.createLoading
  }

  function renderAssetItems(state) {
    state.listEl.innerHTML = ''
    if (state.previewLoading) {
      const empty = document.createElement('div')
      empty.className = 'wang-script-assets-empty'
      empty.textContent = '资产清单生成中...'
      state.listEl.appendChild(empty)
      updateModalControls(state)
      return
    }
    if (state.items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'wang-script-assets-empty'
      empty.textContent = '选择渲染风格后生成资产清单'
      state.listEl.appendChild(empty)
      updateModalControls(state)
      return
    }

    state.items.forEach(item => {
      const row = document.createElement('div')
      row.className = 'wang-script-assets-item'

      const input = document.createElement('input')
      input.type = 'checkbox'
      input.className = 'wang-script-assets-item-check'
      input.checked = state.selectedIds.has(item.id)
      input.addEventListener('change', () => {
        if (input.checked) state.selectedIds.add(item.id)
        else state.selectedIds.delete(item.id)
        updateModalControls(state)
      })

      const main = document.createElement('div')
      const head = document.createElement('div')
      head.className = 'wang-script-assets-item-head'

      const badge = document.createElement('span')
      badge.className = 'wang-script-assets-badge'
      badge.textContent = item.categoryLabel || '资产'

      const name = document.createElement('input')
      name.type = 'text'
      name.className = 'wang-script-assets-item-name'
      name.title = item.name || ''
      name.value = item.name || '未命名资产'
      name.addEventListener('input', () => {
        item.name = name.value
        name.title = name.value
      })

      const prompt = document.createElement('textarea')
      prompt.className = 'wang-script-assets-item-prompt'
      prompt.value = item.prompt || ''
      prompt.addEventListener('input', () => {
        item.prompt = prompt.value
      })

      head.appendChild(badge)
      head.appendChild(name)
      main.appendChild(head)
      main.appendChild(prompt)
      row.appendChild(input)
      row.appendChild(main)
      state.listEl.appendChild(row)
    })
    updateModalControls(state)
  }

  async function previewScriptAssets(state) {
    if (state.previewLoading || state.createLoading) return
    state.previewLoading = true
    state.error = ''
    state.items = []
    state.selectedIds = new Set()
    renderAssetItems(state)

    try {
      const resp = await fetch('/api/script-assets/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          sessionId: state.sessionId,
          workspaceId: state.sessionId,
          sourceNodeId: state.nodeId,
          script: state.script,
          renderMode: state.renderMode,
          maxTokens: 8192,
        }),
      })
      const json = await resp.json()
      if (!json?.success) throw new Error(json?.errMessage || json?.message || '资产清单生成失败')
      const items = Array.isArray(json?.data?.items) ? json.data.items : []
      if (items.length === 0) throw new Error('没有解析到可生成的资产')
      state.items = items.map((item, index) => ({
        ...item,
        id: item.id || `script_asset_item_${index + 1}`,
      }))
      state.selectedIds = new Set(state.items.map(item => item.id))
      renderAssetItems(state)
    } catch (err) {
      state.items = []
      state.selectedIds = new Set()
      renderAssetItems(state)
      setModalError(state, err.message || '资产清单生成失败')
    } finally {
      state.previewLoading = false
      renderAssetItems(state)
    }
  }

  async function createSelectedAssets(state) {
    if (state.previewLoading || state.createLoading) return
    const items = selectedAssetItems(state)
    if (items.length === 0) {
      setModalError(state, '请至少选择一个资产')
      return
    }

    const concurrencyLimit = normalizeConcurrencyLimit(state.concurrencyInput?.value)
    if (state.concurrencyInput) state.concurrencyInput.value = String(concurrencyLimit)
    state.createLoading = true
    state.error = ''
    updateModalControls(state)
    try {
      const resp = await fetch('/api/script-assets/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          sessionId: state.sessionId,
          workspaceId: state.sessionId,
          sourceNodeId: state.nodeId,
          renderMode: state.renderMode,
          items,
          aspectRatio: '16:9',
          size: '2K',
          quality: 'high',
          outputFormat: 'png',
          numImages: 1,
          concurrencyLimit,
        }),
      })
      const json = await resp.json()
      if (!json?.success) throw new Error(json?.errMessage || json?.message || '创建资产图片节点失败')
      const data = json.data || {}
      const nodeEvents = Array.isArray(data.nodeEvents) ? data.nodeEvents : []
      const nodes = Array.isArray(data.nodes) ? data.nodes : []
      const tasks = Array.isArray(data.tasks)
        ? data.tasks.filter(item => item?.nodeId && item?.taskId)
        : nodes.map(node => ({ nodeId: node.id, taskId: node.data?.taskId })).filter(item => item.nodeId && item.taskId)

      sessionNodesCache.fetchedAt = 0
      const emitted = emitImageNodes(nodeEvents)
      closeAssetModal(state.backdrop)
      if (!emitted && nodes.length > 0) {
        toast('资产节点已保存，刷新页面后可查看', 3200)
      } else {
        toast(`已创建 ${nodes.length} 个资产图片节点，并按并发 ${data.concurrencyLimit || concurrencyLimit} 分批生成`)
      }
      pollGeneratedImages(tasks)
      showBatchDownloadPanel({
        batchId: data.batchId,
        tasks,
        totalCount: nodes.length || tasks.length,
      })
    } catch (err) {
      setModalError(state, err.message || '创建资产图片节点失败')
    } finally {
      state.createLoading = false
      updateModalControls(state)
    }
  }

  function openAssetModal({ nodeId, sessionId, script }) {
    closeAssetModal()

    const backdrop = document.createElement('div')
    backdrop.className = 'wang-script-assets-modal-backdrop'

    const modal = document.createElement('div')
    modal.className = 'wang-script-assets-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')

    const header = document.createElement('div')
    header.className = 'wang-script-assets-modal-header'
    const title = document.createElement('div')
    title.className = 'wang-script-assets-modal-title'
    title.textContent = '根据剧本生成资产'
    const closeButton = document.createElement('button')
    closeButton.type = 'button'
    closeButton.className = 'wang-script-assets-modal-close'
    closeButton.setAttribute('aria-label', '关闭')
    closeButton.textContent = '×'
    header.appendChild(title)
    header.appendChild(closeButton)

    const body = document.createElement('div')
    body.className = 'wang-script-assets-modal-body'

    const modeSection = document.createElement('div')
    modeSection.className = 'wang-script-assets-section'
    const modeTitle = document.createElement('div')
    modeTitle.className = 'wang-script-assets-section-title'
    modeTitle.textContent = '渲染风格'
    const modeGroup = document.createElement('div')
    modeGroup.className = 'wang-script-assets-mode-group'

    const settingsSection = document.createElement('div')
    settingsSection.className = 'wang-script-assets-section'
    const settingsTitle = document.createElement('div')
    settingsTitle.className = 'wang-script-assets-section-title'
    settingsTitle.textContent = '生成设置'
    const settingsGrid = document.createElement('div')
    settingsGrid.className = 'wang-script-assets-settings-grid'
    const concurrencyField = document.createElement('label')
    concurrencyField.className = 'wang-script-assets-field'
    const concurrencyLabel = document.createElement('span')
    concurrencyLabel.className = 'wang-script-assets-field-label'
    concurrencyLabel.textContent = '并发数'
    const concurrencyInput = document.createElement('input')
    concurrencyInput.type = 'number'
    concurrencyInput.className = 'wang-script-assets-input'
    concurrencyInput.min = '1'
    concurrencyInput.step = '1'
    concurrencyInput.inputMode = 'numeric'
    concurrencyInput.placeholder = String(DEFAULT_CONCURRENCY_LIMIT)
    concurrencyInput.value = String(DEFAULT_CONCURRENCY_LIMIT)
    const concurrencyHint = document.createElement('span')
    concurrencyHint.className = 'wang-script-assets-field-hint'
    concurrencyHint.textContent = '默认 20，手动输入正整数，不限制上限'
    concurrencyField.appendChild(concurrencyLabel)
    concurrencyField.appendChild(concurrencyInput)
    concurrencyField.appendChild(concurrencyHint)
    settingsGrid.appendChild(concurrencyField)

    const previewSection = document.createElement('div')
    previewSection.className = 'wang-script-assets-section'
    const previewActions = document.createElement('div')
    previewActions.className = 'wang-script-assets-preview-actions'
    const previewMeta = document.createElement('div')
    previewMeta.className = 'wang-script-assets-modal-meta'
    previewMeta.textContent = '先生成清单，再选择资产'
    const previewButton = textButton('生成资产清单', 'wang-script-assets-primary')
    previewActions.appendChild(previewMeta)
    previewActions.appendChild(previewButton)

    const errorEl = document.createElement('div')
    errorEl.className = 'wang-script-assets-error'
    errorEl.style.display = 'none'

    const listSection = document.createElement('div')
    listSection.className = 'wang-script-assets-section'
    const toolbar = document.createElement('div')
    toolbar.className = 'wang-script-assets-list-toolbar'
    const metaEl = document.createElement('span')
    const listActions = document.createElement('div')
    listActions.className = 'wang-script-assets-list-actions'
    const selectAllButton = textButton('全选', 'wang-script-assets-link-btn')
    const selectNoneButton = textButton('全不选', 'wang-script-assets-link-btn')
    listActions.appendChild(selectAllButton)
    listActions.appendChild(selectNoneButton)
    toolbar.appendChild(metaEl)
    toolbar.appendChild(listActions)
    const listEl = document.createElement('div')
    listEl.className = 'wang-script-assets-list'
    listSection.appendChild(toolbar)
    listSection.appendChild(listEl)

    const footer = document.createElement('div')
    footer.className = 'wang-script-assets-modal-footer'
    const footerLeft = document.createElement('div')
    footerLeft.className = 'wang-script-assets-footer-left'
    const footerRight = document.createElement('div')
    footerRight.className = 'wang-script-assets-footer-right'
    const cancelButton = textButton('取消', 'wang-script-assets-secondary')
    const createButton = textButton('生成选中资产', 'wang-script-assets-primary')
    footerLeft.appendChild(document.createElement('span'))
    footerRight.appendChild(cancelButton)
    footerRight.appendChild(createButton)
    footer.appendChild(footerLeft)
    footer.appendChild(footerRight)

    body.appendChild(modeSection)
    modeSection.appendChild(modeTitle)
    modeSection.appendChild(modeGroup)
    body.appendChild(settingsSection)
    settingsSection.appendChild(settingsTitle)
    settingsSection.appendChild(settingsGrid)
    body.appendChild(previewSection)
    previewSection.appendChild(previewActions)
    body.appendChild(errorEl)
    body.appendChild(listSection)
    modal.appendChild(header)
    modal.appendChild(body)
    modal.appendChild(footer)
    backdrop.appendChild(modal)
    document.body.appendChild(backdrop)

    const state = {
      backdrop,
      nodeId,
      sessionId,
      script,
      renderMode: '插画',
      items: [],
      selectedIds: new Set(),
      error: '',
      previewLoading: false,
      createLoading: false,
      modeButtons: [],
      previewButton,
      createButton,
      closeButton,
      cancelButton,
      concurrencyInput,
      selectAllButton,
      selectNoneButton,
      errorEl,
      metaEl,
      listEl,
    }

    RENDER_MODES.forEach(mode => {
      const button = textButton(mode.label, 'wang-script-assets-mode')
      button.dataset.value = mode.value
      button.addEventListener('click', () => {
        if (state.previewLoading || state.createLoading) return
        state.renderMode = mode.value
        state.items = []
        state.selectedIds = new Set()
        state.error = ''
        renderAssetItems(state)
      })
      state.modeButtons.push(button)
      modeGroup.appendChild(button)
    })

    closeButton.addEventListener('click', () => {
      if (!state.createLoading) closeAssetModal(backdrop)
    })
    cancelButton.addEventListener('click', () => {
      if (!state.createLoading) closeAssetModal(backdrop)
    })
    backdrop.addEventListener('mousedown', event => {
      if (event.target === backdrop && !state.createLoading) closeAssetModal(backdrop)
    })
    const onKeydown = event => {
      if (event.key === 'Escape' && !state.createLoading) closeAssetModal(backdrop)
    }
    backdrop.__wangScriptAssetsKeydown = onKeydown
    document.addEventListener('keydown', onKeydown, true)

    previewButton.addEventListener('click', () => previewScriptAssets(state))
    createButton.addEventListener('click', () => createSelectedAssets(state))
    selectAllButton.addEventListener('click', () => {
      state.selectedIds = new Set(state.items.map(item => item.id))
      renderAssetItems(state)
    })
    selectNoneButton.addEventListener('click', () => {
      state.selectedIds = new Set()
      renderAssetItems(state)
    })

    renderAssetItems(state)
  }

  async function handleClick(event) {
    event.preventDefault()
    event.stopPropagation()
    const button = event.currentTarget
    const nodeEl = button.closest('.vue-flow__node-text')
    const nodeId = nodeIdFromElement(nodeEl)
    const sessionId = getSessionId()
    if (!nodeEl || !nodeId) {
      toast('没有识别到当前文本节点')
      return
    }
    if (activeRequests.has(nodeId)) return

    activeRequests.add(nodeId)
    setButtonBusy(button, true)
    try {
      const savedNode = await fetchSessionNode(sessionId, nodeId)
      const script = textFromDom(nodeEl) || textFromNodeData(savedNode)
      if (!script.trim()) throw new Error('请先在文本节点里填写剧本内容')
      openAssetModal({ nodeId, sessionId, script: script.trim() })
    } catch (err) {
      toast(err.message || '打开资产生成面板失败', 4200)
    } finally {
      activeRequests.delete(nodeId)
      setButtonBusy(button, false)
    }
  }

  function createButton() {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'wang-script-assets-btn'
    button.setAttribute(BUTTON_ATTR, '1')
    button.title = '根据剧本生成资产'
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v18"></path>
        <path d="M5 8h14"></path>
        <path d="M7 15h10"></path>
        <path d="M4 21h16"></path>
      </svg>
      <span class="wang-script-assets-label">根据剧本生成资产</span>
    `
    button.addEventListener('click', handleClick, true)
    return button
  }

  function createBatchDownloadButton(batchId) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'wang-script-assets-btn'
    button.setAttribute(BATCH_BUTTON_ATTR, '1')
    button.title = '下载同一批生成的资产'
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <path d="M7 10l5 5 5-5"></path>
        <path d="M12 15V3"></path>
      </svg>
      <span class="wang-script-assets-label">下载本组</span>
    `
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      showBatchDownloadPanel({ batchId })
    }, true)
    return button
  }

  async function handleGroupBatchClick(event) {
    event.preventDefault()
    event.stopPropagation()
    const button = event.currentTarget
    const nodeEl = button.closest('.vue-flow__node')
    const groupId = nodeIdFromElement(nodeEl)
    const sessionId = getSessionId()
    if (!groupId) {
      toast('没有识别到当前分组')
      return
    }
    if (activeGroupRequests.has(groupId)) return

    activeGroupRequests.add(groupId)
    setGroupBatchBusy(button, true)
    try {
      const resp = await fetch('/agent/story-canvas/group-batch-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          sessionId,
          workspaceId: sessionId,
          groupId,
          concurrencyLimit: DEFAULT_CONCURRENCY_LIMIT,
        }),
      })
      const json = await resp.json()
      if (!json?.success) throw new Error(json?.errMessage || json?.message || '本组批量生产失败')
      const data = json.data || {}
      const tasks = Array.isArray(data.tasks) ? data.tasks.filter(item => item?.taskId && item?.nodeId) : []
      const nodes = Array.isArray(data.nodes) ? data.nodes : []
      const skippedCount = Array.isArray(data.skipped) ? data.skipped.length : 0
      if (tasks.length === 0) {
        toast(skippedCount ? '本组没有可生产的图片节点，请检查提示词' : '本组没有可生产的图片节点', 3600)
        return
      }
      nodes.forEach(node => {
        if (node?.id && node?.data) updateNodeData(node.id, node.data, true)
      })
      sessionNodesCache.fetchedAt = 0
      pollGeneratedImages(tasks)
      toast(`已开始生产本组 ${tasks.length} 个图片节点${skippedCount ? `，跳过 ${skippedCount} 个` : ''}`, 3600)
    } catch (err) {
      toast(err.message || '本组批量生产失败', 4200)
    } finally {
      activeGroupRequests.delete(groupId)
      setGroupBatchBusy(button, false)
    }
  }

  function createGroupBatchButton() {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'wang-group-batch-btn'
    button.setAttribute(GROUP_BATCH_BUTTON_ATTR, '1')
    button.title = '批量生产本组内有提示词的图片节点'
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 3v18"></path>
        <path d="M19 3v18"></path>
        <path d="M8 6h8"></path>
        <path d="M8 12h8"></path>
        <path d="M8 18h8"></path>
      </svg>
      <span class="wang-group-batch-label">生产本组</span>
    `
    button.addEventListener('pointerdown', event => event.stopPropagation(), true)
    button.addEventListener('mousedown', event => event.stopPropagation(), true)
    button.addEventListener('click', handleGroupBatchClick, true)
    return button
  }

  function mountButton(nodeEl) {
    if (!nodeEl || nodeEl.querySelector(`[${BUTTON_ATTR}]`)) return
    const content = nodeEl.querySelector('.ai-node-content') || nodeEl.querySelector('.ai-node') || nodeEl
    const row = document.createElement('div')
    row.className = 'wang-script-assets-row'
    row.appendChild(createButton())
    content.appendChild(row)
  }

  async function mountBatchDownloadButton(nodeEl) {
    if (!nodeEl || nodeEl.querySelector(`[${BATCH_BUTTON_ATTR}]`)) return
    const nodeId = nodeIdFromElement(nodeEl)
    if (!nodeId) return
    if (nodeEl.dataset.wangScriptAssetsBatchChecked === nodeId) return
    nodeEl.dataset.wangScriptAssetsBatchChecked = nodeId
    const node = await fetchSessionNode(getSessionId(), nodeId)
    if (!node) {
      delete nodeEl.dataset.wangScriptAssetsBatchChecked
      return
    }
    const data = node?.data || {}
    const batchId = data.scriptAssetBatchId || ''
    if (!batchId || data.source !== 'script-asset-generator') return
    const content = nodeEl.querySelector('.ai-node-content') || nodeEl.querySelector('.ai-node') || nodeEl
    const row = document.createElement('div')
    row.className = 'wang-script-assets-row'
    row.appendChild(createBatchDownloadButton(batchId))
    content.appendChild(row)
  }

  async function mountGroupBatchButton(nodeEl) {
    if (!nodeEl || nodeEl.querySelector(`[${GROUP_BATCH_BUTTON_ATTR}]`)) return
    const nodeId = nodeIdFromElement(nodeEl)
    if (!nodeId) return
    if (nodeEl.dataset.wangGroupBatchChecked === nodeId) return
    nodeEl.dataset.wangGroupBatchChecked = nodeId
    const node = await fetchSessionNode(getSessionId(), nodeId)
    if (!node) {
      delete nodeEl.dataset.wangGroupBatchChecked
      return
    }
    if (node.type !== 'group') return
    nodeEl.appendChild(createGroupBatchButton())
  }

  function scan() {
    ensureStyles()
    document.querySelectorAll('.vue-flow__node-text').forEach(mountButton)
    document.querySelectorAll('.vue-flow__node').forEach(nodeEl => {
      mountGroupBatchButton(nodeEl)
      if (!nodeEl.classList.contains('vue-flow__node-text')) mountBatchDownloadButton(nodeEl)
    })
  }

  function start() {
    scan()
    const observer = new MutationObserver(scan)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    setInterval(scan, 1500)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
