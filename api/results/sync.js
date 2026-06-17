import { syncAnalytics, listAnalytics } from '../../server/postbridge.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  try {
    const { postbridgeKey } = req.body || {}
    // Swallow rate-limit errors from sync — still return whatever is cached.
    try { await syncAnalytics(postbridgeKey) } catch (e) { console.warn('[results/sync] skipped:', e.message) }
    res.json(await listAnalytics(postbridgeKey))
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) })
  }
}
