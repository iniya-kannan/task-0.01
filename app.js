/* VoiceCloser – AI voice sales agent (frontend)
 * Speech-to-text: Web Speech API (SpeechRecognition)
 * Text-to-speech: server TTS (if configured, mixed into recording) or browser speechSynthesis
 * Brain: /api/chat  ·  Analysis: /api/summary  ·  Storage: IndexedDB
 */
(() => {
'use strict';

const $ = s => document.querySelector(s);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const STATUSES = ['Converted', 'Demo Requested', 'Interested', 'Follow-up Required', 'Not Interested', 'No Response'];

const LANGS = {
  'en-IN': { label: 'English (India)', name: 'English', still: 'Hello, are you still there?', bye: "It seems we got disconnected. I'll try you again later. Thank you!", sorry: "Sorry, I didn't quite catch that. Could you say it again?" },
  'en-US': { label: 'English (US)', name: 'English', still: 'Hello, are you still there?', bye: "It seems we got disconnected. I'll try you again later. Thank you!", sorry: "Sorry, I didn't quite catch that. Could you say it again?" },
  'hi-IN': { label: 'हिन्दी · Hindi', name: 'Hindi', still: 'हैलो, क्या आप मुझे सुन पा रहे हैं?', bye: 'लगता है कॉल कट गई है। मैं आपसे बाद में फिर संपर्क करूँगी। धन्यवाद!', sorry: 'माफ़ कीजिए, मैं ठीक से सुन नहीं पाई। क्या आप दोबारा बोल सकते हैं?' },
  'te-IN': { label: 'తెలుగు · Telugu', name: 'Telugu', still: 'హలో, మీరు నా మాట వింటున్నారా?', bye: 'కాల్ కట్ అయినట్టుంది. నేను మళ్ళీ తర్వాత సంప్రదిస్తాను. ధన్యవాదాలు!', sorry: 'క్షమించండి, నాకు సరిగ్గా వినిపించలేదు. మళ్ళీ చెప్పగలరా?' },
};

const SAMPLE_PRODUCT = {
  name: 'FlowDesk',
  details: `FlowDesk is an AI-powered customer support helpdesk for small and mid-sized businesses.

Key features:
- One shared inbox for WhatsApp, email, Instagram and website chat
- AI assistant that drafts replies and auto-resolves common questions (around 40% of tickets)
- Ticket assignment, SLAs, tags and canned replies
- Integrations: Shopify, Razorpay, Zoho CRM
- Analytics: response time, customer satisfaction (CSAT), agent performance

Pricing:
- Starter: ₹999 per agent per month (up to 3 agents, shared inbox)
- Growth: ₹1,999 per agent per month (AI assistant + all integrations)
- Enterprise: custom pricing
- 14-day free trial, no credit card needed. 20% off with annual billing.

Setup takes about 15 minutes. Data hosted in India (Mumbai), DPDP and GDPR compliant.
24x7 chat support; free onboarding call on Growth.

Goal of the call: get the customer to start the free trial, or book a 30-minute demo.`,
};

/* ---------------- storage ---------------- */
const DB = {
  p: null,
  open() {
    return this.p ||= new Promise((res, rej) => {
      const r = indexedDB.open('voicecloser', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('calls', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('calls', mode);
      const req = fn(t.objectStore('calls'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  put(rec) { return this.run('readwrite', s => s.put(rec)); },
  all() { return this.run('readonly', s => s.getAll()); },
  del(id) { return this.run('readwrite', s => s.delete(id)); },
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------------- state ---------------- */
let cfg = { provider: null, tts: 'browser' };
let active = false;
let call = null;              // current call object
let timerInt = null;
let audio = {};               // ctx, mic, recorder, chunks, analyser, botBus
let currentRec = null;        // SpeechRecognition in use
let listenFinish = null;      // resolves current listen() early
let currentSource = null;     // server-TTS buffer source
let interimEl = null;
let micBlocked = false;
let historyCache = [];
const objectUrls = new Map();

/* ---------------- helpers ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = sec => { sec = Math.max(0, Math.round(sec)); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };
const L = () => LANGS[call?.lang] || LANGS['en-IN'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const elapsed = () => call ? (Date.now() - call.startedAt) / 1000 : 0;

const STATUS_LABELS = { idle: 'Ready', connecting: 'Connecting…', speaking: 'Agent speaking', listening: 'Listening…', thinking: 'Agent thinking…', analyzing: 'Analyzing call…', ended: 'Call ended' };
function setStatus(s) {
  $('#statusPill').dataset.s = s;
  $('#statusText').textContent = STATUS_LABELS[s] || s;
  if (call) call.status = s;
}

/* ---------------- setup UI ---------------- */
function initSetup() {
  const langSel = $('#lang');
  for (const [code, l] of Object.entries(LANGS)) langSel.add(new Option(l.label, code));
  langSel.value = ls.get('vc.lang', 'en-IN');
  langSel.onchange = () => ls.set('vc.lang', langSel.value);

  const prod = ls.get('vc.product', SAMPLE_PRODUCT);
  $('#prodName').value = prod.name;
  $('#prodDetails').value = prod.details;
  $('#productNameLabel').textContent = prod.name || 'Product';
  const saveProd = () => {
    const p = { name: $('#prodName').value.trim() || 'Product', details: $('#prodDetails').value.trim() };
    ls.set('vc.product', p);
    $('#productNameLabel').textContent = p.name;
  };
  $('#prodName').oninput = saveProd;
  $('#prodDetails').oninput = saveProd;
  $('#resetProduct').onclick = () => { $('#prodName').value = SAMPLE_PRODUCT.name; $('#prodDetails').value = SAMPLE_PRODUCT.details; saveProd(); };

  const f = $('#statusFilter');
  for (const s of STATUSES) f.add(new Option(s, s));
  f.onchange = renderHistory;

  if (!SR) $('#browserWarn').classList.remove('hidden');
  if ('speechSynthesis' in window) { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices(); }

  $('#startBtn').onclick = startCall;
  $('#endBtn').onclick = () => endCall('customer');
  $('#typeForm').onsubmit = e => {
    e.preventDefault();
    const v = $('#typeInput').value.trim();
    if (!v || !active) return;
    $('#typeInput').value = '';
    if (listenFinish) listenFinish(v);
    else (call.typedQueue ||= []).push(v);
  };
  $('#detailClose').onclick = closeDetail;
  $('#detailModal').onclick = e => { if (e.target.id === 'detailModal') closeDetail(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
  window.addEventListener('beforeunload', e => { if (active) { e.preventDefault(); e.returnValue = ''; } });
  drawMeterIdle();
}

async function loadConfig() {
  const el = $('#engineInfo');
  try {
    cfg = await (await fetch('/api/config')).json();
    if (!cfg.provider) { el.textContent = 'No AI key configured on server'; el.classList.add('bad'); return; }
    el.textContent = `AI: ${cfg.provider} · ${cfg.model} · Voice: ${cfg.tts === 'server' ? 'neural TTS' : 'browser TTS'}`;
  } catch {
    el.textContent = 'Backend not reachable'; el.classList.add('bad');
  }
}

/* ---------------- consent ---------------- */
function askConsent() {
  return new Promise(resolve => {
    const m = $('#consentModal');
    m.classList.remove('hidden');
    $('#consentOk').focus();
    const done = v => { m.classList.add('hidden'); $('#consentOk').onclick = $('#consentCancel').onclick = null; resolve(v); };
    $('#consentOk').onclick = () => done({ go: true, consent: $('#consentCheck').checked });
    $('#consentCancel').onclick = () => done({ go: false });
  });
}

/* ---------------- audio: mic, recording, meter ---------------- */
async function setupAudio(record) {
  // With browser TTS we leave echo cancellation off so the agent's voice coming
  // out of the speakers is also captured in the recording.
  const serverVoice = cfg.tts === 'server';
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: serverVoice, noiseSuppression: true, autoGainControl: true } });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(mic);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const botBus = ctx.createGain();
  botBus.connect(ctx.destination);
  botBus.connect(analyser);
  audio = { ctx, mic, analyser, botBus, recorder: null, chunks: [] };

  if (record && window.MediaRecorder) {
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    botBus.connect(dest);
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(m => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = e => { if (e.data && e.data.size) audio.chunks.push(e.data); };
    rec.start(1000);
    audio.recorder = rec;
    $('#recBadge').classList.remove('hidden');
  }
  drawMeterLive();
}

function stopRecorder() {
  return new Promise(resolve => {
    const r = audio.recorder;
    if (!r || r.state === 'inactive') return resolve(null);
    r.onstop = () => resolve(audio.chunks.length ? new Blob(audio.chunks, { type: r.mimeType || 'audio/webm' }) : null);
    try { r.stop(); } catch { resolve(null); }
  });
}

function teardownAudio() {
  try { audio.mic?.getTracks().forEach(t => t.stop()); } catch {}
  try { audio.ctx?.close(); } catch {}
  cancelAnimationFrame(audio.raf);
  audio = {};
  $('#recBadge').classList.add('hidden');
  drawMeterIdle();
}

function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
function meterColor() { return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4f46e5'; }
function drawMeterIdle() {
  const c = $('#meter'); const { g, w, h } = sizeCanvas(c);
  g.clearRect(0, 0, w, h);
  const bars = 40, bw = w / bars;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--line').trim();
  for (let i = 0; i < bars; i++) g.fillRect(i * bw + 1, h / 2 - 1.5, bw - 2, 3);
}
function drawMeterLive() {
  const c = $('#meter');
  const data = new Uint8Array(audio.analyser.frequencyBinCount);
  const color = meterColor();
  const bars = 40;
  const levels = new Array(bars).fill(0);
  const tick = () => {
    if (!audio.analyser) return;
    const { g, w, h } = sizeCanvas(c);
    audio.analyser.getByteFrequencyData(data);
    const bw = w / bars;
    g.clearRect(0, 0, w, h);
    g.fillStyle = color;
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor(Math.pow(i / bars, 1.6) * data.length * 0.6);
      const v = data[idx] / 255;
      levels[i] = Math.max(v, levels[i] * 0.85);
      const bh = Math.max(3, levels[i] * h * 0.95);
      g.globalAlpha = 0.35 + levels[i] * 0.65;
      g.fillRect(i * bw + 1, (h - bh) / 2, bw - 2, bh);
    }
    g.globalAlpha = 1;
    audio.raf = requestAnimationFrame(tick);
  };
  tick();
}

/* ---------------- speech output ---------------- */
async function speak(text) {
  if (!active || !text) return;
  setStatus('speaking');
  if (cfg.tts === 'server') {
    try { await speakServer(text); return; } catch (e) { console.warn('Server TTS failed, using browser voice', e); }
  }
  await speakBrowser(text);
}

async function speakServer(text) {
  const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang: call.lang }) });
  if (!r.ok) throw new Error('TTS ' + r.status);
  const buf = await audio.ctx.decodeAudioData(await r.arrayBuffer());
  if (!active) return;
  await new Promise(resolve => {
    const s = audio.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(audio.botBus);
    s.onended = () => { currentSource = null; resolve(); };
    currentSource = s;
    s.start();
  });
}

function pickVoice(lang) {
  const vs = speechSynthesis.getVoices();
  const norm = v => v.lang.replace('_', '-').toLowerCase();
  const want = lang.toLowerCase(), base = want.split('-')[0];
  const cands = vs.filter(v => norm(v) === want).concat(vs.filter(v => norm(v).startsWith(base)));
  // Prefer natural/online voices (Google, Microsoft Online) and female for "Aria"
  return cands.find(v => /google|natural|online/i.test(v.name) && /female|swara|aria|neerja|shruti|heera|kalpana|mohan|google/i.test(v.name))
      || cands.find(v => /google|natural|online/i.test(v.name)) || cands[0] || null;
}

function speakBrowser(text) {
  if (!('speechSynthesis' in window)) return sleep(300);
  return new Promise(resolve => {
    const parts = text.match(/[^.!?।]+[.!?।]*\s*/g) || [text];
    const voice = pickVoice(call.lang);
    let i = 0;
    speechSynthesis.cancel();
    const next = () => {
      if (i >= parts.length || !active) return resolve();
      const chunk = parts[i++].trim();
      if (!chunk) return next();
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = call.lang; if (voice) u.voice = voice; u.rate = 1.03; u.pitch = 1;
      let moved = false;
      const go = () => { if (moved) return; moved = true; clearTimeout(guard); next(); };
      // Chrome occasionally never fires onend; guard with a timeout.
      const guard = setTimeout(go, 2500 + chunk.length * 110);
      u.onend = go; u.onerror = go;
      speechSynthesis.speak(u);
    };
    next();
  });
}

function stopSpeaking() {
  try { speechSynthesis.cancel(); } catch {}
  try { currentSource?.stop(); } catch {}
  currentSource = null;
}

/* ---------------- speech input ---------------- */
function listen(maxWaitMs) {
  return new Promise(resolve => {
    setStatus('listening');
    $('#typeInput').placeholder = 'Listening… or type your reply here';

    // A reply typed while the agent was talking
    if (call.typedQueue?.length) return resolve(call.typedQueue.shift());

    let finalText = '', done = false, heard = false, silenceTimer = null, rec = null;
    const finish = override => {
      if (done) return;
      done = true;
      clearTimeout(silenceTimer); clearTimeout(noSpeech);
      listenFinish = null;
      if (rec) { rec.onend = rec.onresult = rec.onerror = null; try { rec.abort(); } catch {} }
      currentRec = null;
      clearInterim();
      resolve(String(override ?? finalText).trim());
    };
    listenFinish = finish;
    // Typing takes longer than talking, so allow more time when voice input is unavailable.
    const noSpeech = setTimeout(() => { if (!heard) finish(); }, (!SR || micBlocked) ? 90000 : maxWaitMs);

    if (!SR || micBlocked) return; // typed replies only

    const startRec = () => {
      rec = new SR();
      currentRec = rec;
      rec.lang = call.lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
      let base = finalText; // text kept across automatic restarts
      rec.onresult = e => {
        heard = true;
        let fin = '', interim = '';
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) fin += r[0].transcript + ' '; else interim += r[0].transcript;
        }
        finalText = (base + ' ' + fin).trim();
        showInterim((finalText + ' ' + interim).trim());
        clearTimeout(silenceTimer);
        // end of turn = a short pause after speech
        silenceTimer = setTimeout(() => { if (finalText || interim) { if (!finalText) finalText = interim; finish(); } }, interim ? 1800 : 1100);
      };
      rec.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          micBlocked = true;
          addMsg('system', 'Speech recognition was blocked. Allow the microphone, or type replies below.');
        } else if (e.error === 'language-not-supported') {
          micBlocked = true;
          addMsg('system', 'This browser cannot recognise speech in the selected language. Type replies below, or switch language.');
        }
      };
      rec.onend = () => {
        if (done) return;
        if (micBlocked) return; // wait for typed input / timeout
        if (finalText) return finish();
        try { startRec(); } catch { /* retried by timeout */ }
      };
      try { rec.start(); } catch (err) { console.warn(err); }
    };
    startRec();
  });
}

function showInterim(text) {
  if (!text) return;
  if (!interimEl) {
    interimEl = makeMsg('customer', '', elapsed());
    interimEl.classList.add('interim');
    $('#chat').appendChild(interimEl);
  }
  interimEl.querySelector('.bubble').textContent = text;
  scrollChat();
}
function clearInterim() { interimEl?.remove(); interimEl = null; }

/* ---------------- chat rendering ---------------- */
function makeMsg(role, text, t) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role !== 'system') {
    const who = role === 'bot' ? 'Aria · AI agent' : (call?.customerName || 'Customer');
    el.innerHTML = `<div class="meta"><span>${esc(who)}</span><span class="mono">${fmt(t)}</span></div>`;
  }
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  el.appendChild(b);
  return el;
}
function addMsg(role, text) {
  const t = elapsed();
  if (role !== 'system') call.transcript.push({ role, text, t: Math.round(t) });
  const chat = $('#chat');
  chat.querySelector('.empty')?.remove();
  const el = makeMsg(role, text, t);
  if (interimEl) chat.insertBefore(el, interimEl); else chat.appendChild(el);
  scrollChat();
}
let thinkingEl = null;
function showThinking(on) {
  if (on && !thinkingEl) {
    thinkingEl = makeMsg('bot', '', elapsed());
    thinkingEl.querySelector('.bubble').innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    $('#chat').appendChild(thinkingEl);
    scrollChat();
  } else if (!on && thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}
function scrollChat() { const c = $('#chat'); c.scrollTop = c.scrollHeight; }

/* ---------------- AI ---------------- */
async function askAgent() {
  const r = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product: call.product,
      langName: L().name,
      customerName: call.customerName,
      consent: call.consent,
      messages: call.transcript.map(m => ({ role: m.role === 'bot' ? 'assistant' : 'user', content: m.text })),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.reply) throw new Error(j.error || `Agent error ${r.status}`);
  return j.reply;
}

async function agentTurn({ first = false } = {}) {
  setStatus('thinking');
  showThinking(true);
  let reply;
  try {
    reply = await askAgent();
  } catch (e) {
    showThinking(false);
    if (!active) return;
    console.error(e);
    addMsg('system', `AI error: ${e.message}`);
    if (first) { await endCall('error'); return; }
    reply = L().sorry;
  }
  showThinking(false);
  if (!active) return;
  let end = false;
  if (/\[END_CALL\]/i.test(reply)) { end = true; reply = reply.replace(/\[END_CALL\]/gi, '').trim(); }
  reply = reply.replace(/[*#_`]/g, '').trim();
  if (reply) { addMsg('bot', reply); await speak(reply); }
  if (end && active) { await sleep(400); await endCall('agent'); }
}

/* ---------------- call lifecycle ---------------- */
async function startCall() {
  if (active) return;
  const c = await askConsent();
  if (!c.go) return;

  const product = ls.get('vc.product', SAMPLE_PRODUCT);
  call = {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
    startedAt: Date.now(),
    lang: $('#lang').value,
    customerName: $('#custName').value.trim() || null,
    product,
    consent: c.consent,
    transcript: [],
    typedQueue: [],
  };
  micBlocked = false;
  active = true;

  // UI
  $('#chat').innerHTML = '';
  $('#result').innerHTML = '<p class="muted">Call in progress…</p>';
  $('#callLabel').textContent = `#${call.id.slice(0, 8)} · ${LANGS[call.lang].label}`;
  $('#startBtn').disabled = true; $('#endBtn').disabled = false;
  $('#typeInput').disabled = false; $('#typeSend').disabled = false;
  $('#lang').disabled = true; $('#custName').disabled = true;
  setStatus('connecting');
  $('#timer').textContent = '00:00';
  timerInt = setInterval(() => { $('#timer').textContent = fmt(elapsed()); }, 500);

  try {
    await setupAudio(call.consent);
  } catch (e) {
    console.error(e);
    addMsg('system', 'Microphone access was denied or unavailable. You can still talk to the agent by typing.');
    micBlocked = true;
  }
  addMsg('system', call.consent ? 'Call connected · recording with consent' : 'Call connected · not recorded');

  await agentTurn({ first: true });
  conversationLoop();
}

async function conversationLoop() {
  let silent = 0;
  while (active) {
    const text = await listen(silent ? 8000 : 11000);
    if (!active) break;
    if (!text) {
      silent++;
      if (silent >= 2) {
        addMsg('bot', L().bye);
        await speak(L().bye);
        await endCall('no-response');
        return;
      }
      addMsg('bot', L().still);
      await speak(L().still);
      continue;
    }
    silent = 0;
    addMsg('customer', text);
    await agentTurn();
  }
}

async function endCall(endedBy = 'customer') {
  if (!active) return;
  active = false;
  clearInterval(timerInt);
  const duration = Math.round(elapsed());
  $('#timer').textContent = fmt(duration);
  if (listenFinish) listenFinish();
  try { currentRec?.abort(); } catch {}
  stopSpeaking();
  showThinking(false);
  clearInterim();
  $('#startBtn').disabled = true; $('#endBtn').disabled = true;
  $('#typeInput').disabled = true; $('#typeSend').disabled = true;
  $('#typeInput').placeholder = 'Noisy room? Type your reply instead…';
  addMsg('system', `Call ended (${endedBy === 'agent' ? 'by agent' : endedBy === 'no-response' ? 'no response' : endedBy === 'error' ? 'error' : 'by customer'}) · ${fmt(duration)}`);

  setStatus('analyzing');
  $('#result').innerHTML = '<div class="loading"><div class="spinner"></div>Generating AI summary and sales status…</div>';

  const recording = await stopRecorder();
  teardownAudio();

  const customerTurns = call.transcript.filter(m => m.role === 'customer');
  let analysis;
  if (!customerTurns.length) {
    analysis = {
      summary: endedBy === 'error'
        ? 'The call could not proceed because the AI engine returned an error.'
        : 'The customer did not respond during the call.',
      customerName: call.customerName, requirements: [], objections: [],
      nextSteps: ['Retry the call at a different time', 'Try reaching the customer on WhatsApp or email'],
      status: 'No Response', statusReason: 'No meaningful reply from the customer.', sentiment: 'neutral', interestScore: 0,
    };
  } else {
    try {
      const r = await fetch('/api/summary', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: call.transcript, productName: call.product.name, langName: L().name, endedBy }),
      });
      analysis = await r.json();
      if (!r.ok) throw new Error(analysis.error || r.status);
    } catch (e) {
      console.error(e);
      analysis = {
        summary: 'AI summary could not be generated (' + (e.message || 'error') + '). See the transcript for details.',
        customerName: call.customerName, requirements: [], objections: [], nextSteps: ['Review the transcript manually'],
        status: 'Follow-up Required', statusReason: 'Automatic analysis failed.', sentiment: 'neutral', interestScore: 0,
      };
    }
  }

  const record = {
    id: call.id,
    startedAt: call.startedAt,
    duration,
    lang: call.lang,
    productName: call.product.name,
    customerName: analysis.customerName || call.customerName,
    consent: call.consent,
    recording,               // Blob or null
    transcript: call.transcript,
    endedBy,
    ...analysis,
  };
  try { await DB.put(record); } catch (e) { console.error('save failed', e); }

  setStatus('ended');
  $('#result').innerHTML = outcomeHtml(record, true);
  attachAudio($('#result'), record);
  $('#startBtn').disabled = false;
  $('#lang').disabled = false; $('#custName').disabled = false;
  await loadHistory();
}

/* ---------------- outcome & history ---------------- */
function list(items) {
  return items && items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted">None noted</p>';
}
function outcomeHtml(r, compact) {
  const date = new Date(r.startedAt);
  return `
    <div class="outcome-head">
      <span class="badge big" data-s="${esc(r.status)}">${esc(r.status)}</span>
      ${compact ? '' : `<span class="muted">${esc(date.toLocaleString())}</span>`}
    </div>
    ${r.statusReason ? `<p class="reason">${esc(r.statusReason)}</p>` : ''}
    <div class="kv">
      <div><span>Duration</span><b class="mono">${fmt(r.duration)}</b></div>
      <div><span>Sentiment</span><b style="text-transform:capitalize">${esc(r.sentiment || '—')}</b></div>
      <div><span>Interest</span><b>${Number(r.interestScore) || 0}%</b><div class="score"><i style="width:${Number(r.interestScore) || 0}%"></i></div></div>
    </div>
    <h4>Summary</h4><p>${esc(r.summary)}</p>
    <h4>Customer requirements</h4>${list(r.requirements)}
    <h4>Objections</h4>${list(r.objections)}
    <h4>Next steps</h4>${list(r.nextSteps)}
    <h4>Recording</h4>
    <div class="audio-slot">${r.recording ? '' : `<p class="muted">${r.consent ? 'No audio captured.' : 'Not recorded (customer did not consent).'}</p>`}</div>
  `;
}
function attachAudio(container, r) {
  if (!r.recording) return;
  let url = objectUrls.get(r.id);
  if (!url) { url = URL.createObjectURL(r.recording); objectUrls.set(r.id, url); }
  const a = document.createElement('audio');
  a.controls = true; a.src = url; a.preload = 'metadata';
  // Chrome's MediaRecorder writes WebM without a duration, which breaks seeking.
  // Seeking far past the end forces the browser to compute the real duration.
  a.addEventListener('loadedmetadata', () => {
    if (a.duration !== Infinity) return;
    const fix = () => { a.removeEventListener('timeupdate', fix); a.currentTime = 0; };
    a.addEventListener('timeupdate', fix);
    a.currentTime = 1e101;
  }, { once: true });
  container.querySelector('.audio-slot').appendChild(a);
  const dl = document.createElement('a');
  dl.href = url; dl.download = `call-${r.id.slice(0, 8)}.${(r.recording.type || '').includes('mp4') ? 'm4a' : 'webm'}`;
  dl.textContent = 'Download recording'; dl.className = 'linkbtn';
  dl.style.display = 'inline-block'; dl.style.marginTop = '6px';
  container.querySelector('.audio-slot').appendChild(dl);
}

async function loadHistory() {
  try { historyCache = (await DB.all()).sort((a, b) => b.startedAt - a.startedAt); }
  catch (e) { console.error(e); historyCache = []; }
  renderHistory();
}

function renderHistory() {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  historyCache.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const total = historyCache.length;
  const won = (counts['Converted'] || 0) + (counts['Demo Requested'] || 0);
  $('#stats').innerHTML = total ? `
    <div class="stat"><b>${total}</b> calls</div>
    <div class="stat"><b>${total ? Math.round(won / total * 100) : 0}%</b> converted or demo</div>
    ${STATUSES.filter(s => counts[s]).map(s => `<div class="stat"><span class="badge" data-s="${esc(s)}">${esc(s)}</span><b>${counts[s]}</b></div>`).join('')}
  ` : '';

  const filter = $('#statusFilter').value;
  const rows = historyCache.filter(r => !filter || r.status === filter);
  const el = $('#historyList');
  if (!rows.length) {
    el.innerHTML = `<p class="history-empty">${total ? 'No calls with this status.' : 'No calls yet. Your completed calls will appear here with recordings, summaries and transcripts.'}</p>`;
    return;
  }
  el.innerHTML = rows.map(r => `
    <button class="hcard" data-id="${esc(r.id)}">
      <div class="top"><span class="badge" data-s="${esc(r.status)}">${esc(r.status)}</span><span class="when">${esc(new Date(r.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</span></div>
      <div><b>${esc(r.customerName || 'Unknown customer')}</b> <span class="muted">· ${esc(r.productName)}</span></div>
      <div class="sum">${esc(r.summary)}</div>
      <div class="foot2"><span class="mono">${fmt(r.duration)}</span><span>${esc((LANGS[r.lang] || {}).label || r.lang)}</span><span>${r.recording ? '● Recording' : 'No recording'}</span><span>${r.transcript.length} msgs</span></div>
    </button>`).join('');
  el.querySelectorAll('.hcard').forEach(b => b.onclick = () => openDetail(b.dataset.id));
}

function openDetail(id) {
  const r = historyCache.find(x => x.id === id);
  if (!r) return;
  const body = $('#detailBody');
  body.innerHTML = `
    <h3>${esc(r.customerName || 'Unknown customer')} <span class="muted" style="font-weight:500;font-size:14px">· ${esc(r.productName)} · ${esc((LANGS[r.lang] || {}).label || r.lang)}</span></h3>
    <div class="detail-grid">
      <div class="result">${outcomeHtml(r, false)}</div>
      <div>
        <h4 class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 10px">Transcript</h4>
        <div class="transcript">${r.transcript.map(m => {
          const who = m.role === 'bot' ? 'Aria · AI agent' : (r.customerName || 'Customer');
          return `<div class="msg ${m.role}"><div class="meta"><span>${esc(who)}</span><span class="mono">${fmt(m.t)}</span></div><div class="bubble">${esc(m.text)}</div></div>`;
        }).join('') || '<p class="muted">Empty transcript</p>'}</div>
        <div style="margin-top:16px;display:flex;justify-content:flex-end"><button class="danger" id="delCall">Delete call</button></div>
      </div>
    </div>`;
  attachAudio(body.querySelector('.result'), r);
  $('#delCall').onclick = async () => {
    if (!confirm('Delete this call, its recording and transcript?')) return;
    await DB.del(r.id);
    const u = objectUrls.get(r.id); if (u) { URL.revokeObjectURL(u); objectUrls.delete(r.id); }
    closeDetail();
    loadHistory();
  };
  $('#detailModal').classList.remove('hidden');
}
function closeDetail() {
  const m = $('#detailModal');
  if (m.classList.contains('hidden')) return;
  m.querySelectorAll('audio').forEach(a => a.pause());
  m.classList.add('hidden');
}

/* ---------------- boot ---------------- */
initSetup();
loadConfig();
loadHistory();
window.addEventListener('resize', () => { if (!audio.analyser) drawMeterIdle(); });
})();
