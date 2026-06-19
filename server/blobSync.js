// Persistent storage adapter for Vercel deployments. When BLOB_READ_WRITE_TOKEN
// is set, the three state JSON files (config, queue, library index) are mirrored
// to Vercel Blob so they survive cold starts. Without the token the module is a
// no-op and all I/O stays local — local dev is unaffected.
//
// Upload tracking: syncToBlob() registers each upload in _pending. The h()
// wrapper in app.js intercepts res.json() to call flushBlobSyncs() before the
// HTTP response bytes are actually sent — so the Lambda cannot be frozen until
// all writes have landed in Blob.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN

// Download a private blob by pathname. Returns the text content, or null if the
// blob doesn't exist yet (404). The get() function derives the store URL from
// the token so we never need to list() or hardcode a store URL.
async function pull(key) {
  const { get } = await import('@vercel/blob')
  const result = await get(key, { access: 'private', token: TOKEN, useCache: false })
  if (!result || !result.stream) return null
  // result.stream is the WHATWG ReadableStream from the underlying fetch response.
  return new Response(result.stream).text()
}

// Upload a private blob by pathname. addRandomSuffix: false keeps the pathname
// stable so we can re-read it by the same key on the next cold start.
async function push(key, body) {
  const { put } = await import('@vercel/blob')
  await put(key, body, {
    access: 'private',
    addRandomSuffix: false,
    contentType: 'application/json',
    token: TOKEN,
  })
}

// Tracks in-flight blob uploads so flushBlobSyncs() can await them all.
const _pending = new Set()

// Called once at Vercel cold-start: pull all state JSON from blob into `dir`.
export async function restoreFromBlob(dir) {
  if (!TOKEN) return
  await Promise.all(
    ['config.json', 'queue.json', 'library.json'].map(async (f) => {
      try {
        const content = await pull(`slidesmith/${f}`)
        if (content == null) return
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, f), content)
        console.log('[blob] restored', f)
      } catch (e) {
        console.warn('[blob] restore failed for', f, ':', e.message)
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
    .catch((e) => console.warn('[blob] sync failed for', key, ':', e.message))
    .finally(() => _pending.delete(p))
  _pending.add(p)
}

// Awaits all in-flight blob uploads. Called by the h() wrapper in app.js before
// sending each HTTP response so writes are durable before the Lambda can freeze.
export async function flushBlobSyncs() {
  if (!TOKEN || !_pending.size) return
  await Promise.allSettled([..._pending])
}
