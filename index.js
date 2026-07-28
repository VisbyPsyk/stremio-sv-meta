import 'dotenv/config';
import express from 'express';
import pkg from 'stremio-addon-sdk';
const { addonBuilder, getRouter } = pkg;
import axios from 'axios';
import srtParser2 from 'srt-parser-2';

const Parser = srtParser2.default || srtParser2;

const PORT = process.env.PORT || 7000;
const HOST_URL = process.env.HOST_URL || `http://localhost:${PORT}`;
const DEEPL_KEY = process.env.DEEPL_API_KEY;
const AZURE_KEY = process.env.AZURE_TRANSLATOR_KEY;
const AZURE_REGION = process.env.AZURE_TRANSLATOR_REGION;

const OS_ADDON = 'https://opensubtitles.strem.io';
const SCS_ADDON = 'https://community-subtitles.strem.io';

const TRANSLATED_CACHE = new Map();

const manifest = {
  id: 'org.stremio.swedish.meta.koyeb',
  version: '1.0.1',
  name: '🇸🇪 Swedish Meta (SCS + OS + AI)',
  description: 'Native SV (SCS/OS) → Translate EN→SV (DeepL/Azure). Compatible with AIOStreams.',
  logo: 'https://cdn.jsdelivr.net/gh/hakanburok/stremio-addons@main/logos/swedish-flag.png',
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  resources: ['subtitles'],
  behaviorHints: { configurable: false, adult: false, p2p: false }
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const buildStremioSubUrl = (base, type, id, extra = {}) => {
  const extraSegments = [];
  if (extra.videoHash) extraSegments.push(`videoHash=${extra.videoHash}`);
  if (extra.videoSize) extraSegments.push(`videoSize=${extra.videoSize}`);
  
  const extraPath = extraSegments.length > 0 ? `/${extraSegments.join('&')}` : '';
  return `${base}/subtitles/${type}/${encodeURIComponent(id)}${extraPath}.json`;
};

const fetchAddonSubs = async (base, type, id, extra = {}) => {
  const url = buildStremioSubUrl(base, type, id, extra);
  try {
    const { data } = await axios.get(url, { timeout: 6000 });
    return data.subtitles || [];
  } catch (err) {
    return [];
  }
};

const fetchWithHashFallback = async (base, type, fullId, args) => {
  if (args.videoHash) {
    const hashedSubs = await fetchAddonSubs(base, type, fullId, {
      videoHash: args.videoHash,
      videoSize: args.videoSize
    });
    if (hashedSubs.length > 0) return hashedSubs;
  }
  return await fetchAddonSubs(base, type, fullId);
};

const findBest = (subs, lang) =>
  subs.filter(s => s.lang === lang || s.lang.startsWith(lang))
    .sort((a, b) => (a.hearingImpaired === b.hearingImpaired ? 0 : a.hearingImpaired ? 1 : -1))[0] || null;

const translateBatchDeepL = async (texts) => {
  const CHUNK_SIZE = 50;
  const results = [];
  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE);
    const params = new URLSearchParams();
    chunk.forEach(t => params.append('text', t));
    params.append('target_lang', 'SV');
    params.append('source_lang', 'EN');
    
    const { data } = await axios.post('https://api-free.deepl.com/v2/translate', params, {
      headers: { Authorization: `DeepL-Auth-Key ${DEEPL_KEY}` },
      timeout: 15000
    });
    results.push(...data.translations.map(t => t.text));
  }
  return results;
};

const translateText = async (texts) => {
  if (DEEPL_KEY) {
    try {
      return await translateBatchDeepL(texts);
    } catch (e) {
      console.warn('DeepL failed:', e.message);
    }
  }

  if (AZURE_KEY) {
    try {
      const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=sv`;
      const body = texts.map(t => ({ Text: t }));
      const headers = { 'Ocp-Apim-Subscription-Key': AZURE_KEY, 'Content-Type': 'application/json' };
      if (AZURE_REGION) headers['Ocp-Apim-Subscription-Region'] = AZURE_REGION;
      
      const { data } = await axios.post(url, body, { headers, timeout: 20000 });
      return data.map(item => item.translations?.[0]?.text || '');
    } catch (e) {
      console.warn('Azure Translator failed:', e.message);
    }
  }

  return texts;
};

const translateSubtitle = async (engSub, fileId) => {
  if (TRANSLATED_CACHE.has(fileId)) {
    return `${HOST_URL}/subtitles/translated/${fileId}.srt`;
  }

  try {
    const { data: content } = await axios.get(engSub.url, { responseType: 'text', timeout: 10000 });
    const parser = new Parser();
    const subs = parser.fromSrt(content);
    if (!subs.length) return null;

    const texts = subs.map(s => s.text.replace(/\n/g, ' ').trim());
    const validIdx = texts.map((t, i) => (t ? i : -1)).filter(i => i !== -1);
    const toTranslate = validIdx.map(i => texts[i]);

    const translated = await translateText(toTranslate);

    let tIdx = 0;
    const newSubs = subs.map((s, i) => 
      validIdx.includes(i) ? { ...s, text: translated[tIdx++] } : s
    );

    const sweSrt = parser.toSrt(newSubs);
    TRANSLATED_CACHE.set(fileId, sweSrt);

    return `${HOST_URL}/subtitles/translated/${fileId}.srt`;
  } catch (e) {
    console.error('Translation error:', e.message);
    return null;
  }
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async (args) => {
  try {
    const fullId = args.id;

    const [scsSubs, osSubs] = await Promise.all([
      fetchWithHashFallback(SCS_ADDON, args.type, fullId, args),
      fetchWithHashFallback(OS_ADDON, args.type, fullId, args)
    ]);

    const allSubs = [...scsSubs, ...osSubs];
    if (!allSubs.length) return { subtitles: [] };

    const nativeSv = findBest(allSubs, 'swe') || findBest(allSubs, 'sv');
    if (nativeSv) {
      return { 
        subtitles: [{ 
          id: `native-sv-${fullId}`, 
          url: nativeSv.url, 
          lang: 'sv', 
          filename: nativeSv.filename, 
          hearingImpaired: nativeSv.hearingImpaired 
        }] 
      };
    }

    const engSub = findBest(allSubs, 'eng') || findBest(allSubs, 'en');
    if (!engSub) return { subtitles: [] };

    const fileId = Buffer.from(`${engSub.url}`).toString('hex').slice(0, 32);
    const httpSubUrl = await translateSubtitle(engSub, fileId);

    if (!httpSubUrl) return { subtitles: [] };

    return { 
      subtitles: [{ 
        id: `ai-sv-${fullId}`, 
        url: httpSubUrl, 
        lang: 'sv', 
        filename: `SV_AI_${engSub.filename || 'sub.srt'}`, 
        hearingImpaired: engSub.hearingImpaired 
      }] 
    };
  } catch (err) {
    console.error('Subtitles handler error:', err);
    return { subtitles: [] };
  }
});

const app = express();

app.get('/health', (_, res) => res.send('OK'));

app.get(
