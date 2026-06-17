import { listPosts } from '../server/postbridge.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  try {
    const { postbridgeKey } = req.body || {}
    res.json(await listPosts(postbridgeKey))
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) })
  }
}
