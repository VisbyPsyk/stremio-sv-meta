import 'dotenv/config';
import { serveHTTP, addonBuilder } from 'stremio-addon-sdk';
import axios from 'axios';
import { parseSrt, stringifySrt } from 'srt-parser-2';

const PORT = process.env.PORT || 7000;
const DEEPL_KEY = process.env.DEEPL_API_KEY;
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL;
const OS_ADDON = 'https://opensubtitles.strem.io';
const SCS_ADDON = 'https://community-subtitles.strem.io';
const CACHE = new Map();

const manifest = {
  id: 'org.stremio.swedish.meta.koyeb',
  version: '1.0.0',
  name: '🇸🇪 Swedish Meta (SCS + OS + AI)',
  description: 'Native SV (SCS/OS) → Translate EN→SV (DeepL/MyMemory). Hash handled by upstreams.',
  logo: 'https://cdn.jsdelivr.net/gh/hakanburok/stremio-addons@main/logos/swedish-flag.png',
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  resources: ['subtitles'],
  behaviorHints: { configurable: false, adult: false, p2p: false }
};

const fetchAddonSubs = async (base, type, id, args) => {
  try {
    const url = `${base}/subtitles/${type}/${encodeURIComponent(id)}.json`;
    const { data } = await axios.get(url, { params: { videoHash: args.videoHash, videoSize: args.videoSize }, timeout: 8000 });
    return data.subtitles || [];
  } catch { return []; }
};

const findBest = (subs, lang) => 
  subs.filter(s => s.lang === lang || s.lang.startsWith(lang))
      .sort((a, b) => (a.hearingImpaired === b.hearingImpaired ? 0 : a.hearingImpaired ? 1 : -1))[0] || null;

const translateText = async (texts, targetLang = 'sv') => {
  if (DEEPL_KEY) {
    try {
      const params = new URLSearchParams();
      texts.forEach(t => params.append('text', t));
      params.append('target_lang', targetLang.toUpperCase());
      params.append('source_lang', 'EN');
      params.append('preserve_formatting', '1');
      const { data } = await axios.post('https://api-free.deepl.com/v2/translate', params, {
        headers: { Authorization: `DeepL-Auth-Key ${DEEPL_KEY}` }, timeout: 30000
      });
      return data.translations.map(t => t.text);
    } catch (e) { console.warn('DeepL failed, fallback MyMemory:', e.message); }
  }
  const results = [];
  for (const text of texts) {
    if (!text.trim()) { results.push(''); continue; }
    try {
      const p = new URLSearchParams({ q: text, langpair: `en|${targetLang}` });
      if (MYMEMORY_EMAIL) p.append('de', MYMEMORY_EMAIL);
      const { data } = await axios.get(`https://api.mymemory.translated.net/get?${p}`, { timeout: 15000 });
      results.push(data.responseData?.translatedText || text);
      await new Promise(r => setTimeout(r, 100));
    } catch { results.push(text); }
  }
  return results;
};

const translateSubtitle = async (engSub) => {
  const cacheKey = `${engSub.url}:sv`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);
  try {
    const { data: content } = await axios.get(engSub.url, { responseType: 'text', timeout: 15000 });
    const isVTT = engSub.url.endsWith('.vtt') || content.startsWith('WEBVTT');
    const parser = new parseSrt();
    const subs = parser.fromSrt(isVTT ? content.replace(/^WEBVTT\n\n/, '') : content);
    if (!subs.length) return null;
    const texts = subs.map(s => s.text.replace(/\n/g, ' ').trim());
    const validIdx = texts.map((t, i) => t ? i : -1).filter(i => i !== -1);
    const toTranslate = validIdx.map(i => texts[i]);
    const translated = await translateText(toTranslate);
    let tIdx = 0;
    const newSubs = subs.map((s, i) => validIdx.includes(i) ? { ...s, text: translated[tIdx++] } : s);
    const sweSrt = stringifySrt(newSubs);
    const dataUri = `data:application/x-subrip;base64,${Buffer.from(sweSrt).toString('base64')}`;
    CACHE.set(cacheKey, dataUri);
    return dataUri;
  } catch (e) { console.error('Translate error:', e.message); return null; }
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async (args) => {
  const imdbId = args.id.split(':')[0];
  console.log(`[Req] ${imdbId} | Hash: ${args.videoHash || 'none'}`);
  const [scsSubs, osSubs] = await Promise.all([
    fetchAddonSubs(SCS_ADDON, args.type, imdbId, args),
    fetchAddonSubs(OS_ADDON, args.type, imdbId, args)
  ]);
  const allSubs = [...scsSubs, ...osSubs];
  if (!allSubs.length) return { subtitles: [] };
  const nativeSv = findBest(allSubs, 'swe') || findBest(allSubs, 'sv');
  if (nativeSv) {
    console.log(`[OK] Native SV: ${nativeSv.filename}`);
    return { subtitles: [{ id: `native-sv-${imdbId}`, url: nativeSv.url, lang: 'Swedish', filename: nativeSv.filename, hearingImpaired: nativeSv.hearingImpaired }] };
  }
  const engSub = findBest(allSubs, 'eng') || findBest(allSubs, 'en');
  if (!engSub) return { subtitles: [] };
  console.log(`[AI] Translating: ${engSub.filename}`);
  const dataUri = await translateSubtitle(engSub);
  if (!dataUri) return { subtitles: [] };
  return { subtitles: [{ id: `ai-sv-${imdbId}-${Date.now()}`, url: dataUri, lang: 'Swedish (AI)', filename: `SV_AI_${engSub.filename}` }] });
});

const app = builder.getInterface();
app.get('/health', (_, res) => res.send('OK'));
serveHTTP(app, { port: PORT }).then(() => console.log(`🚀 Live on port ${PORT}`));
