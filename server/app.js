// Express app shared between local dev (server/index.js → listen()) and the
// Vercel serverless entry point (api/index.js → export default app).
// On Vercel: SLIDESMITH_DIR is set to /tmp/slidesmith so store.js and library.js
// write to the Lambda's writable /tmp — state persists across warm invocations
// within the same instance and is reset on a cold start (acceptable for a
// personal tool; just re-enter keys on a cold start).
import express from 'express'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getConfig,
  saveGlobal,
  getActiveProject,
  createProject,
  updateProject,
  deleteProject,
  setActiveProject,
  getQueue,
  setQueue,
  addToQueue,
  removeFromQueue,
  CONFIG_DIR,
} from './store.js'
import { listAccounts, listPosts, listAnalytics, syncAnalytics, uploadMedia, createPost } from './postbridge.js'
import { generateSlideshows } from './generate.js'
import { listModels, validateKey } from './providers.js'
import { listLibrary, listPacks, scrapePinterest, removeScraped, getScrapedFile, getScrapedRemoteUrl } from './library.js'
import { logger } from './log.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const schedLog = logger('schedule')
const genLog = logger('generate')

export const app = express()
app.use(express.json({ limit: '50mb' }))

// Password protection: when SLIDESMITH_PASSWORD is set every /api route requires
// an Authorization: Bearer <password> header. No-op when the var is absent so
// local dev works without a password.
const PASS = process.env.SLIDESMITH_PASSWORD?.trim()
if (PASS) {
  app.use('/api', (req, res, next) => {
    if (req.headers.authorization === `Bearer ${PASS}`) return next()
    res.status(401).json({ error: 'Unauthorized' })
  })
}

// DNS-rebinding guard: block requests from unexpected Host headers. Only
// needed when the server is bound locally (local dev). On Vercel the server
// isn't listening on a user-reachable socket so this isn't necessary.
if (!process.env.VERCEL) {
  const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', process.env.HOST].filter(Boolean))
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '')
    if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: `Forbidden host: ${host}` })
    next()
  })
}

// Wrap async handlers so thrown errors become clean 500 JSON instead of crashes.
const h = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e)
  res.status(500).json({ error: e.message || String(e) })
})

// ── Config ──────────────────────────────────────────────────────────────────
app.get('/api/config', h(async (_req, res) => res.json(getConfig())))
app.put('/api/config', h(async (req, res) => res.json(saveGlobal(req.body || {}))))

// ── Projects ─────────────────────────────────────────────────────────────────
app.post('/api/projects', h(async (req, res) => res.json(createProject(req.body?.name))))
app.put('/api/projects/:id', h(async (req, res) => res.json(updateProject(req.params.id, req.body || {}))))
app.delete('/api/projects/:id', h(async (req, res) => res.json(deleteProject(req.params.id))))
app.post('/api/projects/:id/activate', h(async (req, res) => res.json(setActiveProject(req.params.id))))

app.post('/api/config/test', h(async (_req, res) => {
  const { keys, provider } = getConfig()
  const result = { postbridge: false, ai: false, apify: false, errors: {} }
  if (keys.postbridge) {
    try { await listAccounts(keys.postbridge); result.postbridge = true }
    catch (e) { result.errors.postbridge = e.message }
  }
  const activeKey = keys[provider] || ''
  if (activeKey) {
    try { await validateKey(activeKey, provider); result.ai = true }
    catch (e) { result.errors.ai = e.message }
  }
  if (keys.apify) {
    try {
      const r = await fetch(`https://api.apify.com/v2/users/me?token=${keys.apify}`)
      if (!r.ok) throw new Error(`invalid key (${r.status})`)
      result.apify = true
    } catch (e) { result.errors.apify = e.message }
  }
  res.json(result)
}))

app.get('/api/models', h(async (req, res) => {
  const provider = req.query.provider || 'openrouter'
  res.json(await listModels(provider))
}))

// ── Queue ─────────────────────────────────────────────────────────────────────
app.get('/api/queue', h(async (_req, res) => {
  const project = getActiveProject()
  res.json(getQueue(project.id))
}))

app.post('/api/generate', h(async (req, res) => {
  const { keys, model, provider } = getConfig()
  const project = getActiveProject()
  const count = Math.min(Math.max(Math.round(Number(req.body?.count) || 4), 1), 100)
  const apiKey = keys[provider] || ''
  const slideshows = await generateSlideshows({ apiKey, model, brain: project.brain, provider, count })

  const packs = Array.isArray(req.body?.packs) ? req.body.packs : project.imagePacks || []
  const pool = packs.length ? listLibrary().filter((i) => packs.includes(i.pack)) : []
  if (pool.length) {
    genLog.step(`assigning backgrounds from ${packs.length} pack${packs.length === 1 ? '' : 's'} (${pool.length} images)`)
    for (const show of slideshows) {
      const used = new Set()
      for (const slide of show.slides) {
        const fresh = pool.filter((i) => !used.has(i.url))
        const pick = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))]
        slide.imageUrl = pick.url
        used.add(pick.url)
      }
    }
  }

  addToQueue(project.id, slideshows)
  res.json(slideshows)
}))

app.delete('/api/queue/:id', h(async (req, res) =>
  res.json(removeFromQueue(getActiveProject().id, req.params.id))
))

app.put('/api/queue/:id', h(async (req, res) => {
  const pid = getActiveProject().id
  const patch = req.body || {}
  const allowed = ['slides', 'caption', 'hashtags', 'hook']
  const next = getQueue(pid).map((s) => {
    if (s.id !== req.params.id) return s
    const merged = { ...s }
    for (const k of allowed) if (patch[k] !== undefined) merged[k] = patch[k]
    return merged
  })
  res.json(setQueue(pid, next))
}))

// ── Image library ─────────────────────────────────────────────────────────────
app.get('/api/library', h(async (_req, res) => res.json(listLibrary())))
app.get('/api/library/packs', h(async (_req, res) => res.json(listPacks())))

app.post('/api/library/scrape', async (req, res) => {
  const { scrapeMethod, proxy, pinterestActor, keys } = getConfig()
  const { searches, count } = req.body || {}

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {} }

  try {
    const result = await scrapePinterest({
      method: scrapeMethod, apiKey: keys.apify, actor: pinterestActor,
      proxy, searches, count, onProgress: send,
    })
    send({ type: 'done', ...result })
  } catch (e) {
    console.error(e)
    send({ type: 'error', message: e.message || String(e) })
  }
  res.end()
})

app.delete('/api/library', h(async (req, res) => {
  const ids = req.body?.ids
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' })
  for (const id of ids) removeScraped(id)
  res.json(listLibrary())
}))

app.delete('/api/library/:id', h(async (req, res) => res.json(removeScraped(req.params.id))))

app.get('/api/library/img/:id', h(async (req, res) => {
  const file = getScrapedFile(req.params.id)
  if (file) {
    // Local-dev / file-based mode: serve the downloaded image directly.
    return res.sendFile(file, { dotfiles: 'allow' })
  }

  // Vercel / URL-only mode: the image was never downloaded — proxy the
  // remote Pinterest URL so the canvas can draw it same-origin.
  const remoteUrl = getScrapedRemoteUrl(req.params.id)
  if (!remoteUrl) return res.status(404).end()

  const upstream = await fetch(remoteUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      Referer: 'https://www.pinterest.com/',
    },
  })
  if (!upstream.ok) return res.status(upstream.status).end()
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.end(Buffer.from(await upstream.arrayBuffer()))
}))

// ── post-bridge ───────────────────────────────────────────────────────────────
app.get('/api/accounts', h(async (_req, res) => {
  const { keys } = getConfig()
  res.json(await listAccounts(keys.postbridge))
}))

app.get('/api/posts', h(async (_req, res) => {
  const { keys } = getConfig()
  res.json(await listPosts(keys.postbridge))
}))

app.get('/api/results', h(async (_req, res) => {
  const { keys } = getConfig()
  res.json(await listAnalytics(keys.postbridge))
}))

app.post('/api/results/sync', h(async (_req, res) => {
  const { keys } = getConfig()
  try { await syncAnalytics(keys.postbridge) } catch (e) { console.warn('[results] sync skipped:', e.message) }
  res.json(await listAnalytics(keys.postbridge))
}))

app.post('/api/schedule', h(async (req, res) => {
  const { keys } = getConfig()
  const { id, caption, slides, socialAccounts, scheduledAt, mode } = req.body || {}
  if (!socialAccounts?.length) throw new Error('Pick at least one social account.')
  if (!slides?.length) throw new Error('No slide images to upload.')

  const when = mode === 'schedule' ? (scheduledAt ? `scheduled for ${scheduledAt}` : 'scheduled') : 'draft'
  schedLog.start(`Posting ${id || 'slideshow'} → ${when} · ${socialAccounts.length} account${socialAccounts.length === 1 ? '' : 's'}`)

  let done = 0
  const mediaIds = await Promise.all(
    slides.map(async (slide, i) => {
      const buffer = Buffer.from(String(slide).replace(/^data:image\/\w+;base64,/, ''), 'base64')
      const mediaId = await uploadMedia(keys.postbridge, {
        buffer, mimeType: 'image/png', name: `${id || 'slide'}-${i + 1}.png`,
      })
      schedLog.progress(++done, slides.length, 'slides uploaded')
      return mediaId
    })
  )

  schedLog.step('creating post on post-bridge…')
  const post = await createPost(keys.postbridge, {
    caption, mediaIds, socialAccounts,
    scheduledAt: mode === 'schedule' ? scheduledAt : null,
    isDraft: mode !== 'schedule',
  })

  if (id) removeFromQueue(getActiveProject().id, id)
  schedLog.ok(`Done — ${mode === 'schedule' ? 'scheduled' : 'saved as draft'}`)
  res.json(post)
}))

// ── Static (production) ───────────────────────────────────────────────────────
const dist = join(__dirname, '..', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
    res.sendFile(join(dist, 'index.html'))
  })
}
