import { complete, normalizeMessages } from '../lib/llm.js';
import { salesSystemPrompt } from '../lib/prompts.js';
import { readJson, sendJson, onlyPost } from '../lib/http.js';

export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  try {
    const body = await readJson(req);
    const system = salesSystemPrompt({
      product: body.product,
      langName: body.langName || 'English',
      customerName: body.customerName,
      consent: !!body.consent,
    });
    const reply = await complete({
      system,
      messages: normalizeMessages(body.messages),
      maxTokens: 220,
      temperature: 0.7,
    });
    sendJson(res, 200, { reply });
  } catch (e) {
    console.error('chat error', e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
}
