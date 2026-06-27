// Semantic deduplication for generated slide hooks.
// Primary: OpenAI text-embedding-3-small via a dedicated embeddingKey (set in
//   Settings → Embedding key). Works regardless of which generation provider is active.
// Fallback: character trigram Jaccard similarity (no API key required).

const EMBED_DIM = 256
export const SIMILARITY_THRESHOLD = 0.92  // cosine — near-exact semantic match only
const JACCARD_THRESHOLD = 0.72            // trigram Jaccard — very similar text only

export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

function trigramSet(text) {
  const s = ` ${text} `
  const set = new Set()
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3))
  return set
}

function jaccardSim(a, b) {
  const sa = trigramSet(normalize(a)), sb = trigramSet(normalize(b))
  let inter = 0
  for (const g of sa) if (sb.has(g)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

async function openaiEmbed(text, apiKey, base) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 8000)
  try {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      signal: abort.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text, dimensions: EMBED_DIM }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`Embeddings ${res.status}: ${body?.error?.message || res.statusText}`)
    return body?.data?.[0]?.embedding ?? null
  } finally {
    clearTimeout(timer)
  }
}

// Returns a 256-dim float array, or null (triggers trigram fallback during comparison).
// Throws on API errors so the caller (generate.js) can log them properly.
// embeddingKey is the dedicated OpenAI key from Settings — independent of the
// generation provider so you can use DeepSeek/Claude for writing and OpenAI for dedup.
export async function embedText(text, embeddingKey) {
  if (!embeddingKey) return null
  return openaiEmbed(text, embeddingKey, 'https://api.openai.com/v1')
}

// Returns true if text is too similar to any existing entry.
// Rules:
//   both have embeddings  → cosine similarity (accurate)
//   both have null        → trigram Jaccard (best we can do)
//   one side is null      → skip (can't compare accurately; don't block generation)
export function isDuplicate(text, embedding, existingEntries) {
  for (const entry of existingEntries) {
    if (embedding && entry.embedding) {
      if (cosineSimilarity(embedding, entry.embedding) >= SIMILARITY_THRESHOLD) return true
    } else if (!embedding && !entry.embedding) {
      if (jaccardSim(text, entry.text) >= JACCARD_THRESHOLD) return true
    }
    // mismatched (one null, one not): skip — can't do a meaningful comparison
  }
  return false
}
