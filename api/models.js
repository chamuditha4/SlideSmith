import { listModels } from '../server/providers.js'

export default async function handler(req, res) {
  const provider = req.query.provider || 'openrouter'
  try {
    res.json(await listModels(provider))
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) })
  }
}
