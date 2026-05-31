require('dotenv').config();

const http = require('http');

const DEFAULT_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart';
const DEFAULT_DTYPE = 'q8';
const DEFAULT_DEVICE = 'cpu';
const MAX_BODY_BYTES = 64000;

const runtime = {
  kokoro: null,
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function endpointPort(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    return 8880;
  }
}

function normalizeFormat(value) {
  const format = typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  return format === 'wav' ? 'wav' : 'wav';
}

function normalizeVoice(value) {
  const voice = typeof value === 'string' ? value.trim() : '';
  return !voice || voice === 'default' ? (process.env.KOKORO_VOICE || DEFAULT_VOICE) : voice;
}

function normalizeModel(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  return model || process.env.KOKORO_MODEL || DEFAULT_MODEL;
}

function normalizeSpeed(value) {
  const speed = Number(value);
  return Number.isFinite(speed) && speed > 0.5 && speed < 2 ? speed : 1;
}

function speechRequestFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object.');
  }

  const input = typeof body.input === 'string' ? body.input : typeof body.text === 'string' ? body.text : '';
  const cleaned = input.replace(/\s+/g, ' ').trim();
  if (!cleaned) throw new Error('Missing speech input.');

  return {
    input: cleaned,
    voice: normalizeVoice(body.voice),
    model: normalizeModel(body.model),
    speed: normalizeSpeed(body.speed),
    responseFormat: normalizeFormat(body.response_format || body.format),
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function kokoroDevice() {
  const device = String(process.env.KOKORO_DEVICE || DEFAULT_DEVICE).trim().toLowerCase();
  if (device && device !== DEFAULT_DEVICE) {
    console.warn(`[kokoro] Ignoring unsupported Node device "${device}"; using "${DEFAULT_DEVICE}".`);
  }
  return DEFAULT_DEVICE;
}

async function loadKokoro(request) {
  if (!runtime.kokoro) {
    runtime.kokoro = import('kokoro-js').then(({ KokoroTTS }) =>
      KokoroTTS.from_pretrained(request.model, {
        dtype: process.env.KOKORO_DTYPE || DEFAULT_DTYPE,
        device: kokoroDevice(),
        progress_callback: progress => {
          if (process.env.KOKORO_LOG_PROGRESS === '1') {
            console.log('[kokoro] progress', progress);
          }
        },
      })
    );
  }
  return runtime.kokoro;
}

async function synthesizeWithKokoro(request) {
  const tts = await loadKokoro(request);
  const audio = await tts.generate(request.input, {
    voice: request.voice,
    speed: request.speed,
  });
  return Buffer.from(audio.toWav());
}

async function handleSpeech(req, res) {
  try {
    const speechRequest = speechRequestFromBody(await readJsonBody(req));
    const audio = await synthesizeWithKokoro(speechRequest);
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': String(audio.length),
      'x-claudio-tts-provider': 'kokoro',
    });
    res.end(audio);
  } catch (err) {
    sendJson(res, 400, {
      error: 'kokoro_tts_failed',
      message: err?.message || 'Unknown Kokoro TTS error',
    });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, {
        ok: true,
        service: 'Claudio Kokoro TTS sidecar',
        app: `http://127.0.0.1:${process.env.PORT || 8080}`,
        health: '/health',
        speech: '/v1/audio/speech',
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        provider: 'kokoro',
        model: process.env.KOKORO_MODEL || DEFAULT_MODEL,
        voice: process.env.KOKORO_VOICE || DEFAULT_VOICE,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
      handleSpeech(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });
}

async function warmKokoro() {
  await synthesizeWithKokoro({
    input: 'Claudio voice warm-up.',
    voice: process.env.KOKORO_VOICE || DEFAULT_VOICE,
    model: process.env.KOKORO_MODEL || DEFAULT_MODEL,
    speed: 1,
    responseFormat: 'wav',
  });
}

async function main() {
  const baseUrl = process.env.KOKORO_API_BASE || 'http://127.0.0.1:8880';
  const host = process.env.KOKORO_HOST || '127.0.0.1';
  const port = Number(process.env.KOKORO_PORT || endpointPort(baseUrl));
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, () => {
      server.off('error', reject);
      console.log(`[kokoro] TTS server listening on http://${host}:${port}`);
      resolve();
    });
  });

  if (process.env.KOKORO_PREWARM !== '0') {
    warmKokoro()
      .then(() => console.log('[kokoro] TTS model is warm.'))
      .catch(err => console.error('[kokoro] warm-up failed:', err?.message || err));
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[kokoro] failed:', err?.message || err);
    process.exitCode = 1;
  });
}

module.exports = { createServer, speechRequestFromBody };
