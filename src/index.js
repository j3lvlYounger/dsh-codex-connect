import { createServer } from 'node:net'

export const name = 'dsh-codex-connect'
export const inject = ['connection', 'settings', 'credentials', 'authorization', 'llm']

const PATH = '/api/dsh-codex-connect'
const NS = 'llm-pi-ai'
const PROVIDER = 'openai-codex'
const KEY = NS + '/' + PROVIDER
const LABEL = '『羊先生』Codex'
const OFFICIAL = 'https://chatgpt.com/backend-api'
const CALLBACK = 'http://localhost:1455/auth/callback'
const LOGIN_LIMIT = 10 * 60_000
const ID = /^[0-9a-f]{32}$/
const noHeaders = h => h === undefined || (h !== null && typeof h === 'object' && Object.keys(h).length === 0)
const officialBase = url => url === undefined || url === OFFICIAL || url === OFFICIAL + '/'
const noWireOverrides = route => route != null && officialBase(route.baseURL)
  && route.api === undefined && route.apiKeyEnv === undefined && noHeaders(route.headers)

export function safeRoute(route) {
  if (route === undefined) return true
  if (!noWireOverrides(route)) return false
  const entries = [
    ...(Array.isArray(route.models) ? route.models : []),
    ...Object.values(route.modelOverrides ?? {}),
  ]
  // This release's model overrides cannot redirect an OAuth bearer. Still
  // verify wire overrides explicitly so a customized route fails closed.
  return entries.every(noWireOverrides)
}

export function validateAuthUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return undefined
  try {
    const url = new URL(raw)
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize'
        || url.username || url.password || url.hash) return undefined
    for (const [key, value] of [
      ['redirect_uri', CALLBACK], ['response_type', 'code'], ['code_challenge_method', 'S256'],
    ]) {
      if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) return undefined
    }
    for (const key of ['client_id', 'state', 'code_challenge']) {
      if (url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)) return undefined
    }
    if (['code', 'code_verifier', 'access_token', 'refresh_token', 'id_token'].some(k => url.searchParams.has(k))) return undefined
    return url.href
  } catch {
    return undefined
  }
}

function portAvailable() {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(1455, '127.0.0.1', () => server.close(error => resolve(!error)))
  })
}

class Refusal extends Error {
  constructor(code) { super(code); this.code = code }
}

function waitForCallback(signal, promptSignal) {
  const combined = promptSignal === undefined ? signal : AbortSignal.any([signal, promptSignal])
  return new Promise((_, reject) => {
    if (combined.aborted) reject(combined.reason)
    else combined.addEventListener('abort', () => reject(combined.reason), { once: true })
  })
}

const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
})

export function createConnector(ctx, options = {}) {
  const canListen = options.canListen ?? portAvailable
  const timeout = options.loginLimit ?? LOGIN_LIMIT
  let active
  let disposed = false
  let savingExisting = false

  function settingsState() {
    const entry = ctx.llm.listConfigurableProviders().find(item => item.provider === PROVIDER)
    if (entry?.settingsNs !== NS || entry.declared !== false || entry.nativeAuth?.oauth !== true
        || entry.defaultBaseURL !== OFFICIAL) throw new Refusal('UNSUPPORTED')
    if (!ctx.authorization.describe(KEY)?.methods?.some(m => m.id === 'oauth')) throw new Refusal('UNSUPPORTED')
    const document = ctx.settings.describe().find(row => row.ns === NS)
    if (!document) throw new Refusal('UNSUPPORTED')
    const route = document.value?.providers?.[PROVIDER]
    if (!safeRoute(route)) throw new Refusal('UNSAFE_ROUTE')
    return { document, route }
  }

  async function hasGrant() {
    const info = await ctx.credentials.describeRecord(KEY)
    return info.configured === true && info.kind === 'grant'
  }

  async function status() {
    const { route } = settingsState()
    const authorized = await hasGrant()
    const named = route?.displayName === LABEL
    return {
      state: 'idle', authorized, configured: route !== undefined, named,
      writable: ctx.settings.writable === true,
      ready: named && authorized,
    }
  }

  async function enable() {
    if (!ctx.settings.writable) throw new Refusal('READ_ONLY')
    if (!await hasGrant()) throw new Refusal('NOT_AUTHORIZED')
    for (let attempt = 0; attempt < 2; attempt++) {
      if (disposed) throw new Refusal('RETRY_SAVE')
      const { document, route } = settingsState()
      if (route?.displayName === LABEL) return
      const op = route === undefined
        ? { op: 'set', path: ['providers', PROVIDER], value: { displayName: LABEL } }
        : { op: 'set', path: ['providers', PROVIDER, 'displayName'], value: LABEL }
      try {
        await ctx.settings.mutate(NS, [op], document.revision)
        if (settingsState().route?.displayName !== LABEL) throw new Refusal('RETRY_SAVE')
        return
      } catch (error) {
        if (error?.code !== 'SETTINGS_CONFLICT' || attempt > 0) {
          throw error instanceof Refusal ? error : new Refusal('RETRY_SAVE')
        }
      }
    }
  }

  const busy = () => active && ['starting', 'browser', 'saving'].includes(active.state)
  function preview(attempt) {
    if (attempt.state === 'browser') return { state: attempt.state, url: attempt.url }
    return { state: attempt.state, ...(attempt.code ? { code: attempt.code } : {}) }
  }

  function abortAttempt(attempt, code) {
    attempt.code = code
    attempt.url = undefined
    attempt.controller.abort()
  }

  async function login(attempt, renew) {
    const signal = attempt.controller.signal
    try {
      settingsState()
      if (!ctx.settings.writable) throw new Refusal('READ_ONLY')
      if (!renew && await hasGrant()) {
        signal.throwIfAborted()
        attempt.state = 'saving'
        await enable()
        attempt.state = 'connected'
        return
      }
      const host = process.env.PI_OAUTH_CALLBACK_HOST
      if ((host && host !== '127.0.0.1') || !await canListen()) throw new Refusal('CALLBACK_UNAVAILABLE')
      signal.throwIfAborted()
      settingsState()
      const result = await ctx.authorization.begin({
        key: KEY,
        method: 'oauth',
        signal,
        interaction: {
          notify(notice) {
            if (signal.aborted || !notice.url) return
            const url = validateAuthUrl(notice.url)
            if (!url) { abortAttempt(attempt, 'UNSAFE_AUTH_URL'); return }
            attempt.url = url
            attempt.state = 'browser'
          },
          prompt(prompt) {
            if (signal.aborted) return Promise.reject(signal.reason)
            if (prompt.kind === 'select' && prompt.options.some(choice => choice.id === 'browser')) {
              return Promise.resolve('browser')
            }
            if (prompt.kind !== 'text') return Promise.reject(new Refusal('UNSUPPORTED'))
            // The official local callback is the only completion path. Never
            // accept a pasted URL, authorization code, token, or password.
            return waitForCallback(signal, prompt.signal)
          },
        },
      })
      attempt.url = undefined
      if (signal.aborted || result.status !== 'authorized') {
        attempt.state = attempt.code === 'CANCELLED' ? 'cancelled' : 'failed'
        attempt.code ??= 'SIGN_IN_FAILED'
        return
      }
      attempt.state = 'saving'
      await enable()
      attempt.state = 'connected'
    } catch (error) {
      attempt.state = attempt.code === 'CANCELLED' ? 'cancelled' : 'failed'
      attempt.code ??= error instanceof Refusal ? error.code : error?.code === 'ALREADY_IN_FLIGHT' ? 'BUSY' : 'SIGN_IN_FAILED'
    } finally {
      attempt.url = undefined
      clearTimeout(attempt.timer)
    }
  }

  async function fetch(request) {
    if (disposed || request.method !== 'POST' || request.headers.get('x-dsh-codex-connect') !== '1'
        || request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
      return json({ state: 'failed', code: 'FORBIDDEN' }, 403)
    }
    let input
    try {
      const raw = await request.text()
      if (raw.length > 1024) throw new Error()
      input = JSON.parse(raw)
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error()
    } catch {
      return json({ state: 'failed', code: 'BAD_REQUEST' }, 400)
    }
    try {
      if (input.action === 'status') return json(await status())
      if (input.action === 'enable') {
        if (busy() || savingExisting) throw new Refusal('BUSY')
        savingExisting = true
        try { await enable(); return json(await status()) }
        finally { savingExisting = false }
      }
      if (!['start', 'poll', 'cancel'].includes(input.action) || typeof input.id !== 'string' || !ID.test(input.id)) {
        return json({ state: 'failed', code: 'BAD_REQUEST' }, 400)
      }
      if (input.action === 'start') {
        if (busy() || savingExisting) throw new Refusal('BUSY')
        const attempt = { id: input.id, state: 'starting', controller: new AbortController() }
        active = attempt
        attempt.timer = setTimeout(() => abortAttempt(attempt, 'TIMEOUT'), timeout)
        void login(attempt, input.renew === true)
        return json(preview(attempt))
      }
      if (!active || active.id !== input.id) return json({ state: 'failed', code: 'NO_ATTEMPT' })
      if (input.action === 'cancel' && ['starting', 'browser'].includes(active.state)) abortAttempt(active, 'CANCELLED')
      return json(preview(active))
    } catch (error) {
      return json({ state: 'failed', code: error instanceof Refusal ? error.code : 'UNAVAILABLE' })
    }
  }

  function onSettingsChanged(namespace) {
    if (namespace !== NS || !active || !['starting', 'browser'].includes(active.state)) return
    const attempt = active
    queueMicrotask(() => {
      if (active !== attempt || attempt.controller.signal.aborted || !['starting','browser'].includes(attempt.state)) return
      try { settingsState() } catch (error) { abortAttempt(attempt, error instanceof Refusal ? error.code : 'UNAVAILABLE') }
    })
  }

  return {
    fetch, onSettingsChanged,
    dispose() {
      disposed = true
      if (active && busy()) abortAttempt(active, 'CANCELLED')
      if (active) clearTimeout(active.timer)
    },
  }
}

export function apply(ctx) {
  // Connection applies Host/Origin checks, authenticated browser credentials,
  // and owner-only exact-route policy before our handler. Never use the bare
  // webServer registry for an authorization surface.
  if (ctx.get('profileContext')?.name !== 'desktop' || ctx.connection.allowsRemoteAuthorities) return
  ctx.effect(() => {
    const api = createConnector(ctx)
    const off = ctx.connection.fetch.register({ path: PATH, methods: ['POST'], requestBody: 'buffered', fetch: api.fetch })
    const removeListener = ctx.on('settings/document-updated', api.onSettingsChanged)
    return async () => {
      api.dispose()
      removeListener()
      await off()
    }
  }, 'dsh-codex-connect: authenticated desktop authorization')
}
