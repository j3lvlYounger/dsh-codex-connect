import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {runInNewContext} from 'node:vm'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const ID = '__dsh_codex_connect__'
const LABEL = '『羊先生』Codex'
function mount(initial, chosen) {
  let exported, observer, domChanged, opened = 0
  const listeners = new Map()
  const select = {
    children: [], value: chosen,
    get options() {return this.children},
    get firstElementChild() {return this.children[0]},
    prepend(option) {option.parent = this; this.children = [option, ...this.children.filter(o=>o !== option)]},
    addEventListener(type, fn, capture) { assert.equal(capture,true); listeners.set(type,fn) },
    removeEventListener(type, fn, capture) { assert.equal(capture,true); if (listeners.get(type)===fn) listeners.delete(type) },
    ownerDocument: { createElement: () => option() },
  }
  function option(value) {
    return {
      value, hidden:false, label:null, parent:select,
      getAttribute(k) {return this[k]}, setAttribute(k,v) {this[k]=v}, removeAttribute(k) {this[k]=null},
      remove() {this.parent.children = this.parent.children.filter(o=>o!==this)},
    }
  }
  select.children = initial.map(option)
  let found = [select]
  const root = { querySelectorAll: selector => {
    assert.equal(selector,'[id$="-catalog-panel"] > div:first-child > select')
    return found
  } }
  const window = {__ModuleLoader__:{load:(reg)=>{exported=reg.factory(()=>({}))}}}
  class MutationObserver {
    constructor(fn) {domChanged=fn; observer=this}
    observe() {}
    disconnect(){this.closed=true}
  }
  runInNewContext(source,{window, MutationObserver})
  const dispose = exported.attachPicker(root, origin=>{opened++; assert.equal(origin,select)})
  return {select, removed:()=>{found=[];domChanged()}, shake:()=>domChanged(), opened:()=>opened, dispose:()=>{dispose();assert.equal(observer.closed,true)},
    pick(v){select.value=v; let interrupted=false; listeners.get('change')?.({stopImmediatePropagation(){interrupted=true}});return interrupted},
  }
}
test('branded option is first, native choices and selection remain intact',()=>{
  const fake = mount(['anthropic','openai-codex','amazon-bedrock','openai'],'anthropic')
  const {select}=fake
  assert.deepEqual(select.options.map(o=>o.value),[ID,'anthropic','openai-codex','amazon-bedrock','openai'])
  assert.equal(select.options[0].textContent,LABEL)
  assert.equal(select.options[2].hidden,true)
  assert.equal(select.value,'anthropic')
  assert.equal(fake.pick('openai'),false)
  assert.equal(fake.pick(ID),true)
  assert.equal(fake.opened(),1)
  assert.equal(select.value,'openai')
  fake.shake()
  assert.equal(select.options.filter(o=>o.value===ID).length,1)
  fake.dispose()
  assert.deepEqual(select.options.map(o=>o.value),['anthropic','openai-codex','amazon-bedrock','openai'])
  assert.equal(select.options[1].hidden,false)
  assert.equal(select.options[1].label,null)
})
test('configured provider can still be managed from the first picker entry',()=>{
 const fake = mount(['anthropic','openai'],'openai')
 assert.equal(fake.select.options[0].value,ID)
 assert.equal(fake.pick(ID),true)
 assert.equal(fake.select.value,'openai')
 fake.removed()
 assert.equal(fake.select.options[0].value,'anthropic')
 assert.equal(fake.pick(ID),false)
 fake.dispose()
})

test('only Codex Edit is replaced by Login; original Delete and cleanup are untouched',()=>{
  let exported
  class MutationObserver {
    constructor(fn) { this.trigger = fn; mutation = this }
    observe() {}
    disconnect() { this.closed = true }
  }
  let mutation
  runInNewContext(source, {window:{__ModuleLoader__:{load:reg=>{exported=reg.factory(()=>({}))}}}, MutationObserver})
  const group = {
    children: [],
    insertBefore(node, pivot) {
      this.children = this.children.filter(x=>x!==node)
      this.children.splice(this.children.indexOf(pivot),0,node)
      node.parent = this
    },
  }
  function button(text, label) {
    const values = new Map(), classes = new Map([['aria-label',label]]), events = new Map()
    return {
      tagName:'BUTTON', textContent:text, className:'native-button', hidden:false, disabled:false, events,
      get nextSibling() {const i=group.children.indexOf(this); return i===-1 ? null : group.children[i+1] ?? null},
      getAttribute:k=>classes.get(k)??null, setAttribute:(k,v)=>classes.set(k,v),
      style:{getPropertyValue:k=>values.get(k)?.[0]??'', getPropertyPriority:k=>values.get(k)?.[1]??'', setProperty:(k,v,p)=>values.set(k,[v,p]),removeProperty:k=>values.delete(k)},
      addEventListener:(k,v)=>events.set(k,v), removeEventListener:k=>events.delete(k),
      remove() {group.children=group.children.filter(x=>x!==this)},
    }
  }
  const edit=button('编辑','编辑 『羊先生』Codex (openai-codex)')
  const del=button('删除','删除 『羊先生』Codex (openai-codex)')
  group.children=[edit,del]
  const row={firstElementChild:{lastElementChild:group},ownerDocument:{createElement:()=>button('','')}}
  let clicked
  const dispose=exported.bindLoginButton(row,(trigger,mode)=>{clicked=[trigger,mode]})
  const login=group.children[0]
  assert.equal(login.textContent,'登录')
  assert.equal(login.title,'登录')
  assert.equal(login.getAttribute('aria-label'),'登录 OpenAI')
  assert.equal(login.className,edit.className)
  assert.equal(edit.hidden,true)
  assert.equal(del.hidden,false)
  login.events.get('click')()
  assert.deepEqual(clicked,[login,true])
  edit.disabled=true
  mutation.trigger()
  assert.equal(login.disabled,true)
  dispose()
  assert.deepEqual(group.children,[edit,del])
  assert.equal(edit.hidden,false)
  assert.equal(edit.style.getPropertyValue('display'),'')
  assert.equal(mutation.closed,true)
  group.children=[del]
  const absent=exported.bindLoginButton(row,()=>assert.fail('must not replace Delete'))
  assert.deepEqual(group.children,[del])
  absent()
})

test('login badge matches the account row; only a confirmed grant adds it beside the name',()=>{
  let exported
  const window={__ModuleLoader__:{load:reg=>{exported=reg.factory(()=>({}))}}}
  let observer
  class MutationObserver {
    constructor(fn){this.refresh=fn;observer=this}
    observe(){}
    disconnect(){this.closed=true}
  }
  runInNewContext(source,{window,MutationObserver})
  function span() {
    return {tagName:'SPAN',items:[],style:{},attrs:{},
      setAttribute(k,v){this.attrs[k]=v},
      append(...ns){for(const n of ns){
        if(typeof n!=='string'){n.remove();n.parentElement=this}
        this.items.push(n)
      }},
      remove(){const p=this.parentElement;if(p){p.items=p.items.filter(n=>n!==this);this.parentElement=null}},
    }
  }
  const identity=span()
  identity.append('『羊先生』Codex')
  const row={firstElementChild:{firstElementChild:identity},ownerDocument:{createElement:span}}
  const badge=exported.mountLoginBadge(row)
  badge.set(false)
  assert.equal(identity.items.length,1)
  badge.set(true)
  const indicator=identity.items[1]
  assert.equal(indicator.items[1],'已登录')
  assert.match(indicator.items[0].style.cssText,/width:8px;height:8px/)
  assert.match(indicator.style.cssText,/state-success-primary/)
  observer.refresh()
  assert.equal(identity.items.length,2)
  badge.set(false)
  assert.equal(identity.items.length,1)
  badge.set(true)
  badge.dispose()
  assert.equal(identity.items.length,1)
})

test('credential refresh hides cleared state and ignores an older result',async()=>{
  let exported
  const window={__ModuleLoader__:{load:reg=>{exported=reg.factory(()=>({}))}}}
  runInNewContext(source,{window,AbortController})
  const callbacks=new Map(), requests=[], states=[]
  const bind=(key,fn)=>{callbacks.set(key,fn);return ()=>callbacks.delete(key)}
  const off=exported.followLogin({remote:{$on:bind},on:bind}, s=>states.push(s), (input,signal)=>
    new Promise(resolve=>requests.push({input,signal,resolve})))
  callbacks.get('credentials/record-updated')('llm-pi-ai/unrelated')
  assert.equal(requests.length,1)
  callbacks.get('credentials/record-updated')('llm-pi-ai/openai-codex')
  assert.equal(requests.length,2)
  assert.equal(requests[0].signal.aborted,true)
  requests[0].resolve({state:'idle',authorized:false})
  requests[1].resolve({state:'idle',authorized:true})
  await Promise.resolve()
  assert.deepEqual(states,[true])
  callbacks.get('credentials/record-updated')('llm-pi-ai/openai-codex')
  requests[2].resolve({state:'idle',authorized:false})
  await Promise.resolve()
  assert.deepEqual(states,[true,false])
  off()
  assert.equal(callbacks.size,0)
})

const authorize = 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&code_challenge_method=S256&client_id=test&state=test&code_challenge=test'

function loginDialog(replies, openThrows = false) {
  let exported
  const launched = [], requests = [], timers = new Map()
  class Element {
    constructor() { this.children = []; this.style = {}; this.listeners = {} }
    setAttribute() {}
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item) } }
    appendChild(item) { this.append(item) }
    remove() { this.parent.children = this.parent.children.filter(item => item !== this) }
    addEventListener(type, fn) { this.listeners[type] = fn }
    showModal() {}
    click() { this.listeners.click() }
  }
  const window = {
    __ModuleLoader__: {load: reg => { exported = reg.factory(() => ({})) }},
    open(...args) {
      launched.push(args)
      if (openThrows) throw new Error('browser unavailable')
    },
  }
  const body = new Element()
  runInNewContext(source, {
    window, document: {body, createElement: () => new Element()},
    AbortController, URL, crypto: {getRandomValues: bytes => bytes},
    setTimeout: fn => { const token = Symbol(); timers.set(token, fn); return token },
    clearTimeout: token => timers.delete(token),
    fetch: async (_, request) => {
      requests.push(JSON.parse(request.body))
      const result = replies.shift()
      return {json: async () => result}
    },
  })
  const launcher = exported.makeLauncher()
  launcher.open(null, true)
  const [title, status, actions] = body.children[0].children
  return {
    title, status, actions, launched, requests,
    action: label => actions.children.find(node => node.textContent === label),
    settle: () => new Promise(resolve => setImmediate(resolve)),
    tick() { const [token, fn] = timers.entries().next().value; timers.delete(token); fn() },
  }
}

test('relogin launches the official browser once and reports success after authorization', async () => {
  const dialog = loginDialog([
    {state: 'idle', ready: true, writable: true},
    {state: 'starting'},
    {state: 'browser', url: authorize},
    {state: 'browser', url: authorize},
    {state: 'connected'},
  ])
  await dialog.settle()
  assert.equal(dialog.title.textContent, '登录 OpenAI')
  assert.equal(dialog.status.textContent, '已登录 OpenAI')
  dialog.action('重新登录').click()
  await dialog.settle()
  assert.equal(dialog.requests[1].renew, true)
  assert.deepEqual(dialog.launched, [])
  dialog.tick()
  await dialog.settle()
  assert.equal(dialog.status.textContent, '请在浏览器登录并授权')
  assert.equal(dialog.action('登录 OpenAI').href, authorize)
  assert.deepEqual(dialog.launched, [[authorize, '_blank', 'noopener,noreferrer']])
  dialog.tick()
  await dialog.settle()
  assert.equal(dialog.launched.length, 1)
  dialog.tick()
  await dialog.settle()
  assert.equal(dialog.status.textContent, '登录成功')
})

test('automatic relogin keeps the fallback link and rejects non-OpenAI destinations', async () => {
  for (const url of [authorize, authorize.replace('auth.openai.com', 'untrusted.invalid')]) {
    const dialog = loginDialog([
      {state: 'idle', ready: true, writable: true},
      {state: 'browser', url},
    ], true)
    await dialog.settle()
    dialog.action('重新登录').click()
    await dialog.settle()
    assert.equal(dialog.launched.length, url === authorize ? 1 : 0)
    assert.equal(dialog.action('登录 OpenAI')?.href, url === authorize ? authorize : undefined)
  }
})

test('first login keeps the explicit browser link', async () => {
  const dialog = loginDialog([
    {state: 'idle', writable: true},
    {state: 'browser', url: authorize},
  ])
  await dialog.settle()
  dialog.action('登录 OpenAI').click()
  await dialog.settle()
  assert.equal(dialog.requests[1].renew, false)
  assert.equal(dialog.action('登录 OpenAI').href, authorize)
  assert.equal(dialog.launched.length, 0)
})
