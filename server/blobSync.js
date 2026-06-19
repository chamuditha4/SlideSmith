// Persistent storage adapter for Vercel deployments. When BLOB_READ_WRITE_TOKEN
// is set, the three state JSON files (config, queue, library index) are mirrored
// to Vercel Blob so they survive cold starts. Without the token the module is a
// no-op and all I/O stays local — local dev is unaffected.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN

// Lazy-import @vercel/blob only when a token is present so local dev without
// the env var doesn't require the package to be resolvable.
let _sdk = null
async function sdk() {
  if (!_sdk) _sdk = await import('@vercel/blob')
  return _sdk
}

async function pull(key) {
  const { list } = await sdk()
  const { blobs } = await list({ prefix: key, limit: 1 })
  const match = blobs.find((b) => b.pathname === key)
  if (!match) return null
  // Bypass CDN cache so we always get the freshest version.
  const res = await fetch(match.url + '?t=' + Date.now())
  if (!res.ok) return null
  return res.text()
}

async function push(key, body) {
  const { put } = await sdk()
  await put(key, body, {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  })
}

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

// Called after each local write: fire-and-forget push to Vercel Blob.
export function syncToBlob(localPath, content) {
  if (!TOKEN) return
  const key = 'slidesmith/' + localPath.split('/').pop()
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  push(key, body).catch((e) => console.warn('[blob] sync failed for', key, ':', e.message))
}
