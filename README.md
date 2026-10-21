# VoiceCloser — AI Voice Sales Agent

A working AI voice bot that sells any SaaS product over a live voice conversation. It speaks, listens, handles questions and objections, and tries to close (free trial or demo). It shows a live transcript, records the call with consent, writes an AI summary, assigns a sales status, and keeps a call history.

## Features (mapped to the brief)

| Requirement | How it's done |
|---|---|
| Voice conversation | Browser speech recognition (Web Speech API) → LLM sales agent "Aria" → spoken reply (neural TTS or browser voice). Turn-taking is automatic: a short pause ends your turn. The agent ends the call itself once next steps are agreed or the customer declines. |
| Language | English (India/US), Hindi, Telugu, selectable before the call. The agent replies in that language. |
| Live chat screen | Agent and customer messages appear in real time, including live partial captions while you speak. A typing box is available as a fallback. |
| Call controls | Start Call / End Call, live timer, status (Connecting, Agent speaking, Listening, Agent thinking, Analyzing, Call ended), mic level meter, REC indicator. |
| Call recording + consent | A consent dialog appears before each call, and the agent announces the recording in its first line. Mic and agent voice are mixed into one recording (WebM), which can be played back and downloaded. No consent means no recording. |
| AI summary | Summary, customer requirements, objections, next steps, sentiment and interest score, generated automatically when the call ends. |
| Sales status | Auto-assigned: Converted, Interested, Follow-up Required, Not Interested, Demo Requested, No Response. No Response is set automatically when the customer never replies. |
| Call history | Every call is saved with its recording, summary, transcript and status. Includes a status filter and conversion stats. Stored in the browser (IndexedDB) and kept across reloads. |
| Any SaaS product | Product name and details (features, pricing, goal) are editable in the UI. A sample product (FlowDesk) is preloaded. |

## Architecture

```
Browser (index.html, app.js)
 ├─ SpeechRecognition  → customer speech to text (en-IN / hi-IN / te-IN)
 ├─ /api/chat          → LLM sales agent reply (short, spoken-style, [END_CALL] token to hang up)
 ├─ /api/tts (opt.)    → OpenAI neural voice, played via Web Audio and mixed into the recording
 │   └─ fallback: speechSynthesis (browser voice)
 ├─ MediaRecorder      → call recording (mic + agent voice)
 ├─ /api/summary       → JSON: summary, requirements, objections, next steps, status
 └─ IndexedDB          → call history (recordings as blobs)
Serverless API (api/*.js, Node 18+, zero dependencies)
 └─ lib/llm.js picks provider: Anthropic, Groq, Gemini, OpenAI, or any OpenAI-compatible URL
```

## Deploy to Vercel (about 5 minutes)

1. Get a free LLM key. **Groq** (console.groq.com) or **Gemini** (aistudio.google.com) both have free tiers and are fast.
2. Push this folder to a GitHub repo.
3. On vercel.com: **Add New → Project → import the repo**. No build settings are needed (Framework: Other).
4. Under **Settings → Environment Variables**, add one of these:
   - `GROQ_API_KEY` = your key, or
   - `GEMINI_API_KEY` = your key, or
   - `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
5. Optional: add `OPENAI_API_KEY` for a natural neural voice, and recordings that capture the agent's voice digitally.
6. Deploy, then open the `https://…vercel.app` link **in Chrome or Edge on desktop**. HTTPS is required for the microphone, and Vercel provides it.

Optional variables: `LLM_PROVIDER` (force one), `LLM_MODEL` (override the model), `TTS_VOICE` (default `nova`), `TTS_MODEL` (default `tts-1`), `TTS_MODE=browser` (disable server TTS).

## Run locally

```bash
cp .env.example .env     # add a key
node server.js           # http://localhost:3000  (Node 18+, no npm install needed)
```

## Tips for a smooth demo

- Use **Chrome** with **headphones**. Without headphones in browser-voice mode, the agent's voice is captured through your mic for the recording, which works but sounds rougher.
- Wait for the status to show **Listening…** before speaking. A pause of about 1 second sends your reply.
- Telugu and Hindi recognition work in Chrome. Browser voices for Telugu depend on your OS; the OpenAI TTS option sounds much better.
- To test different statuses: agree to a trial (Converted), book a time (Demo Requested), say "call me next week" (Follow-up Required), say no (Not Interested), or stay silent (No Response).

## Suggested 2–3 minute explanation video

1. **(0:00)** Show the dashboard: product config, language, call controls, history.
2. **(0:20)** Start Call, accept consent, have a real conversation: ask the price, raise an objection ("too expensive", "we already use Freshdesk"), then book a demo. Point out the live transcript and statuses.
3. **(1:30)** The agent closes and hangs up. Show the AI summary, requirements, objections, next steps, status, and play back the recording.
4. **(2:00)** Open Call history: filter by status, open a past call (transcript and recording). Do a quick second call in Hindi or Telugu, or stay silent to show **No Response**.
5. **(2:30)** Briefly explain the architecture diagram above.

## Limitations

- History lives in the browser that made the calls, so it is per device. Swap IndexedDB for a database (Supabase or Firebase) if it needs to be shared.
- Speech recognition relies on Chrome or Edge (Web Speech API). Safari support is partial and Firefox has none.
- This is a browser "call", not a phone-network call. For real phone numbers, the same agent logic could sit behind Twilio or Exotel.
