// Google AI Studio (Gemini) client: called directly from the browser with the
// user's own API key. The key is read from localStorage and sent only to
// generativelanguage.googleapis.com in the x-goog-api-key header.
import { state, getApiKey, saveSettings, DEFAULT_MODEL } from './store.js';
import { blobToBase64, isoDate, isValidISO, toInt, toNum } from './utils.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Tried in order when the chosen model is unavailable for the key.
const FALLBACK_MODELS = [DEFAULT_MODEL, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];

export class AIError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export const hasApiKey = () => !!getApiKey();

/* ---------- Transport ----------------------------------------------------- */
async function request(path, { key, body, method = 'POST', signal, timeout = 90000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  let res;
  try {
    res = await fetch(`${BASE}/${path}`, {
      method,
      signal: ctrl.signal,
      headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (signal?.aborted) throw new AIError('aborted', 'Cancelled.');
    if (ctrl.signal.aborted) throw new AIError('timeout', 'Gemini took too long to respond. Check your connection and try again.');
    throw new AIError('network', navigator.onLine
      ? 'Couldn’t reach Google AI. Check your connection and try again.'
      : 'You’re offline. AI features need an internet connection.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw toAIError(res.status, data);
  return data;
}

function toAIError(status, data) {
  const msg = data?.error?.message || '';
  const reasons = JSON.stringify(data?.error?.details || '') + (data?.error?.status || '');
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(msg + reasons)) {
    return new AIError('invalid_key', 'That API key isn’t valid. Check it in Settings.', msg);
  }
  if (status === 403) {
    if (/referer|referrer/i.test(msg + reasons)) {
      return new AIError('forbidden', 'This key is restricted to other websites. Add this site to the key’s allowed referrers in Google Cloud Console.', msg);
    }
    return new AIError('forbidden', 'This API key can’t use the Gemini API. Create a key in Google AI Studio.', msg);
  }
  if (status === 404 || /not found for API version|is not supported for generateContent|no longer available|not available to new users/i.test(msg)) {
    return new AIError('model', 'The selected Gemini model isn’t available for this key.', msg);
  }
  if (status === 429) return new AIError('quota', 'Your Gemini key hit its rate limit or quota. Wait a minute and try again.', msg);
  if (status >= 500) return new AIError('server', 'Google AI is temporarily unavailable. Please try again.', msg);
  return new AIError('bad_request', msg || `Request failed (${status}).`, msg);
}

function parseLooseJSON(text) {
  try { return JSON.parse(text); } catch { /* try harder */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* continue */ } }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* continue */ } }
  throw new AIError('parse', 'Gemini’s reply couldn’t be read. Please try again.');
}

function readResponse(data) {
  const cand = data?.candidates?.[0];
  if (!cand) {
    const block = data?.promptFeedback?.blockReason;
    throw new AIError('blocked', block ? `Gemini blocked this request (${block.toLowerCase()}).` : 'Gemini returned no result. Try again.');
  }
  const text = (cand.content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (!text.trim()) {
    const why = cand.finishReason;
    throw new AIError('empty', why === 'SAFETY' ? 'Gemini declined to process this content.'
      : why === 'MAX_TOKENS' ? 'Gemini’s answer was cut off. Try again.'
        : 'Gemini returned an empty answer. Try again.');
  }
  return parseLooseJSON(text);
}

async function callModel(model, { key, system, parts, schema, temperature, signal }) {
  const base = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, responseMimeType: 'application/json' },
  };
  if (system) base.systemInstruction = { parts: [{ text: system }] };
  const path = `models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
  if (schema) {
    try {
      const body = { ...base, generationConfig: { ...base.generationConfig, responseJsonSchema: schema } };
      return readResponse(await request(path, { key, body, signal }));
    } catch (e) {
      // Some API surfaces reject JSON-Schema output config; the prompts also
      // describe the expected JSON, so plain JSON mode is a safe fallback.
      if (!(e.code === 'bad_request' && /schema|Unknown name|Invalid JSON payload|response_json/i.test(e.detail || e.message))) throw e;
    }
  }
  return readResponse(await request(path, { key, body: base, signal }));
}

async function generateJSON({ system, parts, schema, temperature = 0.2, signal }) {
  const key = getApiKey();
  if (!key) throw new AIError('no_key', 'Add your Google AI Studio API key in Settings to use AI features.');
  const preferred = state.settings.model || DEFAULT_MODEL;
  const models = [preferred, ...FALLBACK_MODELS.filter((m) => m !== preferred)];
  let lastErr = null;
  for (const model of models) {
    try {
      const out = await callModel(model, { key, system, parts, schema, temperature, signal });
      if (model !== preferred) saveSettings({ model }, { silent: true });
      return { data: out, model };
    } catch (e) {
      lastErr = e;
      if (e.code !== 'model') throw e;
    }
  }
  throw lastErr;
}

/* ---------- Key check & model list ---------------------------------------- */
const EXCLUDE = /(embedding|tts|image|live|audio|transcribe|robotics|computer-use|aqa|omni|translate|deep-research|antigravity|lyria|veo|imagen|learnlm|gemma)/i;
export async function listModels(key = getApiKey()) {
  if (!key) throw new AIError('no_key', 'Enter an API key first.');
  const all = [];
  let token = '';
  for (let page = 0; page < 5; page++) {
    const data = await request(`models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { key, method: 'GET', timeout: 20000 });
    all.push(...(data.models || []));
    if (!data.nextPageToken) break;
    token = data.nextPageToken;
  }
  const rank = (id) => (/latest/.test(id) ? 1000 : 0) + (parseFloat((id.match(/(\d+(\.\d+)?)/) || [0, 0])[1]) * 10) + (/flash(?!-lite)/.test(id) ? 3 : /pro/.test(id) ? 2 : 1) - (/preview|exp/.test(id) ? 0.5 : 0);
  return all
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name) && !EXCLUDE.test(m.name))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .sort((a, b) => rank(b.id) - rank(a.id));
}

/* ---------- Scorecard vision ------------------------------------------------ */
const n = (type, extra = {}) => ({ type: [type, 'null'], ...extra });

const SCORECARD_SCHEMA = {
  type: 'object',
  properties: {
    isScorecard: { type: 'boolean', description: 'True if the image shows a golf scorecard containing written scores.' },
    courseName: n('string', { description: 'Golf course or club name as printed on the card.' }),
    courseCity: n('string'),
    courseRegion: n('string', { description: 'State, province or county.' }),
    courseCountry: n('string'),
    date: n('string', { description: 'Date played as YYYY-MM-DD, only if written on the card.' }),
    holesPlayed: n('integer', { description: '9 or 18.' }),
    coursePar: n('integer', { description: 'Total par for the holes played.' }),
    tees: n('string', { description: 'Tee set played (e.g. Blue, White), if identifiable.' }),
    courseRating: n('number'),
    slopeRating: n('integer'),
    players: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          holeScores: { type: 'array', items: n('integer'), description: 'Strokes for each hole in order; null for blank or illegible holes.' },
          front9: n('integer', { description: 'OUT total.' }),
          back9: n('integer', { description: 'IN total.' }),
          total: n('integer', { description: 'Overall gross total.' }),
          totalWrittenOnCard: { type: 'boolean' },
        },
        required: ['name', 'holeScores', 'front9', 'back9', 'total', 'totalWrittenOnCard'],
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: n('string', { description: 'Anything the user should double-check.' }),
  },
  required: ['isScorecard', 'courseName', 'courseCity', 'courseRegion', 'courseCountry', 'date', 'holesPlayed', 'coursePar', 'tees', 'courseRating', 'slopeRating', 'players', 'confidence', 'notes'],
};

const SCORECARD_SYSTEM = `You read golf scorecards (printed cards with handwritten or printed scores) and return JSON.
Rules:
- Player rows contain a name/initials and stroke counts per hole. Ignore rows for Par, Handicap / Stroke Index, yardages, and match-play marks (+, -, dots, circles).
- Read each hole's strokes in order (hole 1 onward). Use null for blank or illegible holes. Never guess a digit you cannot see.
- OUT is the front-nine total, IN the back-nine total, TOT/TOTAL the overall gross score. Report totals exactly as written and set totalWrittenOnCard=true; if no total is written, compute it from OUT+IN or the hole scores and set totalWrittenOnCard=false.
- Ignore HCP / NET columns; the total must be the gross score.
- holesPlayed is 9 when only nine holes have scores, otherwise 18.
- coursePar is the sum of the par row for the holes played (18 holes is usually 68-73, 9 holes 34-37).
- Course rating and slope are often printed beside the tee names, e.g. "71.8/131". Report them for the tees played if identifiable, otherwise null.
- Use the course name printed on the card (logo or header). Include city/region only if printed or unmistakable.
- Dates: output YYYY-MM-DD. If the year is missing, use the most recent such date that is not after today.
- Never invent players, scores or course details; use null and explain in notes.
- confidence: "high" when everything is clearly legible, "medium" if a few digits were ambiguous, "low" if the card was hard to read.
- If the image is not a golf scorecard, set isScorecard=false and return an empty players array.`;

export async function scanScorecard(blobs, { signal, playerName = '' } = {}) {
  const today = isoDate();
  const parts = [{
    text: `Today is ${today}.${playerName ? ` The app's user usually writes their name as "${playerName}" (it may be abbreviated or initials).` : ''} Read this scorecard${blobs.length > 1 ? ` (${blobs.length} photos of the same card)` : ''} and return the JSON.`,
  }];
  for (const b of blobs) parts.push({ inlineData: { mimeType: b.type || 'image/jpeg', data: await blobToBase64(b) } });
  const { data, model } = await generateJSON({ system: SCORECARD_SYSTEM, parts, schema: SCORECARD_SCHEMA, temperature: 0.1, signal });
  return { ...normalizeScan(data, today), model };
}

function normalizeScan(raw, today) {
  const players = (Array.isArray(raw?.players) ? raw.players : []).map((p) => {
    const holes = Array.isArray(p.holeScores) ? p.holeScores.map((h) => toInt(h, 1, 20)) : [];
    const filled = holes.filter((h) => h != null);
    const holeSum = filled.length ? filled.reduce((a, b) => a + b, 0) : null;
    const front9 = toInt(p.front9, 9, 150);
    const back9 = toInt(p.back9, 9, 150);
    const fb = front9 != null && back9 != null ? front9 + back9 : null;
    let total = toInt(p.total, 18, 300);
    if (total == null) total = fb ?? (filled.length >= 9 ? holeSum : null);
    const warnings = [];
    const complete = filled.length === holes.length && (holes.length === 9 || holes.length === 18);
    if (total != null && complete && holeSum !== total) warnings.push(`The hole scores add up to ${holeSum}, but the total reads ${total}.`);
    if (total != null && fb != null && fb !== total) warnings.push(`OUT ${front9} + IN ${back9} = ${fb}, but the total reads ${total}.`);
    const missing = holes.length - filled.length;
    if (holes.length && missing > 0) warnings.push(`${missing} hole score${missing > 1 ? 's were' : ' was'} unreadable.`);
    if (!p.totalWrittenOnCard && total != null) warnings.push('No total was written, so it was added up from the card.');
    return { name: String(p.name || '').trim() || 'Player', total, front9, back9, holesRead: filled.length, holeSum, warnings };
  }).filter((p) => p.total != null);

  let holes = toInt(raw?.holesPlayed, 1, 36);
  if (holes != null) holes = holes <= 12 ? 9 : 18;
  if (holes == null) holes = players.length && Math.max(...players.map((p) => p.holesRead)) <= 9 && players[0].holesRead > 0 ? 9 : 18;
  let date = isValidISO(raw?.date) ? raw.date : null;
  if (date && date > today) date = null;
  const conf = ['high', 'medium', 'low'].includes(raw?.confidence) ? raw.confidence : 'medium';
  return {
    isScorecard: raw?.isScorecard !== false && players.length > 0,
    course: {
      name: (raw?.courseName || '').trim() || null,
      city: raw?.courseCity || '',
      region: raw?.courseRegion || '',
      country: raw?.courseCountry || '',
    },
    date,
    holes,
    par: toInt(raw?.coursePar, holes === 9 ? 24 : 50, holes === 9 ? 45 : 90),
    tees: raw?.tees || null,
    rating: toNum(raw?.courseRating, 20, 90),
    slope: toInt(raw?.slopeRating, 55, 155),
    players,
    confidence: conf,
    notes: raw?.notes || '',
  };
}

/* ---------- Bulk history import (text or screenshots) --------------------- */
const HISTORY_SCHEMA = {
  type: 'object',
  properties: {
    rounds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: n('string', { description: 'YYYY-MM-DD' }),
          courseName: n('string'),
          city: n('string'),
          region: n('string'),
          score: { type: 'integer', description: 'Gross total strokes.' },
          holes: n('integer', { description: '9 or 18' }),
          par: n('integer'),
          tees: n('string'),
          rating: n('number'),
          slope: n('integer'),
        },
        required: ['date', 'courseName', 'city', 'region', 'score', 'holes', 'par', 'tees', 'rating', 'slope'],
      },
    },
    notes: n('string'),
  },
  required: ['rounds', 'notes'],
};

export async function parseHistory({ text = '', images = [] }, { signal } = {}) {
  const today = isoDate();
  const system = `You convert golf score histories (pasted text, spreadsheets, or screenshots from apps like GHIN or 18Birdies) into JSON rounds.
Rules: one entry per round played; score is the gross total (ignore net scores, differentials and handicap indexes unless nothing else exists); dates as YYYY-MM-DD (today is ${today}; for dates without a year use the most recent past date); holes 9 or 18 (infer 9 when the score is clearly a nine-hole total or labelled 9); use null for anything not shown. Never invent rounds.`;
  const parts = [{ text: `Extract every round from the following${images.length ? ' screenshot(s)' : ''}${text ? ' text' : ''}.${text ? `\n\n---\n${text.slice(0, 60000)}\n---` : ''}` }];
  for (const b of images) parts.push({ inlineData: { mimeType: b.type || 'image/jpeg', data: await blobToBase64(b) } });
  const { data } = await generateJSON({ system, parts, schema: HISTORY_SCHEMA, temperature: 0.1, signal });
  return (Array.isArray(data?.rounds) ? data.rounds : []).map((r) => {
    const holes = toInt(r.holes, 1, 36) != null && toInt(r.holes) <= 12 ? 9 : 18;
    return {
      date: isValidISO(r.date) && r.date <= today ? r.date : null,
      courseName: (r.courseName || '').trim(),
      city: r.city || '',
      region: r.region || '',
      score: toInt(r.score, 18, 300),
      holes,
      par: toInt(r.par, holes === 9 ? 24 : 50, holes === 9 ? 45 : 90),
      tees: r.tees || null,
      rating: toNum(r.rating, 20, 90),
      slope: toInt(r.slope, 55, 155),
    };
  });
}

/* ---------- Performance insights ----------------------------------------- */
const INSIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One upbeat, specific sentence (max 90 characters).' },
    summary: { type: 'string', description: '2-3 sentences on overall form and direction.' },
    trend: { type: 'string', enum: ['improving', 'steady', 'declining', 'insufficient_data'] },
    insights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          kind: { type: 'string', enum: ['strength', 'opportunity', 'trend', 'course', 'consistency'] },
        },
        required: ['title', 'detail', 'kind'],
      },
    },
    goals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, target: { type: 'string' }, why: { type: 'string' } },
        required: ['title', 'target', 'why'],
      },
    },
    nextRoundTip: { type: 'string' },
  },
  required: ['headline', 'summary', 'trend', 'insights', 'goals', 'nextRoundTip'],
};

export async function generateInsights(payload, { signal } = {}) {
  const system = `You are a candid, encouraging golf performance analyst for an amateur golfer.
You only have overall round totals: no hole-by-hole, putting, driving or shot data, so never claim knowledge of those.
Ground every statement in the numbers provided and cite concrete figures (averages, dates, course names).
Give 3-5 insights and 2-3 measurable goals. Keep each insight to 1-2 short sentences. Plain language, no jargon, no emojis.`;
  const parts = [{ text: `My golf data (JSON):\n${JSON.stringify(payload)}` }];
  const { data, model } = await generateJSON({ system, parts, schema: INSIGHTS_SCHEMA, temperature: 0.5, signal });
  const kinds = ['strength', 'opportunity', 'trend', 'course', 'consistency'];
  return {
    headline: String(data?.headline || '').slice(0, 160),
    summary: String(data?.summary || ''),
    trend: data?.trend || 'steady',
    insights: (data?.insights || []).slice(0, 6).map((i) => ({ title: String(i.title || ''), detail: String(i.detail || ''), kind: kinds.includes(i.kind) ? i.kind : 'trend' })),
    goals: (data?.goals || []).slice(0, 4).map((g) => ({ title: String(g.title || ''), target: String(g.target || ''), why: String(g.why || '') })),
    nextRoundTip: String(data?.nextRoundTip || ''),
    model,
    generatedAt: new Date().toISOString(),
  };
}
