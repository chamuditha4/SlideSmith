// Image library: bundled aesthetic packs (shipped in public/library/) plus
// images scraped from Pinterest. Two scraping methods are supported:
//   direct — hits Pinterest's internal API directly, optional HTTP proxy
//   apify  — runs an Apify actor; requires an Apify API key
// Scraped images are downloaded to ~/.slidesmith/library/ so the browser can
// composite them onto the export canvas same-origin (remote URLs taint it).
import { homedir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { logger } from './log.js'
import { syncToBlob } from './blobSync.js'

const log = logger('scrape')
const __dirname = dirname(fileURLToPath(import.meta.url))
const DIR = process.env.SLIDESMITH_DIR || join(homedir(), '.slidesmith')
const MEDIA_DIR = join(DIR, 'library')
const INDEX_PATH = join(DIR, 'library.json')
const BUNDLED_MANIFEST = join(__dirname, '..', 'public', 'library', 'manifest.json')

function ensure() {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true })
}
function readJson(p, fb) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fb }
}

// Flatten the bundled manifest into image records the UI can render.
function bundled() {
  const m = readJson(BUNDLED_MANIFEST, { packs: [] })
  return (m.packs || []).flatMap((pack) =>
    (pack.images || []).map((path) => ({
      id: `bundled:${path}`,
      url: `/library/${path}`,
      pack: pack.name,
      source: 'bundled',
    }))
  )
}

// Names of the bundled aesthetic packs (used as the default selection for new projects).
export function bundledPackNames() {
  const m = readJson(BUNDLED_MANIFEST, { packs: [] })
  return (m.packs || []).map((p) => p.name)
}

function scrapedIndex() {
  return readJson(INDEX_PATH, [])
}

// Recover image files on disk that aren't in the index (e.g. if the index was
// emptied or drifted). Re-indexes them with stable ids matching the original
// scheme so nothing is silently orphaned.
function reconcileOrphans() {
  const index = scrapedIndex()
  if (!existsSync(MEDIA_DIR)) return index
  const known = new Set(index.map((s) => s.file))
  let changed = false
  for (const file of readdirSync(MEDIA_DIR)) {
    if (!/\.(jpe?g|png|webp)$/i.test(file) || known.has(file)) continue
    index.push({ id: `scraped:${file.replace(/\.[^.]+$/, '')}`, file, pack: 'Scraped', addedAt: new Date().toISOString() })
    changed = true
  }
  if (changed) writeJson(INDEX_PATH, index)
  return index
}

export function listLibrary() {
  // Reconcile first so orphaned disk files are re-indexed rather than silently lost.
  const scraped = reconcileOrphans()
    .filter((s) => {
      if (s.blobUrl) return true                            // Vercel Blob (persistent CDN)
      if (s.remoteUrl && !s.file) return true               // URL-only proxy fallback
      return s.file && existsSync(join(MEDIA_DIR, s.file))  // local file
    })
    .map((s) => ({
      id: s.id,
      // Blob-stored images are served directly from Vercel's CDN — no proxy needed.
      url: s.blobUrl || `/api/library/img/${encodeURIComponent(s.id)}`,
      pack: s.pack || 'Scraped',
      source: 'scraped',
    }))
  // Scraped first (newest), then the bundled packs.
  return [...scraped, ...bundled()]
}

// Group the library into packs with a few cover thumbnails each (for the
// pack-picker UIs in Generate + Settings).
export function listPacks() {
  const map = new Map()
  for (const img of listLibrary()) {
    if (!map.has(img.pack)) map.set(img.pack, { name: img.pack, source: img.source, count: 0, covers: [] })
    const p = map.get(img.pack)
    p.count++
    if (p.covers.length < 4) p.covers.push(img.url)
  }
  return [...map.values()]
}

export function getScrapedFile(id) {
  const rec = scrapedIndex().find((s) => s.id === id)
  if (!rec || !rec.file) return null
  const p = join(MEDIA_DIR, rec.file)
  return existsSync(p) ? p : null
}

// Returns the remote Pinterest URL for URL-only entries (Vercel mode).
// The caller (app.js /api/library/img/:id) proxies this to the browser.
export function getScrapedRemoteUrl(id) {
  const rec = scrapedIndex().find((s) => s.id === id)
  return rec?.remoteUrl || null
}

// Add URL-only image records to the library index (no file download).
// Used by the Vercel scrape serverless function where /tmp is ephemeral.
export function addUrlImages(images) {
  // images: [{ id, remoteUrl, pack }]
  ensure()
  const index = scrapedIndex()
  const knownUrls = new Set(index.map((s) => s.remoteUrl).filter(Boolean))
  let added = 0
  for (const img of images) {
    if (knownUrls.has(img.remoteUrl)) continue
    index.unshift({ id: img.id, remoteUrl: img.remoteUrl, pack: img.pack, addedAt: new Date().toISOString() })
    knownUrls.add(img.remoteUrl)
    added++
  }
  writeJson(INDEX_PATH, index)
  return { added, total: images.length }
}

export function removeScraped(id) {
  const index = scrapedIndex()
  const rec = index.find((s) => s.id === id)
  // Delete the actual file too — otherwise reconcileOrphans() sees an
  // un-indexed file on disk and immediately re-adds it ("zombie" delete).
  if (rec && rec.file) {
    const p = join(MEDIA_DIR, rec.file)
    if (existsSync(p)) rmSync(p)
  }
  // Fire-and-forget blob deletion so this function stays synchronous.
  if (rec?.blobUrl) {
    const TOKEN = process.env.BLOB_READ_WRITE_TOKEN
    if (TOKEN) {
      import('@vercel/blob')
        .then(({ del }) => del(rec.blobUrl, { token: TOKEN }))
        .catch((e) => console.warn('[blob] image delete failed:', e.message))
    }
  }
  writeJson(INDEX_PATH, index.filter((s) => s.id !== id))
  return listLibrary()
}

function writeJson(p, v) {
  ensure()
  writeFileSync(p, JSON.stringify(v, null, 2))
  syncToBlob(p, v)
}

// ── HTTP/HTTPS helper with optional proxy tunnel ─────────────────────────────

// Builds an https.Agent that tunnels through an HTTP(S) CONNECT proxy.
// proxyUrl format: http://[user:pass@]host:port  or  https://[user:pass@]host:port
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
      if (res.statusCode !== 200) {
        return cb(new Error(`Proxy CONNECT failed: ${res.statusCode}`))
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || options.host,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      })
      tlsSocket.on('secureConnect', () => cb(null, tlsSocket))
      tlsSocket.on('error', cb)
    })
    req.on('error', cb)
    req.end()
  }

  return agent
}

// HTTPS GET with optional proxy. Returns { ok, status, buffer }.
// Follows up to 3 redirects.
function httpsGet(url, headers, proxyUrl, timeout = 30_000) {
  const agent = buildAgent(proxyUrl)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout fetching ${url}`)), timeout)

    function attempt(u, hops) {
      const t = new URL(u)
      const chunks = []
      const req = https.request(
        {
          hostname: t.hostname,
          port: t.port || 443,
          path: t.pathname + t.search,
          method: 'GET',
          headers: { ...headers, Host: t.hostname },
          agent,
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
            res.resume()
            return attempt(new URL(res.headers.location, u).href, hops - 1)
          }
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            clearTimeout(timer)
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              buffer: Buffer.concat(chunks),
              headers: res.headers,
            })
          })
          res.on('error', (e) => { clearTimeout(timer); reject(e) })
        }
      )
      req.on('error', (e) => { clearTimeout(timer); reject(e) })
      req.end()
    }

    attempt(url, 3)
  })
}

// HTTPS POST with form-encoded body and optional proxy.
function httpsPost(url, headers, body, proxyUrl, timeout = 30_000) {
  const agent = buildAgent(proxyUrl)
  const bodyBuf = Buffer.from(body)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout posting to ${url}`)), timeout)
    const t = new URL(url)
    const chunks = []
    const req = https.request(
      {
        hostname: t.hostname,
        port: t.port || 443,
        path: t.pathname + t.search,
        method: 'POST',
        headers: { ...headers, Host: t.hostname, 'Content-Length': String(bodyBuf.length) },
        agent,
      },
      (res) => {
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          clearTimeout(timer)
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            buffer: Buffer.concat(chunks),
            headers: res.headers,
          })
        })
        res.on('error', (e) => { clearTimeout(timer); reject(e) })
      }
    )
    req.on('error', (e) => { clearTimeout(timer); reject(e) })
    req.write(bodyBuf)
    req.end()
  })
}

// ── Shared image downloader ──────────────────────────────────────────────────

const IMG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://www.pinterest.com/',
}

async function downloadImages(urls, pack, proxy, onProgress) {
  if (process.env.VERCEL) {
    const TOKEN = process.env.BLOB_READ_WRITE_TOKEN
    if (TOKEN) {
      // Download each image and store it permanently in Vercel Blob (public CDN).
      // This avoids Pinterest IP-blocking the on-demand proxy and survives cold starts.
      const { put } = await import('@vercel/blob')
      ensure()
      const index = scrapedIndex()
      const knownSourceUrls = new Set(index.map((s) => s.sourceUrl).filter(Boolean))
      const stamp = Date.now()
      let added = 0, skipped = 0

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]
        if (knownSourceUrls.has(url)) {
          skipped++
          onProgress?.({ phase: 'download', downloaded: added + skipped, total: urls.length })
          continue
        }
        try {
          const r = await httpsGet(url, IMG_HEADERS, proxy, 30_000)
          if (!r.ok || r.buffer.length < 1024) { skipped++; continue }
          const ext = (extname(new URL(url).pathname) || '.jpg').slice(0, 5)
          const id = `scraped:${stamp}-${i}-${Math.round(Math.random() * 1e5)}`
          const blobKey = `slidesmith/library/${stamp}-${i}${ext || '.jpg'}`
          const { url: blobUrl } = await put(blobKey, r.buffer, {
            access: 'public',
            addRandomSuffix: false,
            contentType: r.headers['content-type'] || 'image/jpeg',
            token: TOKEN,
          })
          index.unshift({ id, blobUrl, sourceUrl: url, pack, addedAt: new Date().toISOString() })
          knownSourceUrls.add(url)
          added++
          log.progress(added, urls.length, 'uploaded to blob')
        } catch (e) {
          log.warn(`blob upload failed: ${e.message}`)
          skipped++
        }
        onProgress?.({ phase: 'download', downloaded: added + skipped, total: urls.length })
      }

      writeJson(INDEX_PATH, index)
      return { added, skipped }
    }

    // Fallback when no blob token: store Pinterest URLs for on-demand proxy.
    ensure()
    const index = scrapedIndex()
    const knownUrls = new Set(index.map((s) => s.remoteUrl).filter(Boolean))
    const stamp = Date.now()
    let added = 0, skipped = 0
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      if (knownUrls.has(url)) {
        skipped++
        onProgress?.({ phase: 'download', downloaded: added + skipped, total: urls.length })
        continue
      }
      index.unshift({ id: `scraped:${stamp}-${i}-${Math.round(Math.random() * 1e5)}`, remoteUrl: url, pack, addedAt: new Date().toISOString() })
      knownUrls.add(url)
      added++
      onProgress?.({ phase: 'download', downloaded: added + skipped, total: urls.length })
    }
    writeJson(INDEX_PATH, index)
    return { added, skipped }
  }

  ensure()
  const index = scrapedIndex()
  // Build a set of already-downloaded source filenames so we never re-fetch
  // an image that's already in the library (regardless of which scrape added it).
  const knownSourceFiles = new Set(index.map((s) => s.sourceFile).filter(Boolean))
  let added = 0
  let skipped = 0

  for (const url of urls) {
    try {
      const sourceFile = new URL(url).pathname.split('/').pop()?.split('?')[0] || ''
      if (sourceFile && knownSourceFiles.has(sourceFile)) { skipped++; continue }

      const r = await httpsGet(url, IMG_HEADERS, proxy, 30_000)
      if (!r.ok || r.buffer.length < 1024) { skipped++; continue }
      const ext = (extname(new URL(url).pathname) || '.jpg').slice(0, 5)
      const id = `scraped:${Date.now()}-${Math.round(Math.random() * 1e6)}`
      const file = `${id.replace('scraped:', '')}${ext}`
      writeFileSync(join(MEDIA_DIR, file), r.buffer)
      index.unshift({ id, file, pack, addedAt: new Date().toISOString(), sourceFile })
      if (sourceFile) knownSourceFiles.add(sourceFile)
      added++
      if (added % 5 === 0 || added === urls.length) log.progress(added, urls.length, 'downloaded')
      onProgress?.({ phase: 'download', downloaded: added + skipped, total: urls.length })
    } catch {
      skipped++
      onProgress?.({ phase: 'download', downloaded: added + skipped, total: urls.length })
    }
  }

  writeJson(INDEX_PATH, index)
  return { added, skipped }
}

// ── Apify method ─────────────────────────────────────────────────────────────

// Pull image URLs out of whatever the Pinterest actor returns. Pinterest actors
// vary in shape between versions, so we try the structured path first (best
// quality) and fall back to scanning the whole response for pinimg.com assets.
function pinImageUrls(items) {
  const list = Array.isArray(items) ? items : []

  // 1) Structured: media.images.{original|large|...}
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

  // 2) Fallback: scan the whole blob for pinimg URLs. Prefer /originals/.
  const blob = JSON.stringify(list)
  const matches = blob.match(/https?:\\?\/\\?\/[^"'\\\s]*pinimg\.com[^"'\\\s]*/gi) || []
  const cleaned = matches
    .map((u) => u.replace(/\\\//g, '/').replace(/&amp;/g, '&'))
    .filter((u) => /\.(jpe?g|png|webp)/i.test(u))
  const originals = cleaned.filter((u) => /\/originals\//i.test(u))
  const byName = new Map()
  for (const u of [...originals, ...cleaned]) {
    const name = u.split('/').pop()
    if (name && !byName.has(name)) byName.set(name, u)
  }
  return [...byName.values()]
}

const APIFY = 'https://api.apify.com/v2/acts'

async function scrapeViaApify({ apiKey, actor, searches, count, proxy, onProgress }) {
  if (!apiKey) throw new Error('Missing Apify API key. Add it in Settings.')
  const queries = (searches || []).map((s) => s.trim()).filter(Boolean)
  if (!queries.length) throw new Error('Enter at least one Pinterest search.')

  const actorPath = (actor || 'fatihtahta/pinterest-scraper-search').replace('/', '~')
  const limit = Math.min(Math.max(Number(count) || 40, 10), 200)
  const pack = queries.join(', ')

  log.start(`Scraping Pinterest via Apify → "${pack}" (up to ${limit})`)
  log.step(`running actor ${actor || 'fatihtahta/pinterest-scraper-search'}…`)
  onProgress?.({ phase: 'search', message: `Running Apify actor for "${pack}"…` })
  const res = await fetch(`${APIFY}/${actorPath}/run-sync-get-dataset-items?token=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries, limit }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    log.fail(`Apify ${res.status}`)
    throw new Error(`Apify ${res.status}: ${t.slice(0, 160)}`)
  }
  const items = await res.json()
  const n = Array.isArray(items) ? items.length : 0
  log.info(`actor returned ${n} item${n === 1 ? '' : 's'}`)
  const urls = pinImageUrls(items).slice(0, limit)
  if (!urls.length) {
    log.fail(`no images found (actor returned ${n} item${n === 1 ? '' : 's'})`)
    throw new Error(`No images found (actor returned ${n} item${n === 1 ? '' : 's'}). Try a different search or actor.`)
  }
  log.ok(`found ${urls.length} image${urls.length === 1 ? '' : 's'} — downloading…`)
  onProgress?.({ phase: 'search', message: `Found ${urls.length} image${urls.length === 1 ? '' : 's'} — downloading…` })

  const { added, skipped } = await downloadImages(urls, pack, proxy, onProgress)
  log.ok(`Added ${added} image${added === 1 ? '' : 's'} to "${pack}"${skipped ? ` (${skipped} skipped)` : ''}`)
  return { added, found: urls.length }
}

// ── Direct method ────────────────────────────────────────────────────────────

// Realistic Chrome + macOS combos to rotate through so every request looks
// slightly different. Keeps the same platform/UA family but varies the exact
// version strings Pinterest fingerprints on.
const CHROME_BUILDS = [
  { major: '120', build: '120.0.0.0', full: '120.0.6099.109' },
  { major: '124', build: '124.0.0.0', full: '124.0.6367.82' },
  { major: '126', build: '126.0.0.0', full: '126.0.6478.127' },
  { major: '130', build: '130.0.0.0', full: '130.0.6723.91' },
  { major: '131', build: '131.0.0.0', full: '131.0.6778.85' },
  { major: '135', build: '135.0.0.0', full: '135.0.6931.0' },
  { major: '137', build: '137.0.0.0', full: '137.0.7151.40' },
  { major: '149', build: '149.0.0.0', full: '149.0.7827.54' },
]
const MACOS_PLATFORM_VERSIONS = [
  '13.6.0', '14.0.0', '14.1.0', '14.2.1', '14.4.0', '14.5.0', '15.0.0', '15.1.0', '15.2.0',
]

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function randomHex(n) { return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('') }

// One randomized-but-consistent "browser" per scrape. Real browsers don't
// change UA/version mid-session, and Pinterest's session state (including
// bookmark tokens) is tied to the CSRF token that was active when it was
// issued — rotating it per-request invalidates bookmarks mid-pagination.
function buildIdentity() {
  return {
    chrome: pick(CHROME_BUILDS),
    macosVer: pick(MACOS_PLATFORM_VERSIONS),
    dpr: Math.random() > 0.6 ? '2' : '1',
    appVersion: randomHex(7),
    csrfToken: randomHex(32), // replaced with real token by bootstrapSession
  }
}

// Hit Pinterest's homepage to get a real server-issued csrftoken cookie.
// Without a real token the first search request is always cold (0 results).
// Falls back silently to the random token if the request fails.
async function bootstrapSession(proxy, identity) {
  const { chrome, macosVer } = identity
  try {
    const res = await httpsGet(
      'https://www.pinterest.com/',
      {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'sec-ch-ua': `"Google Chrome";v="${chrome.major}", "Chromium";v="${chrome.major}", "Not)A;Brand";v="24"`,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'user-agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.build} Safari/537.36`,
      },
      proxy,
      15_000
    )
    const setCookies = res.headers['set-cookie'] || []
    const list = Array.isArray(setCookies) ? setCookies : [setCookies]
    for (const c of list) {
      const m = c.match(/(?:^|;\s*)csrftoken=([^;]+)/)
      if (m) return m[1]
    }
  } catch {}
  return null
}

// Build request headers for Pinterest's search API POST request.
function buildPinHeaders(query, identity) {
  const { chrome, macosVer, dpr, appVersion, csrfToken } = identity
  const traceId = randomHex(16)

  return {
    'accept': 'application/json, text/javascript, */*, q=0.01',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/x-www-form-urlencoded',
    'cookie': `csrftoken=${csrfToken}`,
    'origin': 'https://www.pinterest.com',
    'priority': 'u=1, i',
    'referer': 'https://www.pinterest.com/',
    'screen-dpr': dpr,
    'sec-ch-ua': `"Google Chrome";v="${chrome.major}", "Chromium";v="${chrome.major}", "Not)A;Brand";v="24"`,
    'sec-ch-ua-full-version-list': `"Google Chrome";v="${chrome.full}", "Chromium";v="${chrome.full}", "Not)A;Brand";v="24.0.0.0"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-platform': '"macOS"',
    'sec-ch-ua-platform-version': `"${macosVer}"`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome.build} Safari/537.36`,
    'x-app-version': appVersion,
    'x-b3-flags': '0',
    'x-b3-traceid': traceId,
    'x-b3-parentspanid': traceId,
    'x-b3-spanid': randomHex(16),
    'x-csrftoken': csrfToken,
    'x-pinterest-appstate': 'active',
    'x-pinterest-pws-handler': 'www/search/[scope].js',
    'x-pinterest-source-url': `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`,
    'x-requested-with': 'XMLHttpRequest',
  }
}

// Fetch one page of results from Pinterest's internal search API (POST form).
// Returns { urls, bookmark } — bookmark is the pagination token for the next page,
// or null when Pinterest has no more results.
async function fetchPinterestPage(query, proxy, identity, bookmark = null) {
  const { csrfToken } = identity
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`
  const options = {
    query,
    scope: 'pins',
    appliedProductFilters: null,
    domains: null,
    user: null,
    seoDrawerEnabled: false,
    applied_unified_filters: null,
    auto_correction_disabled: false,
    journey_depth: null,
    source_id: null,
    source_module_id: null,
    source_url: sourceUrl,
    static_feed: false,
    selected_one_bar_modules: null,
    query_pin_sigs: null,
    page_size: null,
    price_max: null,
    price_min: null,
    query_image_pins: null,
    request_params: null,
    top_pin_ids: null,
    article: null,
    corpus: null,
    customized_rerank_type: null,
    filters: null,
    rs: 'typed',
    redux_normalize_feed: true,
    ...(bookmark ? { bookmarks: [bookmark] } : {}),
  }

  const body = new URLSearchParams({
    source_url: sourceUrl,
    data: JSON.stringify({ options, context: {} }),
  }).toString()

  const res = await httpsPost(
    'https://www.pinterest.com/resource/BaseSearchResource/get/',
    buildPinHeaders(query, identity),
    body,
    proxy,
    30_000
  )

  if (!res.ok) throw new Error(`Pinterest returned HTTP ${res.status}. Add a proxy in Settings if you're being blocked.`)

  let data
  try { data = JSON.parse(res.buffer.toString()) } catch {
    throw new Error('Pinterest returned an unexpected response. Try adding a proxy in Settings.')
  }

  const resourceResponse = data?.resource_response || {}
  const results = resourceResponse?.data?.results || []
  const nextBookmark = resourceResponse?.bookmark || null
  log.info(`Pinterest: HTTP ${res.status}, results=${results.length}, bookmark=${nextBookmark ? 'yes' : 'no'}, status=${resourceResponse?.status ?? 'n/a'}, msg=${String(resourceResponse?.message ?? '').slice(0, 80)}`)

  const urls = []
  for (const pin of results) {
    if (!pin || typeof pin !== 'object') continue
    if (pin.type && pin.type !== 'pin') continue

    // Tier 1: standard shape — pin.images.{orig|736x|…}
    const imgs = pin.images
    const img1 = imgs?.orig ?? imgs?.['736x'] ?? imgs?.['474x'] ?? imgs?.['236x']
    if (img1?.url) { urls.push(String(img1.url).replace(/&amp;/g, '&')); continue }

    // Tier 2: redux_normalize_feed shape — pin.media.images.{original|large|…}
    const mImgs = pin.media?.images
    const img2 = mImgs?.original ?? mImgs?.orig ?? mImgs?.large ?? mImgs?.['736x']
    if (img2?.url) { urls.push(String(img2.url).replace(/&amp;/g, '&')); continue }
  }

  // Tier 3: blob scan fallback — catches any other shape by grepping for pinimg.com URLs
  if (urls.length === 0 && results.length > 0) {
    const blob = JSON.stringify(results)
    const matches = blob.match(/https?:\\?\/\\?\/[^"'\\\s]*pinimg\.com[^"'\\\s]*/gi) || []
    const cleaned = matches
      .map((u) => u.replace(/\\\//g, '/').replace(/&amp;/g, '&'))
      .filter((u) => /\.(jpe?g|png|webp)/i.test(u))
    const originals = cleaned.filter((u) => /\/originals\//i.test(u))
    const byName = new Map()
    for (const u of [...originals, ...cleaned]) {
      const name = u.split('/').pop()
      if (name && !byName.has(name)) byName.set(name, u)
    }
    urls.push(...byName.values())
  }

  return { urls, bookmark: nextBookmark }
}

// Collect up to `limit` image URLs for a single search query.
// Uses Pinterest's bookmark token for proper pagination when available.
// Falls back to fresh requests when no bookmark is returned — Pinterest's
// feed has enough non-determinism that independent calls can surface new images.
// Stops early only when two consecutive pages yield no new URLs (de-dup exhausted).
async function searchPins(query, limit, proxy, identity) {
  const collected = []
  const seen = new Set()
  let bookmark = null
  const MAX_PAGES = 20
  let consecutiveEmpty = 0

  for (let page = 1; page <= MAX_PAGES && collected.length < limit; page++) {
    let result
    try {
      result = await fetchPinterestPage(query, proxy, identity, bookmark)
    } catch (e) {
      if (page === 1) throw e
      log.info(`"${query}" page ${page} failed: ${e.message} — stopping`)
      break
    }

    const { urls, bookmark: nextBookmark } = result
    let added = 0
    for (const url of urls) {
      const name = url.split('/').pop()?.split('?')[0]
      if (name && !seen.has(name)) {
        seen.add(name)
        collected.push(url)
        added++
      }
    }

    consecutiveEmpty = added === 0 ? consecutiveEmpty + 1 : 0
    // Stop only when de-dup is truly exhausted (2 pages in a row gave nothing new).
    if (consecutiveEmpty >= 2) break

    // Advance the bookmark if Pinterest provided one; otherwise next iteration
    // sends a fresh request (bookmark=null) which can yield different images.
    bookmark = nextBookmark || null
    if (collected.length < limit) await new Promise((r) => setTimeout(r, 300))
  }

  return collected.slice(0, limit)
}

async function scrapeDirect({ searches, count, proxy, onProgress }) {
  const queries = (searches || []).map((s) => s.trim()).filter(Boolean)
  if (!queries.length) throw new Error('Enter at least one Pinterest search.')

  const limit = Math.min(Math.max(Number(count) || 40, 1), 200)
  const pack = queries.join(', ')

  log.start(`Scraping Pinterest directly → "${pack}" (up to ${limit})`)
  if (proxy) log.step('routing through proxy')

  const identity = buildIdentity()
  log.step('establishing Pinterest session…')
  const realToken = await bootstrapSession(proxy, identity)
  if (realToken) {
    identity.csrfToken = realToken
    log.info('session token acquired')
  } else {
    log.info('session bootstrap failed — using fallback token')
  }

  const perQuery = Math.ceil(limit / queries.length)
  const allUrls = []
  for (const query of queries) {
    log.step(`searching "${query}"…`)
    onProgress?.({ phase: 'search', message: `Searching "${query}"…` })
    const found = await searchPins(query, perQuery, proxy, identity)
    log.info(`"${query}" → ${found.length} image${found.length === 1 ? '' : 's'}`)
    allUrls.push(...found)
  }

  // De-dupe by filename so the same image from two queries isn't downloaded twice.
  const seen = new Set()
  const deduped = []
  for (const u of allUrls) {
    const name = u.split('/').pop()?.split('?')[0]
    if (name && !seen.has(name)) { seen.add(name); deduped.push(u) }
  }

  const finalUrls = deduped.slice(0, limit)
  if (!finalUrls.length) {
    log.fail('no images found')
    throw new Error('No images found. Try a different search or add a proxy in Settings.')
  }

  log.ok(`found ${finalUrls.length} image${finalUrls.length === 1 ? '' : 's'} — downloading…`)
  onProgress?.({ phase: 'search', message: `Found ${finalUrls.length} image${finalUrls.length === 1 ? '' : 's'} — downloading…` })

  const { added, skipped } = await downloadImages(finalUrls, pack, proxy, onProgress)
  if (added === 0 && skipped > 0) {
    log.ok(`All ${skipped} image${skipped === 1 ? '' : 's'} already in library — nothing new to add`)
  } else {
    log.ok(`Added ${added} image${added === 1 ? '' : 's'} to "${pack}"${skipped ? ` (${skipped} already in library)` : ''}`)
  }
  return { added, found: finalUrls.length }
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export async function scrapePinterest({ method, apiKey, actor, proxy, searches, count, onProgress }) {
  if (method === 'apify') {
    return scrapeViaApify({ apiKey, actor, searches, count, proxy, onProgress })
  }
  return scrapeDirect({ searches, count, proxy, onProgress })
}
