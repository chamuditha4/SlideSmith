import { uploadMedia, createPost } from '../server/postbridge.js'
import { logger } from '../server/log.js'

const schedLog = logger('schedule')

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  try {
    const { postbridgeKey, id, caption, slides, socialAccounts, scheduledAt, mode } = req.body || {}
    if (!socialAccounts?.length) throw new Error('Pick at least one social account.')
    if (!slides?.length) throw new Error('No slide images to upload.')

    const when = mode === 'schedule' ? (scheduledAt ? `scheduled for ${scheduledAt}` : 'scheduled') : 'draft'
    schedLog.start(`Posting ${id || 'slideshow'} → ${when} · ${socialAccounts.length} account(s)`)

    let done = 0
    const mediaIds = await Promise.all(
      slides.map(async (slide, i) => {
        const buffer = Buffer.from(String(slide).replace(/^data:image\/\w+;base64,/, ''), 'base64')
        const mediaId = await uploadMedia(postbridgeKey, {
          buffer,
          mimeType: 'image/png',
          name: `${id || 'slide'}-${i + 1}.png`,
        })
        schedLog.progress(++done, slides.length, 'slides uploaded')
        return mediaId
      })
    )

    schedLog.step('creating post on post-bridge…')
    const post = await createPost(postbridgeKey, {
      caption,
      mediaIds,
      socialAccounts,
      scheduledAt: mode === 'schedule' ? scheduledAt : null,
      isDraft: mode !== 'schedule',
    })

    schedLog.ok(`Done — ${mode === 'schedule' ? 'scheduled' : 'saved as draft'}`)
    res.json(post)
  } catch (e) {
    console.error('[schedule]', e)
    res.status(500).json({ error: e.message || String(e) })
  }
}
