// Image proxy: fetches a remote Pinterest/CDN image and returns it with
// CORS-friendly headers so the browser canvas won't be tainted.
export default async function handler(req, res) {
  const { url } = req.query
  if (!url || typeof url !== 'string') return res.status(400).end('Missing url')

  // Only proxy known image hosts to prevent open-redirect abuse.
  let parsed
  try { parsed = new URL(url) } catch { return res.status(400).end('Invalid url') }
  const allowed = ['pinimg.com', 'i.pinimg.com', 'v1.pinimg.com']
  if (!allowed.some((h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
    return res.status(403).end('Host not allowed')
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        Referer: 'https://www.pinterest.com/',
      },
    })
    if (!upstream.ok) return res.status(upstream.status).end()

    const ct = upstream.headers.get('content-type') || 'image/jpeg'
    res.setHeader('Content-Type', ct)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800')

    const buf = Buffer.from(await upstream.arrayBuffer())
    res.end(buf)
  } catch (e) {
    res.status(500).end(e.message)
  }
}
