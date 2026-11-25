window.__ModuleLoader__.load({
  id: 'dsh-codex-connect',
  factory: require => {
    const React = require('react')
    const { createElement: h, useEffect, useRef } = React
    const PROVIDER = 'openai-codex'
    const BRAND = '『羊先生』Codex'
    const MANAGE = '管理 ChatGPT 登录'
    const AUTH_KEY = 'llm-pi-ai/openai-codex'
    const PATH = '/api/dsh-codex-connect'
    const PINNED = '__dsh_codex_connect__'
    const PICKER = '[id$="-catalog-panel"] > div:first-child > select'
    const EDIT_LABELS = new Set(['编辑', '編輯', 'Edit', '編集', 'Editar', 'Modifier', 'Bearbeiten', 'Редактировать'])
    const labels = Object.freeze({
      UNSUPPORTED: '当前 Harness 没有兼容的内置 openai-codex 登录流程。',
      UNSAFE_ROUTE: '当前 openai-codex 有自定义地址、协议、密钥或请求头。请先恢复默认设置。',
      READ_ONLY: '当前模型设置只读。',
      CALLBACK_UNAVAILABLE: '本机授权回调不可用。请关闭占用 1455 端口的其他登录流程后重试。',
      TIMEOUT: '登录超时，请重试。',
      CANCELLED: '登录已取消。',
      UNSAFE_AUTH_URL: '登录地址与预期不符，已停止。',
      SIGN_IN_FAILED: '未完成登录。请回到浏览器确认授权，或检查网络后重试。',
      BUSY: '已有 Codex 登录或设置正在进行。',
      RETRY_SAVE: '未能保存模型提供商。可重试使用已有授权。',
      NOT_AUTHORIZED: '尚未授权，请先登录。',
      NO_ATTEMPT: '本次登录已结束，请重新打开连接器。',
      FORBIDDEN: '无法访问本机连接器。',
    })

    function officialUrl(raw) {
      try {
        if (typeof raw !== 'string' || raw.length > 4096) return null
        const u = new URL(raw)
        if (u.origin !== 'https://auth.openai.com' || u.pathname !== '/oauth/authorize'
            || u.username || u.password || u.hash
            || u.searchParams.get('redirect_uri') !== 'http://localhost:1455/auth/callback'
            || u.searchParams.get('response_type') !== 'code'
            || u.searchParams.get('code_challenge_method') !== 'S256') return null
        return u.href
      } catch { return null }
    }

    async function send(input, signal) {
      const res = await fetch(PATH, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-dsh-codex-connect': '1' },
        body: JSON.stringify(input), signal,
      })
      const result = await res.json()
      if (typeof result?.state !== 'string') throw new Error('not a connector response')
      return result
    }

    const buttonStyle = 'margin:0;font:inherit;padding:7px 12px;border:1px solid var(--dsw-alias-border-l2,#787878);border-radius:7px;background:transparent;color:inherit;cursor:pointer;text-decoration:none;'
    const launchStyle = buttonStyle + 'background:var(--dsw-alias-interactive-bg-hover,#80808022);'
    function placePicker(select, onOpen) {
      let previous = select.value
      let raw, initialRaw
      const marker = select.ownerDocument.createElement('option')
      marker.textContent = BRAND
      marker.value = PINNED

      function restoreRaw() {
        if (raw) {
          raw.hidden = initialRaw.hidden
          if (initialRaw.label === null) raw.removeAttribute('label')
          else raw.setAttribute('label', initialRaw.label)
        }
      }
      function update() {
        const options = Array.from(select.options)
        const original = options.find(option => option.value === PROVIDER)
        if (original !== raw) {
          restoreRaw()
          raw = original
          initialRaw = raw && { hidden: raw.hidden, label: raw.getAttribute('label') }
        }
        if (raw) {
          // Dormant stock entry is represented by the pinned option instead.
          // Never remove or reorder React-owned nodes.
          if (!raw.hidden) raw.hidden = true
          if (raw.getAttribute('label') !== BRAND) raw.setAttribute('label', BRAND)
        }
        if (select.firstElementChild !== marker) {
          // Preserve the controlled selection even when the injected option
          // becomes the browser's implicit first selection momentarily.
          const current = select.value
          select.prepend(marker)
          if (current && current !== PINNED) select.value = current
        }
        if (select.value !== PINNED && select.value) previous = select.value
      }
      function changed(event) {
        if (select.value !== PINNED && select.value !== PROVIDER) {
          previous = select.value
          return
        }
        event.stopImmediatePropagation()
        const valid = Array.from(select.options).filter(option => option !== marker)
        select.value = valid.some(option => option.value === previous)
          ? previous : valid.find(option => !option.hidden)?.value ?? valid[0]?.value ?? ''
        onOpen(select)
      }
      update()
      select.addEventListener('change', changed, true)
      return {
        update,
        dispose() {
          select.removeEventListener('change', changed, true)
          restoreRaw()
          marker.remove()
        },
      }
    }

    function attachPicker(root, onOpen) {
      const bindings = new Map()
      const refresh = () => {
        const present = new Set(root.querySelectorAll(PICKER))
        for (const [select, binding] of bindings) {
          if (!present.has(select)) { binding.dispose(); bindings.delete(select) }
        }
        for (const select of present) {
          const binding = bindings.get(select)
          if (binding) binding.update()
          else bindings.set(select, placePicker(select, onOpen))
        }
      }
      refresh()
      const observer = new MutationObserver(refresh)
      observer.observe(root, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        for (const binding of bindings.values()) binding.dispose()
      }
    }

    function bindLoginButton(row, onOpen) {
      let binding
      function update() {
        const buttons = row.firstElementChild?.lastElementChild
        const edit = Array.from(buttons?.children ?? []).find(node => {
          if (node === binding?.replacement || node.tagName !== 'BUTTON' || !EDIT_LABELS.has(node.textContent.trim())) return false
          const label = node.getAttribute('aria-label') ?? ''
          return label.endsWith(' ' + PROVIDER) || label.endsWith(' (' + PROVIDER + ')')
        })
        if (edit !== binding?.edit) {
          binding?.dispose()
          binding = undefined
          if (!edit || !buttons) return
          const prevHidden = edit.hidden
          const prevDisplay = edit.style.getPropertyValue('display')
          const prevPriority = edit.style.getPropertyPriority('display')
          const replacement = row.ownerDocument.createElement('button')
          replacement.type = 'button'
          replacement.title = '登录'
          replacement.textContent = '登录'
          replacement.setAttribute('aria-label', MANAGE)
          const open = () => onOpen(replacement, true)
          replacement.addEventListener('click', open)
          edit.hidden = true
          edit.style.setProperty('display', 'none', 'important')
          binding = {
            edit, replacement,
            dispose() {
              replacement.removeEventListener('click', open)
              replacement.remove()
              edit.hidden = prevHidden
              if (prevDisplay) edit.style.setProperty('display', prevDisplay, prevPriority)
              else edit.style.removeProperty('display')
            },
          }
        }
        if (binding) {
          const { replacement } = binding
          if (replacement.className !== edit.className) replacement.className = edit.className
          if (replacement.disabled !== edit.disabled) replacement.disabled = edit.disabled
          if (replacement.nextSibling !== edit) buttons.insertBefore(replacement, edit)
        }
      }
      update()
      const observer = new MutationObserver(update)
      observer.observe(row, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['disabled', 'class', 'aria-label'] })
      return () => { observer.disconnect(); binding?.dispose() }
    }

    function mountLoginBadge(row) {
      const doc = row.ownerDocument
      const indicator = doc.createElement('span')
      indicator.style.cssText = 'display:inline-flex;flex:none;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-success-primary);'
      const dot = doc.createElement('span')
      dot.style.cssText = 'box-sizing:border-box;display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-state-success-primary);'
      dot.setAttribute('aria-hidden', 'true')
      indicator.append(dot, '已登录')
      let visible = false
      function sync() {
        const identity = row.firstElementChild?.firstElementChild
        if (visible && identity?.tagName === 'SPAN') {
          if (indicator.parentElement !== identity) identity.append(indicator)
        } else {
          indicator.remove()
        }
      }
      const observer = new MutationObserver(sync)
      observer.observe(row, {childList:true,subtree:true})
      return {
        set(value) { visible = value === true; sync() },
        dispose() { observer.disconnect(); indicator.remove() },
      }
    }

    function followLogin(ctx, setVisible, request = send) {
      let current
      let closed = false
      const refresh = () => {
        if (closed) return
        current?.abort()
        const turn = new AbortController()
        current = turn
        void request({ action: 'status' }, turn.signal).then(result => {
          if (!turn.signal.aborted) setVisible(result.state === 'idle' && result.authorized === true)
        }, () => {
          if (!turn.signal.aborted) setVisible(false)
        })
      }
      const dispose = [
        ctx.remote.$on('credentials/record-updated', key => { if (key === AUTH_KEY) refresh() }),
        ctx.remote.$on('settings/document-updated', ns => { if (ns === 'llm-pi-ai') refresh() }),
        ctx.on('connection/reset', () => { setVisible(false); refresh() }),
      ]
      refresh()
      return () => {
        closed = true
        current?.abort()
        for (const unsubscribe of dispose) unsubscribe()
      }
    }

    function makeLauncher() {
      let openDialog

      function open(origin, manage = false) {
        if (openDialog) { openDialog.element.focus(); return }
        const stop = new AbortController()
        const element = document.createElement('dialog')
        element.setAttribute('aria-labelledby', 'dsh-codex-connect-dialog-title')
        element.style.cssText = 'box-sizing:border-box;width:min(460px,calc(100vw - 32px));padding:20px;border:1px solid var(--dsw-alias-border-l2,#787878);border-radius:12px;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font:inherit;box-shadow:0 12px 48px #0006;'
        const title = document.createElement('h2')
        title.id = 'dsh-codex-connect-dialog-title'
        title.textContent = manage ? MANAGE : BRAND
        title.style.cssText = 'font-size:18px;font-weight:650;margin:0 0 12px;'
        const status = document.createElement('p')
        status.setAttribute('role', 'status')
        status.style.cssText = 'font:inherit;line-height:1.55;margin:0 0 14px;overflow-wrap:anywhere;'
        const actions = document.createElement('div')
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;'
        const closeButton = document.createElement('button')
        closeButton.type = 'button'
        closeButton.autofocus = true
        closeButton.textContent = '关闭'
        closeButton.style.cssText = buttonStyle
        closeButton.addEventListener('click', () => element.close())
        element.append(title, status, actions)
        actions.append(closeButton)
        let attemptId
        let timeoutId
        let signature
        let closed = false

        function clearActions() {
          for (const node of [...actions.children]) if (node !== closeButton) node.remove()
        }

        function action(text, fn) {
          const control = document.createElement('button')
          control.type = 'button'
          control.style.cssText = launchStyle
          control.textContent = text
          control.addEventListener('click', fn, { once: true })
          actions.append(control)
        }

        function closing() {
          if (closed) return
          closed = true
          clearTimeout(timeoutId)
          stop.abort()
          if (attemptId) void send({ action: 'cancel', id: attemptId }).catch(() => {})
          element.remove()
          openDialog = undefined
          if (origin?.isConnected) origin.focus()
        }
        element.addEventListener('close', closing, { once: true })
        openDialog = { element, close: closing }

        function render(result) {
          if (closed) return
          const key = JSON.stringify([result.state, result.url, result.code, result.authorized, result.ready, result.writable])
          if (key === signature) return
          signature = key
          clearActions()
          closeButton.textContent = ['starting','browser'].includes(result.state) ? '取消登录' : '关闭'
          switch (result.state) {
            case 'idle':
              if (result.ready) {
                status.textContent = '已连接 ChatGPT。'
                if (result.writable) action('重新登录', () => { void start(true) })
              } else if (result.authorized) {
                status.textContent = '已登录 ChatGPT。'
                if (result.writable) action('使用已有授权', () => { void enable() })
              } else {
                status.textContent = result.writable ? '尚未登录 ChatGPT。' : labels.READ_ONLY
                if (result.writable) action('使用 ChatGPT 登录', () => { void start(false) })
              }
              break
            case 'starting':
              status.textContent = '正在准备登录…'
              break
            case 'browser': {
              status.textContent = '请在浏览器登录并授权，完成后会自动添加。'
              const url = officialUrl(result.url)
              if (!url) break
              const openLink = document.createElement('a')
              openLink.href = url
              openLink.target = '_blank'
              openLink.rel = 'noopener noreferrer'
              openLink.style.cssText = launchStyle
              openLink.textContent = '打开 OpenAI 授权页'
              actions.append(openLink)
              break
            }
            case 'saving':
              status.textContent = '正在保存模型提供商…'
              break
            case 'connected':
              status.textContent = '已连接。可在聊天框的模型菜单中选择 Codex。'
              closeButton.textContent = '完成'
              break
            default:
              status.textContent = Object.hasOwn(labels, result.code) ? labels[result.code] : '连接暂不可用。'
              action('重试', () => { void loadStatus() })
          }
        }

        async function loadStatus() {
          try { render(await send({ action: 'status' }, stop.signal)) }
          catch { render({ state: 'failed', code: 'UNAVAILABLE' }) }
        }

        async function enable() {
          render({ state: 'saving' })
          try {
            const result = await send({ action: 'enable' }, stop.signal)
            render(result.state === 'idle' && result.ready ? { state: 'connected' } : result)
          } catch { render({ state: 'failed', code: 'RETRY_SAVE' }) }
        }

        function handleAttempt(result) {
          if (closed) return
          render(result)
          if (['starting','browser','saving'].includes(result.state)) {
            timeoutId = setTimeout(() => { void poll() }, 850)
          } else attemptId = undefined
        }

        async function poll() {
          if (closed || !attemptId) return
          try { handleAttempt(await send({ action: 'poll', id: attemptId }, stop.signal)) }
          catch {
            if (closed) return
            const id = attemptId
            attemptId = undefined
            void send({action: 'cancel', id}).catch(() => {})
            render({ state: 'failed', code: 'UNAVAILABLE' })
          }
        }

        async function start(renew) {
          render({ state: 'starting' })
          const bytes = crypto.getRandomValues(new Uint8Array(16))
          attemptId = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
          try { handleAttempt(await send({ action: 'start', id: attemptId, renew }, stop.signal)) }
          catch {
            if (closed) return
            const id = attemptId
            attemptId = undefined
            void send({action: 'cancel', id}).catch(() => {})
            render({ state: 'failed', code: 'UNAVAILABLE' })
          }
        }

        document.body.appendChild(element)
        try { element.showModal() } catch { closing(); return }
        render({ state: 'starting' })
        closeButton.textContent = '关闭'
        void loadStatus()
      }

      return { open, close: () => { openDialog?.close() } }
    }

    function apply(ctx) {
      if (window.location.protocol !== 'dsh-app:') return
      const launcher = makeLauncher()
      function Footer() {
        const marker = useRef(null)
        useEffect(() => {
          const section = marker.current?.closest('[data-slot="settings.section"]')
          if (!section) return
          return attachPicker(section, launcher.open)
        }, [])
        return h('span', { hidden: true, ref: marker })
      }
      function ProviderCard({ provider, configured }) {
        const marker = useRef(null)
        useEffect(() => {
          const row = marker.current?.closest('li')
          if (!row) return
          const disposeButton = bindLoginButton(row, launcher.open)
          const badge = mountLoginBadge(row)
          const stop = followLogin(ctx, badge.set)
          return () => { stop(); badge.dispose(); disposeButton() }
        }, [provider?.provider, configured])
        return provider?.provider === PROVIDER && configured ? h('span', {hidden:true, ref:marker}) : null
      }
      ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
        name: 'settings.models.footer', id: 'dsh-codex-connect-provider-picker',
      }, Footer))
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card', key: 'llm-pi-ai',
      }, ProviderCard))
      ctx.effect(() => launcher.close)
    }

    return { apply, inject: ['slots', 'remote'], attachPicker, bindLoginButton, mountLoginBadge, followLogin }
  },
})
