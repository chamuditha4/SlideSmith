// Slidesmith local server. Holds the user's API keys, runs Claude generation,
// proxies post-bridge (so keys never touch the browser and CORS is a non-issue),
// and serves the built UI in production. In dev, Vite proxies /api here.
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
import { listLibrary, listPacks, scrapePinterest, removeScraped, getScrapedFile } from './library.js'
import { logger } from './log.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const schedLog = logger('schedule')
const genLog = logger('generate')
const PORT = process.env.PORT || 8787
// Bind loopback only by default. This server returns the user's API keys in
// plaintext (GET /api/config feeds the Settings UI), so listening on all
// interfaces would hand them to anyone on the same network. Set HOST yourself
// only if you know what you're doing (e.g. a firewalled headless box).
const HOST = process.env.HOST || '127.0.0.1'
const app = express()
app.use(express.json({ limit: '50mb' })) // base64 slide images can be large

// DNS-rebinding guard: a malicious website can point its own domain at
// 127.0.0.1 and read API responses from the visitor's browser, bypassing
// same-origin policy. Rejecting unexpected Host headers closes that hole.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', process.env.HOST].filter(Boolean))
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '')
  if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: `Forbidden host: ${host}` })
  next()
})

// Wrap async handlers so thrown errors become clean 500 JSON instead of crashes.
const h = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e)
  res.status(500).json({ error: e.message || String(e) })
})

// ── Config ──────────────────────────────────────────────────────────────────
app.get('/api/config', h(async (_req, res) => res.json(getConfig())))
// Global settings only: keys + model. Project data goes through /api/projects.
app.put('/api/config', h(async (req, res) => res.json(saveGlobal(req.body || {}))))

// ── Projects (each = a Brain + default post-bridge accounts) ──────────────────
app.post('/api/projects', h(async (req, res) => res.json(createProject(req.body?.name))))
app.put('/api/projects/:id', h(async (req, res) => res.json(updateProject(req.params.id, req.body || {}))))
app.delete('/api/projects/:id', h(async (req, res) => res.json(deleteProject(req.params.id))))
app.post('/api/projects/:id/activate', h(async (req, res) => res.json(setActiveProject(req.params.id))))

// Validate that the saved keys actually work, so Settings can show a green check.
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

// Model catalog for the Settings dropdown. Pass ?provider= to get the right list.
app.get('/api/models', h(async (req, res) => {
  const provider = req.query.provider || 'openrouter'
  res.json(await listModels(provider))
}))

// ── Queue (generated drafts for the active project, before post-bridge) ───────
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

  // Auto-assign background images. A per-batch `packs` override (from the
  // Generate modal) wins; otherwise fall back to the project's saved packs.
  // Empty selection → slides keep their gradients.
  const packs = Array.isArray(req.body?.packs) ? req.body.packs : project.imagePacks || []
  const pool = packs.length ? listLibrary().filter((i) => packs.includes(i.pack)) : []
  if (pool.length) {
    genLog.step(`assigning backgrounds from ${packs.length} pack${packs.length === 1 ? '' : 's'} (${pool.length} images)`)
    for (const show of slideshows) {
      const used = new Set()
      for (const slide of show.slides) {
        // Prefer an unused image within this slideshow for visual variety.
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

// Edit a queued slideshow: caption, hashtags, hook, and/or per-slide text+image.
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

// ── Image library (bundled aesthetic packs + direct Pinterest scrapes) ───────
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

app.delete('/api/library/:id', h(async (req, res) => res.json(removeScraped(req.params.id))))

app.get('/api/library/img/:id', h(async (req, res) => {
  const file = getScrapedFile(req.params.id)
  if (!file) return res.status(404).end()
  // dotfiles:'allow' is required — the path lives under ~/.slidesmith, and
  // sendFile blocks dot-segment paths by default (would 404 every scrape).
  res.sendFile(file, { dotfiles: 'allow' })
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

// Pull fresh metrics from the platforms, then hand back the updated analytics.
// post-bridge rate-limits sync (429) — swallow that so the refresh still returns
// whatever's already there.
app.post('/api/results/sync', h(async (_req, res) => {
  const { keys } = getConfig()
  try { await syncAnalytics(keys.postbridge) } catch (e) { console.warn('[results] sync skipped:', e.message) }
  res.json(await listAnalytics(keys.postbridge))
}))

// Schedule a slideshow: upload each rendered slide image to post-bridge, then
// create the post. `slides` are data URLs (PNG) rendered in the browser.
app.post('/api/schedule', h(async (req, res) => {
  const { keys } = getConfig()
  const { id, caption, slides, socialAccounts, scheduledAt, mode } = req.body || {}
  if (!socialAccounts?.length) throw new Error('Pick at least one social account.')
  if (!slides?.length) throw new Error('No slide images to upload.')

  const when = mode === 'schedule' ? (scheduledAt ? `scheduled for ${scheduledAt}` : 'scheduled') : 'draft'
  schedLog.start(`Posting ${id || 'slideshow'} → ${when} · ${socialAccounts.length} account${socialAccounts.length === 1 ? '' : 's'}`)

  // Upload all slides concurrently — post-bridge handles them independently, so
  // there's no reason to wait for each. Results stay in slide order (the index
  // into the array) so the carousel keeps its sequence.
  let done = 0
  const mediaIds = await Promise.all(
    slides.map(async (slide, i) => {
      const buffer = Buffer.from(String(slide).replace(/^data:image\/\w+;base64,/, ''), 'base64')
      const mediaId = await uploadMedia(keys.postbridge, {
        buffer,
        mimeType: 'image/png',
        name: `${id || 'slide'}-${i + 1}.png`,
      })
      schedLog.progress(++done, slides.length, 'slides uploaded')
      return mediaId
    })
  )

  schedLog.step(`creating post on post-bridge…`)
  const post = await createPost(keys.postbridge, {
    caption,
    mediaIds,
    socialAccounts,
    scheduledAt: mode === 'schedule' ? scheduledAt : null,
    isDraft: mode !== 'schedule', // "save as draft" leaves it unprocessed in post-bridge
  })

  if (id) removeFromQueue(getActiveProject().id, id)
  schedLog.ok(`Done — ${mode === 'schedule' ? 'scheduled' : 'saved as draft'}`)
  res.json(post)
}))


// ── Static (production / `npm start`) ─────────────────────────────────────────
const dist = join(__dirname, '..', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  // SPA fallback: any non-API GET serves index.html. (Express 5 dropped the
  // bare '*' route string, so use a middleware instead of app.get('*').)
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
    res.sendFile(join(dist, 'index.html'))
  })
}

app.listen(PORT, HOST, () => {
  console.log(`\n  Slidesmith server → http://localhost:${PORT} (bound to ${HOST})`)
  console.log(`  Config + queue stored in ${CONFIG_DIR}\n`)
})
