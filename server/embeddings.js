// Semantic deduplication for generated slide hooks.
// Primary: OpenAI text-embedding-3-small via a dedicated embeddingKey (set in
//   Settings → Embedding key). Works regardless of which generation provider is active.
// Fallback: character trigram Jaccard similarity (no API key required).

const EMBED_DIM = 256
export const SIMILARITY_THRESHOLD = 0.85  // cosine — below this = unique enough
const JACCARD_THRESHOLD = 0.5             // trigram Jaccard fallback threshold

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
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text, dimensions: EMBED_DIM }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Embeddings ${res.status}: ${body?.error?.message || res.statusText}`)
  return body?.data?.[0]?.embedding ?? null
}

// Returns a 256-dim float array, or null (triggers trigram fallback during comparison).
// embeddingKey is the dedicated OpenAI key from Settings — independent of the
// generation provider so you can use DeepSeek/Claude for writing and OpenAI for dedup.
export async function embedText(text, embeddingKey) {
  if (!embeddingKey) return null
  try {
    return await openaiEmbed(text, embeddingKey, 'https://api.openai.com/v1')
  } catch (e) {
    console.warn('[embed] API failed, using trigram fallback:', e.message)
    return null
  }
}

// Returns true if text is too similar to any existing entry.
// Uses cosine similarity when embeddings are available on both sides;
// falls back to trigram Jaccard otherwise.
export function isDuplicate(text, embedding, existingEntries) {
  for (const entry of existingEntries) {
    if (embedding && entry.embedding) {
      if (cosineSimilarity(embedding, entry.embedding) >= SIMILARITY_THRESHOLD) return true
    } else {
      if (jaccardSim(text, entry.text) >= JACCARD_THRESHOLD) return true
    }
  }
  return false
}
