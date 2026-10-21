import { pickProvider, modelFor } from '../lib/llm.js';
import { ttsEnabled } from './tts.js';
import { sendJson } from '../lib/http.js';

export default function handler(req, res) {
  const provider = pickProvider();
  sendJson(res, 200, {
    provider,
    model: provider ? modelFor(provider) : null,
    tts: ttsEnabled() ? 'server' : 'browser',
  });
}
