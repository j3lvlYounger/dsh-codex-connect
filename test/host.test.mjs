import assert from 'node:assert/strict'
import test from 'node:test'
import { createConnector, safeRoute, validateAuthUrl } from '../src/index.js'

const authURL = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=local-fixture&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=fixture&code_challenge_method=S256&state=fixture'
const LABEL = '『羊先生』Codex'
const attempt = 'a'.repeat(32)
function fixture(initial, hasGrant) {
  let route = initial
  let authorized = hasGrant
  let login, loginCount = 0, revision = 7
  const writes = []
  const ctx = {
    llm: { listConfigurableProviders: () => [{
      provider: 'openai-codex', settingsNs: 'llm-pi-ai', declared: false,
      nativeAuth: { oauth: true }, defaultBaseURL: 'https://chatgpt.com/backend-api',
    }] },
    settings: {
      writable: true,
      describe: () => [{ns:'llm-pi-ai', revision, value: {providers: {'openai-codex': route}}}],
      async mutate(ns, [op], expected) {
        assert.equal(ns, 'llm-pi-ai')
        assert.equal(expected, revision++)
        writes.push(op)
        if (op.path.length === 3) route = {...route, displayName: op.value}
        else route = op.value
      },
    },
    credentials: { describeRecord: async () => authorized ? { configured: true, kind: 'grant' } : { configured: false } },
    authorization: {
      describe: () => ({ methods: [{ id: 'oauth' }] }),
      async begin({ interaction, signal, key, method }) {
        loginCount++
        assert.equal(key, 'llm-pi-ai/openai-codex')
        assert.equal(method, 'oauth')
        const methodChoice = await interaction.prompt({kind: 'select', options: [{id:'browser'}, {id:'device_code'}]})
        assert.equal(methodChoice, 'browser')
        interaction.notify({url: authURL})
        return new Promise(resolve => {
          login = () => { authorized = true; resolve({status:'authorized'}) }
          signal.addEventListener('abort', () => resolve({status:'cancelled'}), {once:true})
        })
      },
    },
  }
  const connector = createConnector(ctx, {canListen: async () => true})
  async function ask(action, extra, authenticated = true) {
    const response = await connector.fetch(new Request('http://127.0.0.1/api/dsh-codex-connect', {
      method:'POST', headers: {'content-type':'application/json', ...(authenticated ? {'x-dsh-codex-connect':'1'} : {})},
      body: JSON.stringify({action,...extra}),
    }))
    return response.json()
  }
  return { ctx, ask, writes, connector, complete: () => login(), loginCount: () => loginCount, route: () => route }
}

test('status only discloses credential existence; existing grant is reused without a new login', async () => {
  const f = fixture({reasoning:'high'}, true)
  assert.deepEqual(await f.ask('status'), {state:'idle', authorized:true, configured:true, named:false, writable:true, ready:false})
  assert.equal((await f.ask('enable')).ready, true)
  assert.equal(f.loginCount(), 0)
  assert.deepEqual(f.writes, [{op:'set', path:['providers','openai-codex','displayName'], value:LABEL}])
  assert.deepEqual(f.route(), {reasoning:'high',displayName:LABEL})
  f.connector.dispose()
})

test('fresh flow uses OAuth link, activates only after authorization', async () => {
  const f = fixture(undefined, false)
  try {
    assert.equal((await f.ask('enable')).code, 'NOT_AUTHORIZED')
    await f.ask('start',{id:attempt})
    const pending = await f.ask('poll',{id:attempt})
    assert.equal(pending.state, 'browser')
    assert.equal(pending.url, authURL)
    assert.equal((await f.ask('poll',{id:'b'.repeat(32)})).code,'NO_ATTEMPT')
    assert.equal(f.writes.length,0)
    f.complete()
    assert.deepEqual(await f.ask('poll',{id:attempt}), {state:'connected'})
    assert.deepEqual(f.writes, [{op:'set',path:['providers','openai-codex'],value:{displayName:LABEL}}])
  } finally { f.connector.dispose() }
})

test('cancel does not add a provider', async () => {
  const f = fixture(undefined, false)
  try {
    await f.ask('start',{id:attempt})
    await f.ask('cancel',{id:attempt})
    assert.equal((await f.ask('poll',{id:attempt})).state,'cancelled')
    assert.equal(f.writes.length,0)
  } finally { f.connector.dispose() }
})

test('origin and transport constraints fail closed', async () => {
  assert.equal(validateAuthUrl(authURL),authURL)
  for (const url of [
    authURL.replace('auth.openai.com','auth.openai.com.example.com'),
    authURL.replace('1455','1456'), authURL+'&redirect_uri=https://example.com',
    authURL+'&code_verifier=bad', authURL+'#not-allowed',
  ]) assert.equal(validateAuthUrl(url), undefined)
  for (const route of [{ apiKeyEnv:'OPENAI_API_KEY' }, { baseURL:'https://proxy.invalid/v1' },
                       { headers:{bad:'x'} }, { models:[{id:'bad',api:'openai-responses'}]}]) assert.equal(safeRoute(route),false)
  const f = fixture({baseURL:'https://proxy.invalid/v1'}, true)
  assert.equal((await f.ask('status')).code,'UNSAFE_ROUTE')
  assert.equal((await f.ask('enable',{},false)).code,'FORBIDDEN')
  assert.equal(f.writes.length,0)
  f.connector.dispose()
})
