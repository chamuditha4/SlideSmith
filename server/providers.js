// Multi-provider AI client. Supports OpenRouter, OpenAI, DeepSeek, and Anthropic Claude.
// All providers go through chatJSON({ apiKey, model, prompt, provider }).
const OPENAI_COMPAT_BASES = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai:     'https://api.openai.com/v1',
  deepseek:   'https://api.deepseek.com/v1',
}

const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://github.com/slidesmith',
  'X-Title': 'Slidesmith',
}

export const PROVIDER_LABELS = {
  openrouter: 'OpenRouter',
  openai:     'OpenAI',
  deepseek:   'DeepSeek',
  claude:     'Claude',
}

export const STATIC_MODELS = {
  openai: [
    { id: 'gpt-4o',       name: 'GPT-4o' },
    { id: 'gpt-4o-mini',  name: 'GPT-4o mini' },
    { id: 'gpt-4-turbo',  name: 'GPT-4 Turbo' },
    { id: 'gpt-4',        name: 'GPT-4' },
    { id: 'o1',           name: 'o1' },
    { id: 'o1-mini',      name: 'o1-mini' },
    { id: 'o3-mini',      name: 'o3-mini' },
  ],
  deepseek: [
    { id: 'deepseek-chat',      name: 'DeepSeek Chat (V3)' },
    { id: 'deepseek-reasoner',  name: 'DeepSeek Reasoner (R1)' },
  ],
  claude: [
    { id: 'claude-opus-4-8',          name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-6',        name: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    { id: 'claude-opus-4-5',          name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-5',        name: 'Claude Sonnet 4.5' },
  ],
}

export const DEFAULT_MODELS = {
  openrouter: 'openai/gpt-4o-mini',
  openai:     'gpt-4o-mini',
  deepseek:   'deepseek-chat',
  claude:     'claude-sonnet-4-6',
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('Model did not return JSON.')
  return JSON.parse(candidate.slice(start, end + 1))
}

async function chatOpenAICompat({ base, apiKey, model, prompt, extraHeaders = {}, jsonMode = true }) {
  const payload = {
    model,
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }],
  }
  if (jsonMode) payload.response_format = { type: 'json_object' }

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${res.status}: ${body?.error?.message || res.statusText}`)
  const content = body?.choices?.[0]?.message?.content
  if (!content) throw new Error('Provider returned no content.')
  return extractJson(content)
}

async function chatAnthropic({ apiKey, model, prompt }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body?.error?.message || res.statusText}`)
  const content = body?.content?.[0]?.text
  if (!content) throw new Error('Anthropic returned no content.')
  return extractJson(content)
}

export async function chatJSON({ apiKey, model, prompt, provider = 'openrouter' }) {
  const label = PROVIDER_LABELS[provider] || provider
  if (!apiKey) throw new Error(`Missing ${label} API key. Add it in Settings.`)
  if (!model) throw new Error('No model selected. Pick one in Settings.')

  if (provider === 'claude') return chatAnthropic({ apiKey, model, prompt })

  const base = OPENAI_COMPAT_BASES[provider] || OPENAI_COMPAT_BASES.openrouter
  const extraHeaders = provider === 'openrouter' ? OPENROUTER_HEADERS : {}
  // deepseek-reasoner doesn't support json_object response_format — rely on extractJson
  const jsonMode = provider !== 'deepseek'
  return chatOpenAICompat({ base, apiKey, model, prompt, extraHeaders, jsonMode })
}

export async function validateKey(apiKey, provider = 'openrouter') {
  const label = PROVIDER_LABELS[provider] || provider
  if (!apiKey) throw new Error(`Missing ${label} API key.`)

  switch (provider) {
    case 'openrouter': {
      const res = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: invalid key`)
      return true
    }
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) throw new Error(`OpenAI ${res.status}: invalid key`)
      return true
    }
    case 'deepseek': {
      const res = await fetch('https://api.deepseek.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: invalid key`)
      return true
    }
    case 'claude': {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      })
      if (!res.ok) throw new Error(`Anthropic ${res.status}: invalid key`)
      return true
    }
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }
}

export async function listModels(provider = 'openrouter') {
  if (provider !== 'openrouter') return STATIC_MODELS[provider] || []

  const res = await fetch('https://openrouter.ai/api/v1/models')
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`)
  const body = await res.json()
  return (body?.data || [])
    .map((m) => ({ id: m.id, name: m.name || m.id }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
