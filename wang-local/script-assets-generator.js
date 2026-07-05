(function () {
  'use strict'

  const BUTTON_ATTR = 'data-script-assets-generate'
  const BUS_EVENT_CREATE_NODE = 'agent-create-node'
  const BUS_EVENT_UPDATE_NODE = 'update-node-data'
  const DEFAULT_SESSION_ID = 'demo'
  const RENDER_MODES = [
    { value: '插画', label: '插画' },
    { value: '3D', label: '3D' },
    { value: '真人', label: '真人' },
  ]
  const activeRequests = new Set()
  const pendingPolls = new Map()

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
      .wang-script-assets-item input {
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
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 600;
      }
      .wang-script-assets-item-prompt {
        max-height: 72px;
        overflow: auto;
        color: rgba(255, 255, 255, 0.7);
        font-size: 12px;
        line-height: 1.55;
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

  function nodeIdFromElement(nodeEl) {
    return nodeEl?.getAttribute('data-id') || nodeEl?.dataset?.id || ''
  }

  async function fetchSessionNode(sessionId, nodeId) {
    if (!sessionId || !nodeId) return null
    try {
      const resp = await fetch(`/agent/story-canvas/session/${encodeURIComponent(sessionId)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const json = await resp.json()
      const nodes = json?.data?.nodes || json?.nodes || []
      return Array.isArray(nodes) ? nodes.find(item => String(item.id || '') === String(nodeId)) || null : null
    } catch {
      return null
    }
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
          if (!target || !['SUCCESS', 'FAILED'].includes(status)) return
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

  function setButtonBusy(button, busy, label = '打开中') {
    if (!button) return
    button.disabled = busy
    button.dataset.busy = busy ? 'true' : 'false'
    const labelEl = button.querySelector('.wang-script-assets-label')
    if (labelEl) labelEl.textContent = busy ? label : '根据剧本生成资产'
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
      const row = document.createElement('label')
      row.className = 'wang-script-assets-item'

      const input = document.createElement('input')
      input.type = 'checkbox'
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

      const name = document.createElement('span')
      name.className = 'wang-script-assets-item-name'
      name.title = item.name || ''
      name.textContent = item.name || '未命名资产'

      const prompt = document.createElement('div')
      prompt.className = 'wang-script-assets-item-prompt'
      prompt.textContent = item.prompt || ''

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

      const emitted = emitImageNodes(nodeEvents)
      closeAssetModal(state.backdrop)
      if (!emitted && nodes.length > 0) {
        toast('资产节点已保存，刷新页面后可查看', 3200)
      } else {
        toast(`已创建 ${nodes.length} 个资产图片节点，并发送生成请求`)
      }
      pollGeneratedImages(tasks)
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

  function mountButton(nodeEl) {
    if (!nodeEl || nodeEl.querySelector(`[${BUTTON_ATTR}]`)) return
    const content = nodeEl.querySelector('.ai-node-content') || nodeEl.querySelector('.ai-node') || nodeEl
    const row = document.createElement('div')
    row.className = 'wang-script-assets-row'
    row.appendChild(createButton())
    content.appendChild(row)
  }

  function scan() {
    ensureStyles()
    document.querySelectorAll('.vue-flow__node-text').forEach(mountButton)
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
