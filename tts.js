const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const CACHE_DIR = path.join(__dirname, 'cache/tts');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const VOLCENGINE_DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function audioFormatForProvider(provider, options = {}) {
  if (provider === 'kokoro') return options.format || process.env.KOKORO_RESPONSE_FORMAT || 'wav';
  return options.format || process.env.VOLCENGINE_TTS_FORMAT || 'mp3';
}

function cachePath(text, provider = process.env.TTS_PROVIDER || 'volcengine', options = {}) {
  const voice = getVoiceForProvider(provider, options);
  const role = options.role || 'station';
  const format = audioFormatForProvider(provider, options).replace(/[^a-z0-9]/gi, '') || 'mp3';
  return path.join(CACHE_DIR, `${md5(`${role}:${provider}:${voice}:${format}:${text}`)}.${format}`);
}

function synthesize(text, options = {}) {
  const provider = options.provider || process.env.TTS_PROVIDER || 'volcengine';
  const cached = cachePath(text, provider, options);
  if (fs.existsSync(cached)) {
    console.log(`[TTS] 缓存命中 → ${path.basename(cached)}`);
    return Promise.resolve(cached);
  }

  const preview = text.slice(0, 40) + (text.length > 40 ? '…' : '');
  console.log(`[TTS] 合成中 (${provider}${options.role ? `/${options.role}` : ''})："${preview}"`);
  const startAt = Date.now();

  let promise;
  if (provider === 'volcengine') {
    promise = synthesizeVolcengine(text, cached, options);
  } else if (provider === 'fish') {
    promise = synthesizeFish(text, cached, options);
  } else {
    promise = synthesizeKokoro(text, cached, options);
  }

  return promise.then(p => {
    console.log(`[TTS] 完成 (${((Date.now() - startAt) / 1000).toFixed(1)}s) → ${path.basename(p)}`);
    return p;
  });
}

function getVoiceForProvider(provider, options = {}) {
  if (provider === 'fish') return options.voiceId || process.env.FISH_VOICE_ID || '';
  if (provider === 'volcengine') return options.voiceType || process.env.VOLCENGINE_TTS_VOICE_TYPE || '';
  return options.voice || process.env.KOKORO_VOICE || '';
}

function buildVolcenginePayload(text, options = {}) {
  const voiceType = options.voiceType || process.env.VOLCENGINE_TTS_VOICE_TYPE;
  if (!voiceType) {
    throw new Error('VOLCENGINE_TTS_VOICE_TYPE not set');
  }

  return {
    req_params: {
      text,
      speaker: voiceType,
      additions: options.additions || process.env.VOLCENGINE_TTS_ADDITIONS || JSON.stringify({
        disable_markdown_filter: true,
        enable_language_detector: true,
        enable_latex_tn: true,
        disable_default_bit_rate: true,
        max_length_to_filter_parenthesis: 0,
        cache_config: {
          text_type: 1,
          use_cache: true,
        },
      }),
      audio_params: {
        format: options.format || process.env.VOLCENGINE_TTS_FORMAT || 'mp3',
        sample_rate: Number(options.sampleRate || process.env.VOLCENGINE_TTS_SAMPLE_RATE || 24000),
      },
    },
  };
}

function extractJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const rest = depth > 0 && start !== -1 ? text.slice(start) : '';
  return { objects, rest };
}

async function synthesizeVolcengine(text, outPath, options = {}) {
  const apiKey = options.apiKey || process.env.VOLCENGINE_TTS_API_KEY;
  const resourceId = options.resourceId || process.env.VOLCENGINE_TTS_RESOURCE_ID;

  if (!apiKey || !resourceId) {
    throw new Error('VOLCENGINE_TTS_API_KEY or VOLCENGINE_TTS_RESOURCE_ID not set');
  }

  const endpoint = options.endpoint || process.env.VOLCENGINE_TTS_ENDPOINT || VOLCENGINE_DEFAULT_ENDPOINT;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': crypto.randomUUID(),
      'Connection': 'keep-alive',
    },
    body: JSON.stringify(buildVolcenginePayload(text, options)),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Volcengine TTS error ${res.status}: ${err}`);
  }

  const audioChunks = [];
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parsed = extractJsonObjects(buffer);
    buffer = parsed.rest;

    for (const raw of parsed.objects) {
      const msg = JSON.parse(raw);
      if (msg.code && msg.code !== 20000000) {
        throw new Error(`Volcengine TTS response error ${msg.code}: ${msg.message || ''}`);
      }
      if (msg.data) {
        audioChunks.push(Buffer.from(msg.data, 'base64'));
      }
    }
  }

  buffer += decoder.decode();
  const parsed = extractJsonObjects(buffer);
  for (const raw of parsed.objects) {
    const msg = JSON.parse(raw);
    if (msg.code && msg.code !== 20000000) {
      throw new Error(`Volcengine TTS response error ${msg.code}: ${msg.message || ''}`);
    }
    if (msg.data) {
      audioChunks.push(Buffer.from(msg.data, 'base64'));
    }
  }

  if (!audioChunks.length) {
    throw new Error('Volcengine TTS returned no audio data');
  }

  fs.writeFileSync(outPath, Buffer.concat(audioChunks));
  return outPath;
}

function synthesizeFish(text, outPath, options = {}) {
  const apiKey = options.apiKey || process.env.FISH_API_KEY;
  const voiceId = options.voiceId || process.env.FISH_VOICE_ID;

  if (!apiKey || !voiceId) {
    return Promise.reject(new Error('FISH_API_KEY or FISH_VOICE_ID not set'));
  }

  const body = JSON.stringify({
    text,
    reference_id: voiceId,
    format: 'mp3',
    mp3_bitrate: 128,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.fish.audio',
      path: '/v1/tts',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', d => { err += d; });
        res.on('end', () => reject(new Error(`Fish Audio TTS error ${res.statusCode}: ${err}`)));
        return;
      }
      const out = fs.createWriteStream(outPath);
      res.pipe(out);
      out.on('finish', () => resolve(outPath));
      out.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function synthesizeKokoro(text, outPath, options = {}) {
  const baseUrl = (options.baseUrl || process.env.KOKORO_API_BASE || 'http://127.0.0.1:8880').replace(/\/+$/, '');
  const voice = options.voice || process.env.KOKORO_VOICE || 'af_heart';
  const model = options.model || process.env.KOKORO_MODEL || 'kokoro';
  const responseFormat = options.format || process.env.KOKORO_RESPONSE_FORMAT || 'wav';

  const res = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: responseFormat,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Kokoro TTS error ${res.status}: ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

module.exports = { synthesize, cachePath };
