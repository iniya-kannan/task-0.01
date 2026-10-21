// Provider-agnostic LLM helper. Picks the first provider with a key set,
// or the one named in LLM_PROVIDER. Model can be overridden with LLM_MODEL.
const PROVIDERS = {
  anthropic: { key: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5' },
  groq: { key: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', json: true },
  gemini: { key: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  openai: { key: 'OPENAI_API_KEY', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', json: true },
  // Any OpenAI-compatible endpoint (OpenRouter, Together, local Ollama…): set LLM_API_KEY + LLM_BASE_URL + LLM_MODEL
  custom: { key: 'LLM_API_KEY', model: 'gpt-4o-mini' },
};
PROVIDERS.custom.base = process.env.LLM_BASE_URL;

export function pickProvider() {
  const forced = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (forced && PROVIDERS[forced] && process.env[PROVIDERS[forced].key]) return forced;
  if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL) return 'custom';
  for (const name of ['anthropic', 'groq', 'gemini', 'openai']) {
    if (process.env[PROVIDERS[name].key]) return name;
  }
  return null;
}

export function modelFor(name) {
  return process.env.LLM_MODEL || PROVIDERS[name]?.model;
}

// messages: [{role:'user'|'assistant', content:string}]
export async function complete({ system, messages, maxTokens = 300, temperature = 0.7, json = false }) {
  const name = pickProvider();
  if (!name) throw new Error('No LLM API key configured. Set GROQ_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  const p = PROVIDERS[name];
  const key = process.env[p.key];
  const model = modelFor(name);

  if (name === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${data?.error?.message || JSON.stringify(data)}`);
    return (data.content || []).map(c => c.text || '').join('').trim();
  }

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  if (json && p.json) body.response_format = { type: 'json_object' };
  // Reasoning models (gpt-oss, qwen3…) spend tokens thinking before answering.
  // Keep thinking short for low call latency, and leave room for the answer.
  if (/gpt-oss|qwen3|o\d|reasoning/i.test(model)) {
    body.max_tokens = Math.max(maxTokens * 4, 1200);
    if (name === 'groq' && /gpt-oss/i.test(model)) {
      body.reasoning_effort = 'low';
      body.include_reasoning = false;
    }
  }
  const r = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${name} ${r.status}: ${data?.error?.message || JSON.stringify(data)}`);
  return (data.choices?.[0]?.message?.content || '').trim();
}

// Ensure alternating roles starting with 'user' (required by some providers).
export function normalizeMessages(list) {
  const out = [{ role: 'user', content: '[Call connected. The customer has picked up the phone.]' }];
  for (const m of list || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content || '').slice(0, 2000).trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last.role === role) last.content += '\n' + content;
    else out.push({ role, content });
  }
  // Keep context bounded: opener + the most recent turns, still starting with 'user'.
  if (out.length > 41) {
    let tail = out.slice(-40);
    if (tail[0].role === 'assistant') tail = tail.slice(1);
    return [{ role: 'user', content: out[0].content + '\n(Earlier part of the call omitted.)\n' + tail[0].content }, ...tail.slice(1)];
  }
  return out;
}

export function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('No JSON in model output');
  return JSON.parse(text.slice(s, e + 1));
}
