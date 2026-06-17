// Vercel serverless function: generate slideshows via AI.
// Receives { apiKey, model, provider, brain, count, pool } in the request body.
// pool is an optional array of { url } objects to use as slide backgrounds.
import { generateSlideshows } from '../server/generate.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { apiKey, model, provider, brain, count, pool } = req.body || {}

    const slideshows = await generateSlideshows({
      apiKey,
      model,
      brain,
      provider: provider || 'openrouter',
      count: Math.min(Math.max(Math.round(Number(count) || 4), 1), 100),
    })

    // Assign background images from the client-supplied pool.
    // The pool entries already carry same-origin URLs (proxied for scraped images).
    if (Array.isArray(pool) && pool.length) {
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

    res.json(slideshows)
  } catch (e) {
    console.error('[generate]', e)
    res.status(500).json({ error: e.message || String(e) })
  }
}
