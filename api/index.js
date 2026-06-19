// Vercel entry point. Exports the shared Express app so Vercel can route
// all /api/* requests to it as a single serverless function.
// SLIDESMITH_DIR is set to /tmp/slidesmith in vercel.json so store.js and
// library.js write to the Lambda's writable /tmp directory.
//
// When BLOB_READ_WRITE_TOKEN is set, state JSON files are pulled from Vercel
// Blob on cold start so settings and queue survive across Lambda instances.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { restoreFromBlob } from '../server/blobSync.js'

const dir = process.env.SLIDESMITH_DIR || join(homedir(), '.slidesmith')
await restoreFromBlob(dir)

export { app as default } from '../server/app.js'
