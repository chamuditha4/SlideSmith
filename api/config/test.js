import { validateKey } from '../../server/providers.js'
import { listAccounts } from '../../server/postbridge.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { keys, provider } = req.body || {}
  const result = { postbridge: false, ai: false, apify: false, errors: {} }

  if (keys?.postbridge) {
    try { await listAccounts(keys.postbridge); result.postbridge = true }
    catch (e) { result.errors.postbridge = e.message }
  }

  const activeKey = keys?.[provider] || ''
  if (activeKey) {
    try { await validateKey(activeKey, provider); result.ai = true }
    catch (e) { result.errors.ai = e.message }
  }

  if (keys?.apify) {
    try {
      const r = await fetch(`https://api.apify.com/v2/users/me?token=${keys.apify}`)
      if (!r.ok) throw new Error(`invalid key (${r.status})`)
      result.apify = true
    } catch (e) { result.errors.apify = e.message }
  }

  res.json(result)
}
