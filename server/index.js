// Local development entry point. Imports the shared Express app and starts
// the HTTP server on localhost. On Vercel, api/index.js is used instead.
import { app } from './app.js'
import { logger } from './log.js'
import { CONFIG_DIR } from './store.js'
import { restoreFromBlob } from './blobSync.js'

await restoreFromBlob(CONFIG_DIR)

const PORT = process.env.PORT || 8787
const HOST = process.env.HOST || '127.0.0.1'

app.listen(PORT, HOST, () => {
  const log = logger('server')
  log.ok(`http://localhost:${PORT} (bound to ${HOST})`)
  log.info(`Config + queue stored in ${CONFIG_DIR}`)
})
