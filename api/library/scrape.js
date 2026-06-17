// Vercel serverless: scrape Pinterest and store image URLs in the library index.
// Runs as a separate long-duration function so the 300 s limit applies instead
// of the 60 s cap on the main Express wrapper.
//
// On Vercel all functions share the same SLIDESMITH_DIR (/tmp/slidesmith) only
// within the SAME Lambda instance. Because this is a personal tool with a
// single active user, warm invocations almost always hit the same instance, so
// the index written here is visible to the main Express app immediately after.
import https from 'node:https'
import http from 'node:http'
import tls from 'node:tls'
import { addUrlImages } from '../../server/library.js'

const APIFY = 'https://api.apify.com/v2/acts'

// ── Proxy tunnel (mirrors server/library.js) ─────────────────────────────────

function buildAgent(proxyUrl) {
  if (!proxyUrl) return undefined
  const proxy = new URL(proxyUrl)
  const proxyIsHttps = proxy.protocol === 'https:'
  const agent = new https.Agent({ keepAlive: false })
  agent.createConnection = function (options, cb) {
    const proxyHeaders = {}
    if (proxy.username) {
      const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`
    }
    const req = (proxyIsHttps ? https : http).request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || (proxyIsHttps ? 443 : 8080),
      method: 'CONNECT',
      path: `${options.host}:${options.port || 443}`,
      headers: proxyHeaders,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return cb(new Error(`Proxy CONNECT failed: ${res.statusCode}`))
      const tlsSocket = tls.connect({ socket, servername: options.servername || options.host, rejectUnauthorized: options.rejectUnauthorized !== false })
      tlsSocket.on('secureConnect', () => cb(null, tlsSocket))
      tlsSocket.on('error', cb)
    })
    req.on('error', cb); req.end()
  }
  return agent
}

function httpsGet(url, headers, proxyUrl, timeout = 30_000) {
  const agent = buildAgent(proxyUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout fetching ${url}`)), timeout)
    function attempt(u, hops) {
      const t = new URL(u); const chunks = []
      const req = https.request({ hostname: t.hostname, port: t.port || 443, path: t.pathname + t.search, method: 'GET', headers: { ...headers, Host: t.hostname }, agent }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) { res.resume(); return attempt(new URL(res.headers.location, u).href, hops - 1) }
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => { clearTimeout(timer); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, buffer: Buffer.concat(chunks), headers: res.headers }) })
        res.on('error', (e) => { clearTimeout(timer); reject(e) })
      })
      req.on('error', (e) => { clearTimeout(timer); reject(e) }); req.end()
    }
    attempt(url, 3)
  })
}

function httpsPost(url, headers, body, proxyUrl, timeout = 30_000) {
  const agent = buildAgent(proxyUrl); const bodyBuf = Buffer.from(body)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout posting to ${url}`)), timeout)
    const t = new URL(url); const chunks = []
    const req = https.request({ hostname: t.hostname, port: t.port || 443, path: t.pathname + t.search, method: 'POST', headers: { ...headers, Host: t.hostname, 'Content-Length': String(bodyBuf.length) }, agent }, (res) => {
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { clearTimeout(timer); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, buffer: Buffer.concat(chunks), headers: res.headers }) })
      res.on('error', (e) => { clearTimeout(timer); reject(e) })
    })
    req.on('error', (e) => { clearTimeout(timer); reject(e) }); req.write(bodyBuf); req.end()
  })
}

// ── Pinterest URL helpers ─────────────────────────────────────────────────────

function pinImageUrls(items) {
  const list = Array.isArray(items) ? items : []
  const structured = new Set()
  for (const item of list) {
    if (item && typeof item === 'object') {
      if (item.type && item.type !== 'pin') continue
      const s = item?.media?.images
      const chosen = s?.original ?? s?.orig ?? s?.large ?? s?.medium ?? s?.small
      if (chosen?.url) structured.add(String(chosen.url).replace(/&amp;/g, '&'))
    }
  }
  if (structured.size) return [...structured]
  const blob = JSON.stringify(list)
  const matches = blob.match(/https?:\\?\/\\?\/[^"'\\\s]*pinimg\.com[^"'\\\s]*/gi) || []
  const cleaned = matches.map((u) => u.replace(/\\\//g, '/').replace(/&amp;/g, '&')).filter((u) => /\.(jpe?g|png|webp)/i.test(u))
  const originals = cleaned.filter((u) => /\/originals\//i.test(u))
  const byName = new Map()
  for (const u of [...originals, ...cleaned]) { const n = u.split('/').pop(); if (n && !byName.has(n)) byName.set(n, u) }
  return [...byName.values()]
}

// ── Apify path ────────────────────────────────────────────────────────────────

async function scrapeApify({ apiKey, actor, searches, count, proxy, onProgress }) {
  if (!apiKey) throw new Error('Missing Apify API key. Add it in Settings.')
  const queries = (searches || []).map((s) => s.trim()).filter(Boolean)
  if (!queries.length) throw new Error('Enter at least one Pinterest search.')
  const actorPath = (actor || 'fatihtahta/pinterest-scraper-search').replace('/', '~')
  const limit = Math.min(Math.max(Number(count) || 40, 10), 200)
  const pack = queries.join(', ')

  onProgress({ phase: 'search', message: `Running Apify actor for "${pack}"…` })
  const res = await fetch(`${APIFY}/${actorPath}/run-sync-get-dataset-items?token=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries, limit }),
    signal: AbortSignal.timeout(270_000),
  })
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Apify ${res.status}: ${t.slice(0, 160)}`) }
  const items = await res.json()
  const urls = pinImageUrls(items).slice(0, limit)
  if (!urls.length) throw new Error('No images found. Try a different search or actor.')

  onProgress({ phase: 'search', message: `Found ${urls.length} image${urls.length === 1 ? '' : 's'} — saving…` })
  const stamp = Date.now()
  const images = urls.map((url, i) => ({ id: `scraped:${stamp}-${i}`, remoteUrl: url, pack }))
  const { added } = addUrlImages(images)
  return { found: urls.length, added }
}

// ── Direct Pinterest path ─────────────────────────────────────────────────────

const CHROME_BUILDS = [
  { major: '124', build: '124.0.0.0', full: '124.0.6367.82' },
  { major: '130', build: '130.0.0.0', full: '130.0.6723.91' },
  { major: '135', build: '135.0.0.0', full: '135.0.6931.0' },
]
const MACOS_VERSIONS = ['14.2.1', '14.5.0', '15.0.0', '15.1.0']
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const randomHex = (n) => [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

function buildIdentity() {
  return { chrome: pick(CHROME_BUILDS), macosVer: pick(MACOS_VERSIONS), dpr: Math.random() > 0.6 ? '2' : '1', appVersion: randomHex(7), csrfToken: randomHex(32) }
}

async function bootstrapSession(proxy, identity) {
  const { chrome } = identity
  try {
    const res = await httpsGet('https://www.pinterest.com/', {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': `"Google Chrome";v="${chrome.major}", "Chromium";v="${chrome.major}", "Not)A;Brand";v="24"`,
      'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
      'user-agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.build} Safari/537.36`,
    }, proxy, 15_000)
    const list = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie'] || '']
    for (const c of list) { const m = c.match(/(?:^|;\s*)csrftoken=([^;]+)/); if (m) return m[1] }
  } catch {}
  return null
}

function buildPinHeaders(query, identity) {
  const { chrome, macosVer, dpr, appVersion, csrfToken } = identity
  const traceId = randomHex(16)
  return {
    accept: 'application/json, text/javascript, */*, q=0.01', 'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/x-www-form-urlencoded', cookie: `csrftoken=${csrfToken}`,
    origin: 'https://www.pinterest.com', priority: 'u=1, i', referer: 'https://www.pinterest.com/',
    'screen-dpr': dpr,
    'sec-ch-ua': `"Google Chrome";v="${chrome.major}", "Chromium";v="${chrome.major}", "Not)A;Brand";v="24"`,
    'sec-ch-ua-full-version-list': `"Google Chrome";v="${chrome.full}", "Chromium";v="${chrome.full}", "Not)A;Brand";v="24.0.0.0"`,
    'sec-ch-ua-mobile': '?0', 'sec-ch-ua-model': '""', 'sec-ch-ua-platform': '"macOS"', 'sec-ch-ua-platform-version': `"${macosVer}"`,
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
    'user-agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.build} Safari/537.36`,
    'x-app-version': appVersion, 'x-b3-flags': '0', 'x-b3-traceid': traceId, 'x-b3-parentspanid': traceId, 'x-b3-spanid': randomHex(16),
    'x-csrftoken': csrfToken, 'x-pinterest-appstate': 'active', 'x-pinterest-pws-handler': 'www/search/[scope].js',
    'x-pinterest-source-url': `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`, 'x-requested-with': 'XMLHttpRequest',
  }
}

async function fetchPinterestPage(query, proxy, identity, bookmark = null) {
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`
  const options = {
    query, scope: 'pins', appliedProductFilters: null, domains: null, user: null, seoDrawerEnabled: false,
    applied_unified_filters: null, auto_correction_disabled: false, journey_depth: null, source_id: null,
    source_module_id: null, source_url: sourceUrl, static_feed: false, selected_one_bar_modules: null,
    query_pin_sigs: null, page_size: null, price_max: null, price_min: null, query_image_pins: null,
    request_params: null, top_pin_ids: null, article: null, corpus: null, customized_rerank_type: null,
    filters: null, rs: 'typed', redux_normalize_feed: true, ...(bookmark ? { bookmarks: [bookmark] } : {}),
  }
  const body = new URLSearchParams({ source_url: sourceUrl, data: JSON.stringify({ options, context: {} }) }).toString()
  const res = await httpsPost('https://www.pinterest.com/resource/BaseSearchResource/get/', buildPinHeaders(query, identity), body, proxy, 30_000)
  if (!res.ok) throw new Error(`Pinterest returned HTTP ${res.status}. Add a proxy in Settings if you're being blocked.`)
  let data
  try { data = JSON.parse(res.buffer.toString()) } catch { throw new Error('Pinterest returned an unexpected response.') }
  const rr = data?.resource_response || {}
  const results = rr?.data?.results || []
  const nextBookmark = rr?.bookmark || null
  const urls = []
  for (const pin of results) {
    if (!pin || typeof pin !== 'object') continue
    if (pin.type && pin.type !== 'pin') continue
    const imgs = pin.images
    const img1 = imgs?.orig ?? imgs?.['736x'] ?? imgs?.['474x'] ?? imgs?.['236x']
    if (img1?.url) { urls.push(String(img1.url).replace(/&amp;/g, '&')); continue }
    const mImgs = pin.media?.images
    const img2 = mImgs?.original ?? mImgs?.orig ?? mImgs?.large ?? mImgs?.['736x']
    if (img2?.url) { urls.push(String(img2.url).replace(/&amp;/g, '&')); continue }
  }
  if (urls.length === 0 && results.length > 0) {
    const blob = JSON.stringify(results)
    const matches = blob.match(/https?:\\?\/\\?\/[^"'\\\s]*pinimg\.com[^"'\\\s]*/gi) || []
    const cleaned = matches.map((u) => u.replace(/\\\//g, '/').replace(/&amp;/g, '&')).filter((u) => /\.(jpe?g|png|webp)/i.test(u))
    const originals = cleaned.filter((u) => /\/originals\//i.test(u))
    const byName = new Map()
    for (const u of [...originals, ...cleaned]) { const n = u.split('/').pop(); if (n && !byName.has(n)) byName.set(n, u) }
    urls.push(...byName.values())
  }
  return { urls, bookmark: nextBookmark }
}

async function searchPins(query, limit, proxy, identity) {
  const collected = []; const seen = new Set(); let bookmark = null
  for (let page = 1; page <= 20 && collected.length < limit; page++) {
    let result
    try { result = await fetchPinterestPage(query, proxy, identity, bookmark) }
    catch (e) { if (page === 1) throw e; break }
    const { urls, bookmark: next } = result
    let added = 0
    for (const url of urls) { const name = url.split('/').pop()?.split('?')[0]; if (name && !seen.has(name)) { seen.add(name); collected.push(url); added++ } }
    if (added === 0 && !next) break
    bookmark = next || null
    if (collected.length < limit) await new Promise((r) => setTimeout(r, 300))
  }
  return collected.slice(0, limit)
}

async function scrapeDirect({ searches, count, proxy, onProgress }) {
  const queries = (searches || []).map((s) => s.trim()).filter(Boolean)
  if (!queries.length) throw new Error('Enter at least one Pinterest search.')
  const limit = Math.min(Math.max(Number(count) || 40, 1), 200)
  const pack = queries.join(', ')

  const identity = buildIdentity()
  const realToken = await bootstrapSession(proxy, identity)
  if (realToken) identity.csrfToken = realToken

  const perQuery = Math.ceil(limit / queries.length); const allUrls = []
  for (const query of queries) {
    onProgress({ phase: 'search', message: `Searching "${query}"…` })
    allUrls.push(...await searchPins(query, perQuery, proxy, identity))
  }

  const seen = new Set(); const deduped = []
  for (const u of allUrls) { const name = u.split('/').pop()?.split('?')[0]; if (name && !seen.has(name)) { seen.add(name); deduped.push(u) } }
  const finalUrls = deduped.slice(0, limit)
  if (!finalUrls.length) throw new Error('No images found. Try a different search or add a proxy in Settings.')

  onProgress({ phase: 'search', message: `Found ${finalUrls.length} image${finalUrls.length === 1 ? '' : 's'} — saving…` })
  const stamp = Date.now()
  const images = finalUrls.map((url, i) => ({ id: `scraped:${stamp}-${i}`, remoteUrl: url, pack }))
  const { added } = addUrlImages(images)
  return { found: finalUrls.length, added }
}

// ── SSE handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {} }
  const { searches, count } = req.body || {}

  // Read scrape config from the shared store (already loaded into /tmp on Vercel).
  let method = 'direct', proxy = '', actor = 'fatihtahta/pinterest-scraper-search', apiKey = ''
  try {
    const { getConfig } = await import('../../server/store.js')
    const cfg = getConfig()
    method = cfg.scrapeMethod || 'direct'
    proxy = cfg.proxy || ''
    actor = cfg.pinterestActor || actor
    apiKey = cfg.keys?.apify || ''
  } catch {}

  try {
    const scrape = method === 'apify' ? scrapeApify : scrapeDirect
    const result = await scrape({ searches, count, proxy, onProgress: send, ...(method === 'apify' ? { apiKey, actor } : {}) })
    send({ type: 'done', ...result })
  } catch (e) {
    console.error('[library/scrape]', e)
    send({ type: 'error', message: e.message || String(e) })
  }
  res.end()
}
