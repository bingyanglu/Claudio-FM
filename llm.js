const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || 'deepseek';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || '';
const DEEPSEEK_THINKING = process.env.DEEPSEEK_THINKING || '';
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_REASONING_EFFORT = process.env.GEMINI_REASONING_EFFORT || '';

async function generateJson(prompt, options = {}) {
  const provider = options.provider || DEFAULT_PROVIDER;
  if (provider === 'deepseek') return callDeepSeek(prompt, options);
  if (provider === 'gemini') return callGemini(prompt, options);
  if (provider === 'claude_cli') return callClaudeCli(prompt, options);
  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

async function callDeepSeek(prompt, options = {}) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY not set');
  }

  const OpenAI = await loadOpenAI();
  const client = new OpenAI({
    baseURL: process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL,
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
  const model = options.model || process.env.DEEPSEEK_MODEL || DEEPSEEK_MODEL;
  const startAt = Date.now();
  console.log(`[LLM:deepseek] 调用中，model ${model}，prompt ${prompt.length} 字符…`);

  const request = {
    model,
    messages: [
      { role: 'system', content: 'You are Claudio FM. Return strict JSON only.' },
      { role: 'user', content: prompt },
    ],
    stream: false,
  };
  if (DEEPSEEK_THINKING) request.thinking = { type: DEEPSEEK_THINKING };
  if (DEEPSEEK_REASONING_EFFORT) request.reasoning_effort = DEEPSEEK_REASONING_EFFORT;

  const completion = await withTimeout(
    client.chat.completions.create(request),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `DeepSeek request timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`
  );
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  const parsed = parseResponse(raw);
  logParsedResponse('deepseek', elapsed, parsed, raw);
  return parsed;
}

async function callGemini(prompt, options = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set');
  }

  const OpenAI = await loadOpenAI();
  const client = new OpenAI({
    baseURL: process.env.GEMINI_BASE_URL || GEMINI_BASE_URL,
    apiKey: process.env.GEMINI_API_KEY,
  });
  const model = options.model || process.env.GEMINI_MODEL || GEMINI_MODEL;
  const startAt = Date.now();
  console.log(`[LLM:gemini] 调用中，model ${model}，prompt ${prompt.length} 字符…`);

  const request = {
    model,
    messages: [
      { role: 'system', content: 'You are Claudio FM. Return strict JSON only.' },
      { role: 'user', content: prompt },
    ],
    stream: false,
  };
  if (GEMINI_REASONING_EFFORT) request.reasoning_effort = GEMINI_REASONING_EFFORT;

  const completion = await withTimeout(
    client.chat.completions.create(request),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `Gemini request timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`
  );
  const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  const parsed = parseResponse(raw);
  logParsedResponse('gemini', elapsed, parsed, raw);
  return parsed;
}

async function loadOpenAI() {
  try {
    const mod = await import('openai');
    return mod.default || mod.OpenAI || mod;
  } catch (err) {
    throw new Error('OpenAI SDK not installed. Run `yarn add openai` or `npm install openai`.');
  }
}

function callClaudeCli(prompt, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const startAt = Date.now();
  console.log(`[LLM:claude_cli] 调用中，prompt ${prompt.length} 字符…`);
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      const stderrPreview = stderr.trim().slice(-800);
      console.error(`[LLM:claude_cli] 超时（${Math.round(timeoutMs / 1000)}s），已终止；prompt ${prompt.length} 字符`);
      if (stderrPreview) console.error(`[LLM:claude_cli] stderr 摘要: ${stderrPreview}`);
      reject(new Error('Claude subprocess timed out'));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    proc.on('close', () => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
      const raw = stdout.trim();
      const parsed = parseResponse(raw);
      logParsedResponse('claude_cli', elapsed, parsed, raw);
      if (!raw) console.warn('[LLM:claude_cli] 警告：返回内容为空');
      resolve(parsed);
    });

    proc.on('error', err => {
      clearTimeout(timer);
      console.error('[LLM:claude_cli] 进程错误:', err.message);
      reject(err);
    });
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseResponse(raw) {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: parsed.title || '',
        say: parsed.say || '',
        play: Array.isArray(parsed.play) ? parsed.play : [],
        segments: Array.isArray(parsed.segments) ? parsed.segments : [],
        intros: Array.isArray(parsed.intros) ? parsed.intros : [],
        reason: parsed.reason || '',
        mode: parsed.mode || '',
      };
    } catch {}
  }
  return { title: '', say: raw || 'Okay.', play: [], segments: [], intros: [], reason: '', segue: '', mode: '' };
}

function logParsedResponse(provider, elapsed, parsed, raw) {
  const firstSegment = parsed.segments?.find(s => s?.text)?.text || parsed.say || '';
  const preview = firstSegment.slice(0, 60);
  console.log(`[LLM:${provider}] 响应 (${elapsed}s) → 「${parsed.title || '无标题'}」| ${parsed.play?.length || 0} 首 | segments: ${parsed.segments?.length || 0} | "${preview}${preview.length >= 60 ? '…' : ''}"`);
  if (!raw) console.warn(`[LLM:${provider}] 警告：返回内容为空`);
}

module.exports = { generateJson, parseResponse };
