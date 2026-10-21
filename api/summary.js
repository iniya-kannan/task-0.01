import { complete, extractJson } from '../lib/llm.js';
import { summarySystemPrompt, STATUSES } from '../lib/prompts.js';
import { readJson, sendJson, onlyPost } from '../lib/http.js';

const arr = v => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 8) : []);

export default async function handler(req, res) {
  if (!onlyPost(req, res)) return;
  try {
    const body = await readJson(req);
    const transcript = (body.transcript || [])
      .map(m => `${m.role === 'bot' ? 'AGENT' : 'CUSTOMER'}: ${String(m.text || '').slice(0, 1500)}`)
      .join('\n')
      .slice(-30000);

    const raw = await complete({
      system: summarySystemPrompt(body.productName || 'the product'),
      messages: [{ role: 'user', content: `Call language: ${body.langName || 'English'}\nEnded by: ${body.endedBy || 'unknown'}\n\nTRANSCRIPT:\n${transcript}` }],
      maxTokens: 900,
      temperature: 0.2,
      json: true,
    });

    const j = extractJson(raw);
    const status = STATUSES.find(s => s.toLowerCase() === String(j.status || '').toLowerCase().trim()) || 'Follow-up Required';
    sendJson(res, 200, {
      summary: String(j.summary || ''),
      customerName: j.customerName && j.customerName !== 'null' ? String(j.customerName) : null,
      requirements: arr(j.requirements),
      objections: arr(j.objections),
      nextSteps: arr(j.nextSteps),
      status,
      statusReason: String(j.statusReason || ''),
      sentiment: ['positive', 'neutral', 'negative'].includes(j.sentiment) ? j.sentiment : 'neutral',
      interestScore: Math.max(0, Math.min(100, Number(j.interestScore) || 0)),
    });
  } catch (e) {
    console.error('summary error', e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
}
