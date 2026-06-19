// Slideshow generation. Given the "Brain" (niche, audience, style memory,
// reference patterns), the chosen model writes N carousel slideshows: a hook,
// caption, hashtags, a rationale, and the per-slide text. Images are rendered
// later, client-side — the model only writes the words.
import { chatJSON } from './providers.js'
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

function buildPrompt(brain, count) {
  return `You are an expert short-form content strategist for TikTok and Instagram carousels.

Account context:
- Niche: ${brain.niche || '(unspecified)'}
- App / brand: ${brain.appName || '(unspecified)'} — ${brain.appDescription || ''}
- Audience: ${brain.audience || '(unspecified)'}

What's working for this account (style memory — respect this closely):
${brain.styleMemory || '(none yet — use proven short-form patterns)'}

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
// truncate the JSON. Each call asks for a handful; we loop until we hit `count`.
const BATCH = 6

export async function generateSlideshows({ apiKey, model, brain, provider = 'openrouter', count = 4 }) {
  log.start(`Generating ${count} slideshow${count === 1 ? '' : 's'} with ${model}`)
  if (brain?.niche) log.info(`niche: ${brain.niche}${brain.appName ? ` · ${brain.appName}` : ''}`)
  const raw = []
  let safety = 0
  while (raw.length < count && safety < count + 5) {
    safety++
    const n = Math.min(BATCH, count - raw.length)
    log.step(`asking model for ${n} more (${raw.length}/${count} so far)…`)
    const parsed = await chatJSON({ apiKey, model, prompt: buildPrompt(brain, n), provider })
    const batch = parsed.slideshows || []
    if (!batch.length) {
      log.warn('model returned no slideshows — stopping early')
      break // model returned nothing — stop rather than loop forever
    }
    raw.push(...batch)
    log.progress(Math.min(raw.length, count), count, 'written')
  }
  log.ok(`Generated ${Math.min(raw.length, count)} slideshow${raw.length === 1 ? '' : 's'}`)

  const stamp = Date.now()
  return raw.slice(0, count).map((s, i) => {
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
}
