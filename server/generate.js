// Slideshow generation. Given the "Brain" (niche, audience, style memory,
// reference patterns), the chosen model writes N carousel slideshows: a hook,
// caption, hashtags, a rationale, and the per-slide text. Images are rendered
// later, client-side — the model only writes the words.
//
// Dedup: every accepted hook is embedded and stored in quotes.json. Subsequent
// generations skip hooks that are too similar to stored ones, then try again
// until the requested count of unique slideshows is reached.
import { chatJSON } from './providers.js'
import { getQuotes } from './store.js'
import { embedText, isDuplicate } from './embeddings.js'
import { logger } from './log.js'

const log = logger('generate')

// Background gradients assigned per slide so rendering needs no image-gen API.
const PALETTE = [
  ['#0f172a', '#1e293b'],
  ['#1a1a2e', '#16213e'],
  ['#2d1b1b', '#1a1010'],
  ['#0a1f1c', '#0f2922'],
  ['#1f1147', '#160d33'],
  ['#26120a', '#1a0c06'],
]

function buildPrompt(brain, count, recentHooks = []) {
  const avoidSection = recentHooks.length
    ? `\nHOOKS ALREADY IN THE BANK (${recentHooks.length} total) — these angles are taken. Write from completely different angles, formulas, and framings. Do not reuse the same premise even with different words:\n${recentHooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n`
    : ''

  return `You are an expert short-form content strategist for TikTok and Instagram carousels.

Account context:
- Niche: ${brain.niche || '(unspecified)'}
- App / brand: ${brain.appName || '(unspecified)'} — ${brain.appDescription || ''}
- Audience: ${brain.audience || '(unspecified)'}

What's working for this account (style memory — respect this closely):
${brain.styleMemory || '(none yet — use proven short-form patterns)'}
${avoidSection}
HOOK RULES (slide 1 + "hook" field):
- Max 8 words but must create an irresistible curiosity gap or make a bold claim
- Use proven formulas: "Nobody tells you...", "Stop doing X if you want Y", "This one thing changed...", "X mistakes killing your Y", "The truth about X that [audience] won't say", "I tried X for 30 days and..."
- Must speak directly to the audience's pain or desire — not a generic statement
- No clickbait that the slides can't back up

SLIDE RULES:
- 5-7 slides total. Slide 1 = hook. Slides 2-6 = deliver the promised value clearly, one point per slide, max ~8 words each. Last slide = strong CTA (e.g. "Save this before you forget", "Follow for more like this", "Share if this helped").
- Each slide text should work as a standalone punchy statement — short, scannable, high contrast.

CAPTION RULES (this is critical — short captions kill reach):
- Write 150-250 words minimum. This is the caption that goes UNDER the post.
- Open with a hook sentence that mirrors or expands on the carousel hook.
- Then deliver 2-3 sentences of genuine value or storytelling that deepens what the slides showed.
- Include a personal/relatable angle or a specific insight that makes the reader feel seen.
- End with a direct question or CTA that invites comments (comments = reach boost).
- Use 3-5 relevant emojis naturally woven in — not dumped at the end.
- Sound like a real person, not a brand. Conversational, not formal.
- Do NOT pad with filler phrases. Every sentence should earn its place.

Write ${count} distinct slideshows. Respond with a JSON object of this exact shape:
{
  "slideshows": [
    {
      "hook": "the first slide — max 8 words, curiosity-gap or bold claim",
      "slides": ["slide 1 = hook", "slide 2", "...5-7 slides total, last = CTA"],
      "caption": "150-250 word caption following the rules above",
      "hashtags": ["five", "relevant", "niche", "hashtags", "here"],
      "rationale": "one sentence on why this will perform, tied to the style memory"
    }
  ]
}

Keep them on-brand, varied, and genuinely good. Do not write generic filler. Return ONLY the JSON object.`
}

// Generate in small batches so big counts don't overflow the model's output /
// truncate the JSON. Each call asks for a handful; we loop until we hit `count`
// unique slideshows (by embedding similarity against the stored quotes index).
const BATCH = 6
const MAX_ATTEMPTS = (count) => count + 10  // max batch API calls before giving up

export async function generateSlideshows({ apiKey, model, brain, provider = 'openrouter', count = 4, projectId, embeddingKey }) {
  log.start(`Generating ${count} slideshow${count === 1 ? '' : 's'} with ${model}`)
  if (brain?.niche) log.info(`niche: ${brain.niche}${brain.appName ? ` · ${brain.appName}` : ''}`)

  // Load stored quotes scoped to this project for dedup comparison.
  const { entries: storedQuotes } = getQuotes()
  const projectQuotes = storedQuotes.filter((e) => !projectId || e.projectId === projectId)

  // Recent hooks injected into the prompt so the model actively avoids them.
  // Cap at 30 — beyond that the list gets so long models start refusing to generate.
  const recentHooks = projectQuotes
    .filter((e) => e.type === 'hook')
    .slice(-30)
    .map((e) => e.text)

  if (recentHooks.length) log.info(`injecting ${recentHooks.length} existing hook(s) into prompt`)

  if (embeddingKey) {
    log.info('embedding key present — using OpenAI text-embedding-3-small for dedup')
  } else {
    log.warn('no embedding key — falling back to trigram similarity for dedup')
  }

  // Generate all requested slideshows in one pass (with batching for large counts).
  const raw = []
  let safety = 0
  let emptyBatches = 0
  while (raw.length < count && safety < count + 5) {
    safety++
    const n = Math.min(BATCH, count - raw.length)
    log.step(`asking model for ${n} more (${raw.length}/${count} so far)…`)
    const parsed = await chatJSON({ apiKey, model, prompt: buildPrompt(brain, n, recentHooks), provider })
    const batch = parsed.slideshows || []
    if (!batch.length) {
      emptyBatches++
      log.warn(`model returned no slideshows (attempt ${emptyBatches})`)
      if (emptyBatches >= 2) break  // give up after two consecutive empty responses
      continue
    }
    emptyBatches = 0
    raw.push(...batch)
  }
  log.info(`raw batch: ${raw.length} slideshow(s) before dedup`)

  // Embed the hook of every raw slideshow in parallel.
  // The hook (slide[0]) is the unique fingerprint of the slideshow — we reject on
  // hook similarity only. Body slides are stored for history but not used for rejection,
  // because body content from the same niche is naturally topically similar and cosine
  // similarity would flag valid distinct slideshows as duplicates.
  let embedError = false
  const hookTexts = raw.map((s) => s.hook || (s.slides?.[0]) || '')
  const hookEmbeddings = await Promise.all(
    hookTexts.map((t) =>
      embedText(t, embeddingKey).catch((e) => {
        if (!embedError) {
          log.warn(`embedding API failed (${e.message}) — falling back to trigram similarity`)
          embedError = true
        }
        return null
      })
    )
  )

  // Filter: keep slideshows whose hook is unique against stored hooks + accepted hooks so far.
  const accepted = []
  const newEntries = []
  const now = new Date().toISOString()

  for (let i = 0; i < raw.length; i++) {
    if (accepted.length >= count) break
    const hookText = hookTexts[i]
    const hookEmbedding = hookEmbeddings[i]
    const allEntries = [...projectQuotes, ...newEntries]

    if (isDuplicate(hookText, hookEmbedding, allEntries)) {
      log.warn(`deduped hook: "${hookText}"`)
      continue
    }

    accepted.push(raw[i])

    // Store the hook entry (used for rejection checks and prompt injection in future runs).
    newEntries.push({ type: 'hook', text: hookText, embedding: hookEmbedding, projectId, createdAt: now })

    // Also store every non-CTA body slide for history (no rejection — just indexing).
    const bodySlides = (raw[i].slides || []).slice(1, -1)  // skip hook (0) and CTA (last)
    for (const slideText of bodySlides) {
      newEntries.push({ text: slideText, embedding: null, projectId, createdAt: now })
    }
  }

  log.ok(`Generated ${accepted.length} unique slideshow${accepted.length === 1 ? '' : 's'}`)

  const stamp = Date.now()
  const slideshows = accepted.slice(0, count).map((s, i) => {
    const [from, to] = PALETTE[i % PALETTE.length]
    return {
      id: `q-${stamp}-${i}`,
      hook: s.hook || (s.slides && s.slides[0]) || '',
      caption: s.caption || '',
      hashtags: s.hashtags || [],
      rationale: s.rationale || '',
      createdAt: new Date(stamp).toISOString(),
      slides: (s.slides || []).map((text, j) => ({
        id: `slide-${stamp}-${i}-${j}`,
        text,
        bgFrom: from,
        bgTo: to,
      })),
    }
  })

  // Return both the slideshows and the quote entries so the caller (app.js) can
  // persist them independently — if quote persistence fails it must NOT prevent
  // the slideshows from being added to the queue.
  return { slideshows, quoteEntries: newEntries }
}
