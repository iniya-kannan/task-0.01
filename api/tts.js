// Optional server-side text-to-speech (OpenAI). When enabled, the bot's voice
// is mixed into the call recording, so recordings contain both sides.
import { readJson, sendJson, onlyPost } from '../lib/http.js';

export function ttsEnabled() {
  return !!process.env.OPENAI_API_KEY && (process.env.TTS_MODE || 'server') !== 'browser';
}

export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  if (!ttsEnabled()) return sendJson(res, 404, { error: 'Server TTS not configured' });
  try {
    const { text } = await readJson(req);
    const input = String(text || '').slice(0, 1200);
    if (!input) return sendJson(res, 400, { error: 'No text' });
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.TTS_MODEL || 'tts-1',
        voice: process.env.TTS_VOICE || 'nova',
        input,
        response_format: 'mp3',
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      return sendJson(res, 502, { error: `TTS ${r.status}: ${err.slice(0, 300)}` });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  } catch (e) {
    console.error('tts error', e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
}
