// Vercel entry point. Exports the shared Express app so Vercel can route
// all /api/* requests to it as a single serverless function.
// SLIDESMITH_DIR is set to /tmp/slidesmith in vercel.json so store.js and
// library.js write to the Lambda's writable /tmp directory.
export { app as default } from '../server/app.js'
