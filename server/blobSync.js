import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN

// Log once at startup so Vercel function logs immediately show blob status.
if (TOKEN) {
  const storeHint = TOKEN.split('_rw_')[1]?.split('_')[0] || '?'
  console.log(`[blob] ready — store ${storeHint}`)
} else {
  console.log('[blob] BLOB_READ_WRITE_TOKEN not set — state will reset on cold start')
}

// Derive the private-blob base URL from the token.
// Token format: vercel_blob_rw_<storeId>_<secret>
function blobUrl(key) {
  const storeId = TOKEN?.split('_rw_')[1]?.split('_')[0]?.toLowerCase()
  if (!storeId) return null
  return `https://${storeId}.private.blob.vercel-storage.com/${key}`
}

// Download a private blob by pathname. Returns text content, or null if not found.
// Uses direct fetch instead of the SDK's get() to avoid stream consumption issues.
async function pull(key) {
  const url = blobUrl(key)
  if (!url) return null
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return res.text()
}

// Upload a private blob by pathname using the SDK (known to work for put).
async function push(key, body) {
  const { put } = await import('@vercel/blob')
  const result = await put(key, body, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    token: TOKEN,
  })
  console.log('[blob] wrote', key, result.url ? '✓' : '?')
}

// Tracks in-flight blob uploads so flushBlobSyncs() can await them all.
const _pending = new Set()

// Called once at cold-start: pull all state JSON from blob into `dir`.
export async function restoreFromBlob(dir) {
  if (!TOKEN) return
  await Promise.all(
    ['config.json', 'queue.json', 'library.json'].map(async (f) => {
      try {
        const content = await pull(`slidesmith/${f}`)
        if (content == null) {
          console.log(`[blob] ${f} not in store yet — starting fresh`)
          return
        }
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, f), content)
        console.log(`[blob] restored ${f} (${content.length}B)`)
      } catch (e) {
        console.error('[blob] restore FAILED for', f, ':', e.message)
      }
    })
  )
}

// Called after each local write: enqueues a push to Vercel Blob and registers
// the promise in _pending so flushBlobSyncs() can await it before responding.
export function syncToBlob(localPath, content) {
  if (!TOKEN) return
  const key = 'slidesmith/' + localPath.split('/').pop()
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  const p = push(key, body)
    .catch((e) => console.error('[blob] sync FAILED for', key, ':', e.message))
    .finally(() => _pending.delete(p))
  _pending.add(p)
}

// Awaits all in-flight blob uploads. Called by the h() wrapper in app.js before
// sending each HTTP response so the Lambda cannot freeze mid-write on Vercel.
export async function flushBlobSyncs() {
  if (!TOKEN || !_pending.size) return
  await Promise.allSettled([..._pending])
}
