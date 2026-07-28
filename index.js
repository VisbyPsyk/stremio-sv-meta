import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pkg from 'stremio-addon-sdk';
const { addonBuilder, getRouter } = pkg;
import axios from 'axios';
import srtParser2 from 'srt-parser-2';

const Parser = srtParser2.default || srtParser2;

const PORT = process.env.PORT || 7000;
const HOST_URL = (process.env.HOST_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DEEPL_KEY = process.env.DEEPL_API_KEY;
const AZURE_KEY = process.env.AZURE_TRANSLATOR_KEY;
const AZURE_REGION = process.env.AZURE_TRANSLATOR_REGION;

const OS_ADDON = 'https://opensubtitles.strem.io';
const SCS_ADDON = 'https://community-subtitles.strem.io';

// LRU Cache capped at 500 items to prevent RAM exhaustion
class LRUCache {
  constructor(limit = 500) {
    this.limit = limit;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.limit) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, val);
  }
  has(key) {
    return this.cache.has(key);
  }
}

const TRANSLATED_CACHE = new LRUCache(500);

const manifest = {
  id: 'org.stremio.swedish.meta.koyeb',
  version: '1.2.0',
  name: '🇸🇪 Swedish Universal Subtitles (OS + SCS + AI)',
  description: 'Native SV → Fallback EN/FR/ES/DE/Any → Auto-Translate to Swedish (DeepL/Azure). Optimized for TV & Web.',
  logo: 'https://cdn.jsdelivr.net/gh/hakanburok/stremio-addons@main/logos/swedish-flag.png',
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  resources: [
    {
      name: 'subtitles',
      types: ['movie', 'series'],
      idPrefixes: ['tt']
    }
  ],
  behaviorHints: { configurable: false, adult: false, p2p: false }
};

const buildStremioSubUrl = (base, type, id, extra = {}) => {
  const extraSegments = [];
  if (extra.videoHash) extraSegments.push(`videoHash=${extra.videoHash}`);
  if (extra.videoSize) extraSegments.push(`videoSize=${extra.videoSize}`);
  
  const extraPath = extraSegments.length > 0 ? `/${extraSegments.join('&')}` : '';
  // Do not encodeURIComponent entire id so colons (tt123456:1:1) stay unencoded
  return `${base}/subtitles/${type}/${id}${extraPath}.json`;
};

const fetchAddonSubs = async (base, type, id, extra = {}) => {
  const url = buildStremioSubUrl(base, type, id, extra);
  try {
    const { data } = await axios.get(url, { 
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Stremio Universal Subtitles)' }
    });
    return data.subtitles || [];
  } catch (err) {
    return [];
  }
};

const fetchWithHashFallback = async (base, type, fullId, extra = {}) => {
  if (extra.videoHash) {
    const hashedSubs = await fetchAddonSubs(base, type, fullId, extra);
    if (hashedSubs.length > 0) return hashedSubs;
  }
  return await fetchAddonSubs(base, type, fullId);
};

// Selection strategy:
// 1. Native Swedish
// 2. English (preferred target for translation)
// 3. ANY available language (French, German, Spanish, Italian, etc.)
const selectBestSubtitle = (allSubs) => {
  if (!allSubs || !allSubs.length) return null;

  // 1. Native Swedish
  const nativeSv = allSubs.find(s => s.lang && (s.lang === 'swe' || s.lang === 'sv' || s.lang.startsWith('swe') || s.lang.startsWith('sv')));
  if (nativeSv) return { sub: nativeSv, mode: 'native' };

  // 2. English
  const engSub = allSubs.find(s => s.lang && (s.lang === 'eng' || s.lang === 'en' || s.lang.startsWith('eng') || s.lang.startsWith('en')));
  if (engSub) return { sub: engSub, mode: 'translate' };

  // 3. Universal Fallback: Any available language subtitle
  const anySub = allSubs.find(s => s.url && s.url.length > 0);
  if (anySub) return { sub: anySub, mode: 'translate' };

  return null;
};

const translateBatchDeepL = async (texts) => {
  const CHUNK_SIZE = 50;
  const results = [];
  const isFreeKey = DEEPL_KEY.endsWith(':fx');
  const deeplEndpoint = isFreeKey
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE);
    const params = new URLSearchParams();
    chunk.forEach(t => params.append('text', t));
    params.append('target_lang', 'SV');
    // Omitting source_lang enables automatic source language detection in DeepL
    params.append('tag_handling', 'xml');
    
    const { data } = await axios.post(deeplEndpoint, params, {
      headers: { Authorization: `DeepL-Auth-Key ${DEEPL_KEY}` },
      timeout: 20000
    });
    results.push(...data.translations.map(t => t.text));
  }
  return results;
};

const translateText = async (texts) => {
  if (!texts || !texts.length) return texts;

  if (DEEPL_KEY) {
    try {
      return await translateBatchDeepL(texts);
    } catch (e) {
      console.warn('DeepL Translation failed, attempting Azure/Fallback:', e.message);
    }
  }

  if (AZURE_KEY) {
    try {
      // Omitting 'from=' parameter enables Azure automatic language detection
      const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=sv`;
      const body = texts.map(t => ({ Text: t }));
      const headers = { 'Ocp-Apim-Subscription-Key': AZURE_KEY, 'Content-Type': 'application/json' };
      if (AZURE_REGION) headers['Ocp-Apim-Subscription-Region'] = AZURE_REGION;
      
      const { data } = await axios.post(url, body, { headers, timeout: 25000 });
      return data.map(item => item.translations?.[0]?.text || '');
    } catch (e) {
      console.warn('Azure Translation failed:', e.message);
    }
  }

  // Safe Fallback: Return original text if translation service fails so player doesn't crash
  return texts;
};

const translateSubtitle = async (subObj, fileId) => {
  if (TRANSLATED_CACHE.has(fileId)) {
    return `${HOST_URL}/subtitles/translated/${fileId}.srt`;
  }

  try {
    const { data: content } = await axios.get(subObj.url, { 
      responseType: 'text', 
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Stremio Subtitle Translator)' }
    });
    
    if (!content || typeof content !== 'string') return null;

    const parser = new Parser();
    const subs = parser.fromSrt(content);
    if (!subs || !subs.length) return null;

    // Preserve line breaks safely across translation APIs
    const texts = subs.map(s => (s.text || '').replace(/\n/g, ' [BR] ').trim());
    const validIdx = texts.map((t, i) => (t ? i : -1)).filter(i => i !== -1);
    const toTranslate = validIdx.map(i => texts[i]);

    const translated = await translateText(toTranslate);

    let tIdx = 0;
    const newSubs = subs.map((s, i) => {
      if (validIdx.includes(i)) {
        const transText = translated[tIdx++] || s.text;
        return { ...s, text: transText.replace(/ \[BR\] /gi, '\n') };
      }
      return s;
    });

    const sweSrt = parser.toSrt(newSubs);
    TRANSLATED_CACHE.set(fileId, sweSrt);

    return `${HOST_URL}/subtitles/translated/${fileId}.srt`;
  } catch (e) {
    console.error('Error fetching/translating subtitle:', e.message);
    return null;
  }
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async (args) => {
  console.log(`[HANDLER] Subtitle request for ${args.type} - ID: ${args.id}`);
  try {
    const fullId = args.id;
    const extra = args.extra || {};

    const [scsSubs, osSubs] = await Promise.all([
      fetchWithHashFallback(SCS_ADDON, args.type, fullId, extra),
      fetchWithHashFallback(OS_ADDON, args.type, fullId, extra)
    ]);

    const allSubs = [...scsSubs, ...osSubs];
    if (!allSubs.length) return { subtitles: [] };

    const selection = selectBestSubtitle(allSubs);
    if (!selection) return { subtitles: [] };

    const { sub, mode } = selection;

    // Mode 1: Native Swedish Subtitle Found
    if (mode === 'native') {
      return { 
        subtitles: [{ 
          id: `native-sv-${fullId}`, 
          url: sub.url, 
          lang: 'swe', 
          label: '🇸🇪 Swedish (Native)',
          filename: sub.filename || 'swedish.srt', 
          hearingImpaired: !!sub.hearingImpaired 
        }] 
      };
    }

    // Mode 2: Translate Subtitle (From English, French, Spanish, German, or ANY language)
    const sourceLangCode = (sub.lang || 'Unknown').toUpperCase();
    const fileId = Buffer.from(`${sub.url}`).toString('hex').slice(0, 32);
    
    const httpSubUrl = await translateSubtitle(sub, fileId);

    if (!httpSubUrl) return { subtitles: [] };

    return { 
      subtitles: [{ 
        id: `ai-sv-${fullId}`, 
        url: httpSubUrl, 
        lang: 'swe', 
        label: `🇸🇪 Swedish (AI from ${sourceLangCode})`,
        filename: `SV_AI_${sourceLangCode}_${sub.filename || 'sub.srt'}`, 
        hearingImpaired: !!sub.hearingImpaired 
      }] 
    };
  } catch (err) {
    console.error('Subtitles handler exception:', err);
    return { subtitles: [] };
  }
});

const app = express();

// Global CORS Configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'User-Agent']
}));

// Request Logging
app.use((req, res, next) => {
  console.log(`[HTTP ${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (_, res) => res.status(200).send('OK'));

// Subtitle file endpoint optimized for Stremio TV (ExoPlayer, VLC, WebOS, Tizen)
app.get('/subtitles/translated/:fileId.srt', (req, res) => {
  const { fileId } = req.params;
  
  if (TRANSLATED_CACHE.has(fileId)) {
    const srtData = TRANSLATED_CACHE.get(fileId);
    
    // Explicit headers for TV ExoPlayer / VLC video players
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    
    return res.status(200).send(srtData);
  }
  
  res.status(404).send('Subtitle not found or expired from cache.');
});

// Mount Stremio SDK router
app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 Swedish Universal Subtitles Addon Active on Port ${PORT}`);
  console.log(`🔗 Manifest URL: ${HOST_URL}/manifest.json`);
  console.log(`===================================================`);
});
