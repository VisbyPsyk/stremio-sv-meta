import 'dotenv/config';
import pkg from 'stremio-addon-sdk';
const { serveHTTP, addonBuilder } = pkg;
import axios from 'axios';
import SrtParser from 'srt-parser-2';

// Global error handlers to capture unhandled rejections and exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('UnhandledPromiseRejection:', { reason, promise }, new Error().stack);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err && err.stack ? err.stack : err);
  process.exit(1);
});

const PORT = process.env.PORT || 7000;
const DEEPL_KEY = process.env.DEEPL_API_KEY;
const AZURE_KEY = process.env.AZURE_TRANSLATOR_KEY;
const AZURE_REGION = process.env.AZURE_TRANSLATOR_REGION;
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL;
const OS_ADDON = 'https://opensubtitles.strem.io';
const SCS_ADDON = 'https://community-subtitles.strem.io';
const SCS_ALT = process.env.SCS_ALT || null; // optional alternative SCS host
const CACHE = new Map();

const manifest = {
  id: 'org.stremio.swedish.meta.koyeb',
  version: '1.0.0',
  name: '🇸🇪 Swedish Meta (SCS + OS + AI)',
  description: 'Native SV (SCS/OS) → Translate EN→SV (DeepL/Azure/MyMemory). Hash handled by upstreams.',
  logo: 'https://cdn.jsdelivr.net/gh/hakanburok/stremio-addons@main/logos/swedish-flag.png',
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  resources: ['subtitles'],
  behaviorHints: { configurable: false, adult: false, p2p: false }
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const fetchWithRetries = async (url, opts = {}, attempts = 3) => {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      console.debug(`fetchWithRetries attempt ${i} -> ${url}`);
      const response = await axios.get(url, { ...opts });
      return response.data;
    } catch (err) {
      lastErr = err;
      const code = err && err.code;
      const status = err && err.response && err.response.status;
      console.warn(`fetchWithRetries error attempt ${i} for ${url}:`, code || status || err.message);
      // quick backoff
      await sleep(200 * i);
      // continue to retry
    }
  }
  // all attempts failed
  throw lastErr;
};

const fetchAddonSubs = async (base, type, id, args) => {
  const url = `${base}/subtitles/${type}/${encodeURIComponent(id)}.json`;
  try {
    const data = await fetchWithRetries(url, { params: { videoHash: args.videoHash, videoSize: args.videoSize }, timeout: 8000 }, 3);
    return data.subtitles || [];
  } catch (err) {
    // Detailed logging for DNS and network failures
    const code = err && err.code;
    const status = err && err.response && err.response.status;
    console.warn(`fetchAddonSubs failed for ${base} (${url}) — code:${code || 'N/A'} status:${status || 'N/A'} message:${err && err.message}`);
    // If this was the primary SCS and there's an alt configured, try the alt once
    if (base === SCS_ADDON && SCS_ALT) {
      const altUrl = `${SCS_ALT}/subtitles/${type}/${encodeURIComponent(id)}.json`;
      try {
        console.warn(`Attempting fallback SCS host: ${SCS_ALT}`);
        const data = await fetchWithRetries(altUrl, { params: { videoHash: args.videoHash, videoSize: args.videoSize }, timeout: 8000 }, 2);
        return data.subtitles || [];
      } catch (altErr) {
        console.warn(`Fallback SCS host failed: ${SCS_ALT} — ${altErr && altErr.message}`);
      }
    }
    return [];
  }
};

const findBest = (subs, lang) =>
  subs.filter(s => s.lang === lang || s.lang.startsWith(lang))
    .sort((a, b) => (a.hearingImpaired === b.hearingImpaired ? 0 : a.hearingImpaired ? 1 : -1))[0] || null;

const translateText = async (texts, targetLang = 'sv') => {
  // Prefer DeepL if key is provided
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
    } catch (e) {
      console.warn('DeepL failed, fallback to Azure/MyMemory:', e && e.message);
    }
  }

  // Next prefer Azure Translator if key provided
  if (AZURE_KEY) {
    try {
      const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(targetLang)}`;
      const body = texts.map(t => ({ Text: t }));
      const headers = { 'Ocp-Apim-Subscription-Key': AZURE_KEY, 'Content-Type': 'application/json' };
      if (AZURE_REGION) headers['Ocp-Apim-Subscription-Region'] = AZURE_REGION;
      const { data } = await axios.post(url, body, { headers, timeout: 30000 });
      return data.map(item => (item.translations && item.translations[0] && item.translations[0].text) || '');
    } catch (e) {
      console.warn('Azure Translator failed, fallback MyMemory:', e && e.message);
    }
  }

  // Fallback: MyMemory (public/free)
  const results = [];
  for (const text of texts) {
    if (!text.trim()) { results.push(''); continue; }
    try {
      const p = new URLSearchParams({ q: text, langpair: `en|${targetLang}` });
      if (MYMEMORY_EMAIL) p.append('de', MYMEMORY_EMAIL);
      const { data } = await axios.get(`https://api.mymemory.translated.net/get?${p}`, { timeout: 15000 });
      results.push(data.responseData?.translatedText || text);
      await sleep(100);
    } catch (e) { console.warn('MyMemory fetch failed', e && e.message); results.push(text); }
  }
  return results;
};

const translateSubtitle = async (engSub) => {
  const cacheKey = `${engSub.url}:sv`;
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);
  try {
    const { data: content } = await axios.get(engSub.url, { responseType: 'text', timeout: 15000 });
    const isVTT = engSub.url.endsWith('.vtt') || content.startsWith('WEBVTT');
    const parser = new SrtParser();
    const subs = parser.fromSrt(isVTT ? content.replace(/^WEBVTT\n\n/, '') : content);
    if (!subs.length) return null;
    const texts = subs.map(s => s.text.replace(/\n/g, ' ').trim());
    const validIdx = texts.map((t, i) => t ? i : -1).filter(i => i !== -1);
    const toTranslate = validIdx.map(i => texts[i]);
    const translated = await translateText(toTranslate);
    let tIdx = 0;
    const newSubs = subs.map((s, i) => validIdx.includes(i) ? { ...s, text: translated[tIdx++] } : s);
    const sweSrt = parser.toSrt(newSubs);
    const dataUri = `data:application/x-subrip;base64,${Buffer.from(sweSrt).toString('base64')}`;
    CACHE.set(cacheKey, dataUri);
    return dataUri;
  } catch (e) { console.error('Translate error:', e && e.message); return null; }
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async (args) => {
  try {
    const imdbId = args.id.split(':')[0];
    console.log(`[Req] ${imdbId} | Hash: ${args.videoHash || 'none'}`);

    // Fetch from both upstreams concurrently but with robust retries and fallbacks
    const [scsSubs, osSubs] = await Promise.all([
      fetchAddonSubs(SCS_ADDON, args.type, imdbId, args).catch(err => { console.warn('SCS subs fetch final failure', err && err.message); return []; }),
      fetchAddonSubs(OS_ADDON, args.type, imdbId, args).catch(err => { console.warn('OS subs fetch final failure', err && err.message); return []; })
    ]);

    console.log(`[Info] upstream results: scs=${scsSubs.length} os=${osSubs.length}`);

    const allSubs = [...scsSubs, ...osSubs];
    if (!allSubs.length) return { subtitles: [] };

    const nativeSv = findBest(allSubs, 'swe') || findBest(allSubs, 'sv');
    if (nativeSv) {
      console.log(`[OK] Native SV: ${nativeSv.filename}`);
      return { subtitles: [{ id: `native-sv-${imdbId}`, url: nativeSv.url, lang: 'sv', filename: nativeSv.filename, hearingImpaired: nativeSv.hearingImpaired }] };
    }

    const engSub = findBest(allSubs, 'eng') || findBest(allSubs, 'en');
    if (!engSub) return { subtitles: [] };

    console.log(`[AI] Translating: ${engSub.filename}`);
    const dataUri = await translateSubtitle(engSub);
    if (!dataUri) return { subtitles: [] };
    return { subtitles: [{ id: `ai-sv-${imdbId}-${Date.now()}`, url: dataUri, lang: 'sv', filename: `SV_AI_${engSub.filename}`, hearingImpaired: engSub.hearingImpaired }] };
  } catch (err) {
    console.error('Subtitles handler error:', err && err.stack ? err.stack : err);
    return { subtitles: [] };
  }
});

const app = builder.getInterface();
app.get('/health', (_, res) => res.send('OK'));
serveHTTP(app, { port: PORT }).then(() => console.log(`🚀 Live on port ${PORT}`));
