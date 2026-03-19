/**
 * Exam Killer Backend v8
 * 多 AI 比对 + 流式输出 + DeepSeek 直连 + Silicon Flow 备用
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const WOLFRAM_APP_ID = process.env.WOLFRAM_APP_ID || 'RKVT57E2AW';
const SILICON_FLOW_KEY = process.env.SILICON_FLOW_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;
const KIMI_KEY = process.env.KIMI_KEY;
const QWEN_KEY = process.env.QWEN_KEY;
const RATE_LIMIT_DAILY = parseInt(process.env.RATE_LIMIT_DAILY || '50', 10);

// Silicon Flow 模型列表
const SILICON_MODELS = {
  'deepseek-r1':    'deepseek-ai/DeepSeek-R1',
  'kimi-thinking':  'moonshotai/Kimi-K2-Thinking',
  'qwen-thinking':  'Qwen/Qwen3-30B-A3B-Thinking-2507',
  'qwen-vl-72b':    'Qwen/Qwen2.5-VL-72B-Instruct',
};

// DeepSeek 直连模型
const DEEPSEEK_MODELS = {
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-reasoner',
};

// Kimi 直连模型
const KIMI_MODELS = {
  'moonshot-v1-8k': 'moonshot-v1-8k',
  'moonshot-v1-32k': 'moonshot-v1-32k',
};

// 视觉模型 ID 集合
const VISION_MODEL_IDS = new Set([
  'Qwen/Qwen2.5-VL-72B-Instruct',
  'Qwen/Qwen2.5-VL-32B-Instruct',
  'Qwen/Qwen3-VL-32B-Instruct',
  'Qwen/Qwen3-VL-32B-Thinking',
  'Qwen/Qwen3-VL-8B-Instruct',
  'Qwen/Qwen3-VL-8B-Thinking',
  'Qwen/Qwen3-VL-30B-A3B-Instruct',
  'Qwen/Qwen3-VL-30B-A3B-Thinking',
  'Qwen/Qwen3-VL-235B-A22B-Instruct',
  'Qwen/Qwen3-VL-235B-A22B-Thinking',
  'Qwen/Qwen3-30B-A3B-Thinking-2507',
]);

const userUsage = new Map();

function getUserId(req) {
  return req.headers['x-device-id'] || req.ip || 'anonymous';
}

function checkRateLimit(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${userId}:${today}`;
  const used = userUsage.get(key) || 0;
  return { allowed: used < RATE_LIMIT_DAILY, used, limit: RATE_LIMIT_DAILY };
}

function incrementUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${userId}:${today}`;
  userUsage.set(key, (userUsage.get(key) || 0) + 1);
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ==================== AI Providers ====================

async function askWolframAlpha(question) {
  try {
    const url = `https://api.wolframalpha.com/v2/query?${new URLSearchParams({
      input: question,
      appid: WOLFRAM_APP_ID,
      output: 'json',
    })}`;
    const response = await axios.get(url, { timeout: 15000 });
    const data = response.data;
    const queryresult = data?.queryresult;
    if (!queryresult || queryresult.success === false) {
      return { provider: 'Wolfram Alpha', error: '无法解答此问题', answer: null, confidence: 0 };
    }
    const pods = queryresult.pods || [];
    let answer = '';
    for (const pod of pods) {
      const title = (pod.title || '').toLowerCase();
      const plaintext = pod.subpods?.map(s => s.plaintext).filter(Boolean).join('\n') || '';
      if (title.includes('result') || title.includes('solutions') || title.includes('answer')) {
        if (plaintext && !answer) answer = plaintext;
      }
    }
    if (!answer) {
      for (const pod of pods) {
        const text = pod.subpods?.map(s => s.plaintext).filter(Boolean).join('\n');
        if (text) { answer = text; break; }
      }
    }
    return { provider: 'Wolfram Alpha', answer: answer || '无解析结果', confidence: answer ? 0.95 : 0.2 };
  } catch (error) {
    return { provider: 'Wolfram Alpha', error: error.message, answer: null, confidence: 0 };
  }
}

// DeepSeek 直连（非流式）
async function askDeepSeek(question, model = 'deepseek-chat') {
  if (!DEEPSEEK_KEY) return { provider: 'DeepSeek (直连)', error: '未配置 API Key', answer: null, confidence: 0 };
  try {
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      { model, messages: [{ role: 'user', content: question }], stream: false },
      { headers: { 'Authorization': `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    const answer = response.data?.choices?.[0]?.message?.content || '';
    return { provider: 'DeepSeek (直连)', model, answer, confidence: 0.9 };
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    return { provider: 'DeepSeek (直连)', error: msg, answer: null, confidence: 0 };
  }
}

// Qwen Turbo 直连（DashScope，非流式，1-2秒极速）
async function askQwen(question, res) {
  if (!QWEN_KEY) {
    res.write(`data: ${JSON.stringify({ provider: 'Qwen (直连)', error: '未配置 API Key', done: true })}\n\n`);
    return;
  }
  const postData = JSON.stringify({
    model: 'qwen-turbo',
    input: { prompt: `你是一个专业的 AI 答题助手。请解答以下问题，给出详细步骤和最终答案。\n\n问题：${question}` },
    stream: false
  });
  const options = {
    hostname: 'dashscope.aliyuncs.com',
    path: '/api/v1/services/aigc/text-generation/generation',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${QWEN_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk.toString(); });
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.output?.text || parsed.error?.message || '';
          if (text) {
            res.write(`data: ${JSON.stringify({ provider: 'Qwen (直连)', chunk: text, done: false })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ provider: 'Qwen (直连)', error: parsed.error?.message || '未知错误', done: false })}\n\n`);
          }
        } catch (e) {
          res.write(`data: ${JSON.stringify({ provider: 'Qwen (直连)', error: e.message, done: false })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end(); resolve();
      });
      apiRes.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ provider: 'Qwen (直连)', error: err.message, done: true })}\n\n`);
        res.end(); resolve();
      });
    });
    req.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ provider: 'Qwen (直连)', error: err.message, done: true })}\n\n`);
      res.end(); resolve();
    });
    req.write(postData); req.end();
  });
}

// Kimi 直连流式（通过 SSE）
async function askKimiStream(question, res, model = 'moonshot-v1-8k') {
  if (!KIMI_KEY) {
    res.write(`data: ${JSON.stringify({ provider: 'Kimi (直连)', error: '未配置 API Key', done: true })}\n\n`);
    return;
  }
  const postData = JSON.stringify({ model, messages: [{ role: 'user', content: question }], stream: true });
  const options = {
    hostname: 'api.moonshot.cn',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KIMI_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        res.write(`data: ${JSON.stringify({ provider: 'Kimi (直连)', error: `HTTP ${apiRes.statusCode}`, done: true })}\n\n`);
        res.end(); resolve();
        return;
      }
      apiRes.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            } else {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) {
                  res.write(`data: ${JSON.stringify({ provider: 'Kimi (直连)', chunk: content, done: false })}\n\n`);
                }
              } catch {}
            }
          }
        }
      });
      apiRes.on('end', () => { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); res.end(); resolve(); });
      apiRes.on('error', (err) => { res.write(`data: ${JSON.stringify({ provider: 'Kimi (直连)', error: err.message, done: true })}\n\n`); res.end(); resolve(); });
    });
    req.on('error', (err) => { res.write(`data: ${JSON.stringify({ provider: 'Kimi (直连)', error: err.message, done: true })}\n\n`); res.end(); resolve(); });
    req.write(postData); req.end();
  });
}

// DeepSeek 直连流式（通过 SSE），使用原生 https
async function askDeepSeekStream(question, res, model = 'deepseek-chat') {
  if (!DEEPSEEK_KEY) {
    res.write(`data: ${JSON.stringify({ provider: 'DeepSeek (直连)', error: '未配置 API Key', done: true })}\n\n`);
    return;
  }
  
  const postData = JSON.stringify({ model, messages: [{ role: 'user', content: question }], stream: true });
  const options = {
    hostname: 'api.deepseek.com',
    path: '/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEEPSEEK_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };
  
  return new Promise((resolve) => {
    const req = https.request(options, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        res.write(`data: ${JSON.stringify({ provider: 'DeepSeek (直连)', error: `HTTP ${apiRes.statusCode}`, done: true })}\n\n`);
        res.end();
        resolve();
        return;
      }
      
      apiRes.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            } else {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) {
                  res.write(`data: ${JSON.stringify({ provider: 'DeepSeek (直连)', chunk: content, done: false })}\n\n`);
                }
              } catch {}
            }
          }
        }
      });
      
      apiRes.on('end', () => {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        resolve();
      });
      
      apiRes.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ provider: 'DeepSeek (直连)', error: err.message, done: true })}\n\n`);
        res.end();
        resolve();
      });
    });
    
    req.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ provider: 'DeepSeek (直连)', error: err.message, done: true })}\n\n`);
      res.end();
      resolve();
    });
    
    req.write(postData);
    req.end();
  });
}

// Silicon Flow 单模型调用（非流式）
async function askSiliconText(question, modelKey) {
  const modelId = SILICON_MODELS[modelKey];
  if (!modelId) return { provider: `Silicon Flow (${modelKey})`, error: '未知模型', answer: null, confidence: 0 };
  if (!SILICON_FLOW_KEY) return { provider: `Silicon Flow (${modelKey})`, error: '未配置 API Key', answer: null, confidence: 0 };
  try {
    const response = await axios.post(
      'https://api.siliconflow.cn/v1/chat/completions',
      { model: modelId, messages: [{ role: 'user', content: `你是一个专业的 AI 答题助手。请解答以下问题，给出详细步骤和最终答案。\n\n问题：${question}` }], stream: false },
      { headers: { 'Authorization': `Bearer ${SILICON_FLOW_KEY}`, 'Content-Type': 'application/json' }, timeout: 180000 }
    );
    const answer = response.data?.choices?.[0]?.message?.content || '';
    return { provider: `Silicon Flow (${modelKey.toUpperCase()})`, model: modelId, answer, confidence: 0.85 };
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    return { provider: `Silicon Flow (${modelKey.toUpperCase()})`, error: msg, answer: null, confidence: 0 };
  }
}

// Silicon Flow 视觉模型
async function askSiliconVision(question, images, modelKey) {
  const modelId = SILICON_MODELS[modelKey];
  if (!modelId) return { provider: `Silicon Flow (${modelKey})`, error: '未知模型', answer: null, confidence: 0 };
  if (!SILICON_FLOW_KEY) return { provider: `Silicon Flow (${modelKey})`, error: '未配置 API Key', answer: null, confidence: 0 };
  const content = [];
  content.push({ type: 'text', text: images.length > 0 ? `请看这张图片，解答以下问题。如果图片中有图表、坐标系、表格或示意图，请仔细分析后再作答。\n\n问题：${question}` : question });
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: img.url.startsWith('data:') ? img.url : `data:image/jpeg;base64,${img.url}`, detail: 'high' } });
  }
  try {
    const response = await axios.post(
      'https://api.siliconflow.cn/v1/chat/completions',
      { model: modelId, messages: [{ role: 'user', content }], stream: false },
      { headers: { 'Authorization': `Bearer ${SILICON_FLOW_KEY}`, 'Content-Type': 'application/json' }, timeout: 180000 }
    );
    const answer = response.data?.choices?.[0]?.message?.content || '';
    return { provider: `Silicon Flow (${modelKey.toUpperCase()} +视觉)`, model: modelId, answer, confidence: 0.88, images: images.length };
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    return { provider: `Silicon Flow (${modelKey.toUpperCase()} +视觉)`, error: msg, answer: null, confidence: 0 };
  }
}

// ==================== Routes ====================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', version: '8.0.0',
    deepseek_direct: !!DEEPSEEK_KEY,
    silicon_flow: !!SILICON_FLOW_KEY,
    providers: ['wolfram', 'deepseek-chat', 'silicon-deepseek-r1', 'silicon-kimi-thinking', 'silicon-qwen-thinking', 'silicon-qwen-vl-72b'],
  });
});

app.get('/api/usage', (req, res) => {
  const { used, limit } = checkRateLimit(getUserId(req));
  res.json({ used, limit, remaining: Math.max(0, limit - used) });
});

// 流式答题接口（SSE）
app.post('/api/ask/stream', async (req, res) => {
  const userId = getUserId(req);
  const { allowed } = checkRateLimit(userId);
  if (!allowed) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ error: '今日次数已用完', done: true })}\n\n`);
    res.end(); return;
  }
  const { question, providers = ['wolfram'], images = [], model = 'deepseek-chat' } = req.body;
  if (!question?.trim() && images.length === 0) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ error: 'question 是必填项', done: true })}\n\n`);
    res.end(); return;
  }
  incrementUsage(userId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 不做图片预识别，视觉模型直接读图，其他模型用纯文本
  const hasImages = images.length > 0;
  for (const p of providers) {
    if (p === 'wolfram') {
      if (hasImages) continue; // Wolfram 不支持图片
      askWolframAlpha(question).then(r => {
        if (r && r.answer) res.write(`data: ${JSON.stringify({ type: 'answer', ...r, done: true })}\n\n`);
      });
    } else if (p === 'deepseek-chat') {
      if (hasImages) continue; // DeepSeek 不支持图片
      askDeepSeekStream(question, res, model);
    } else if (p === 'kimi-chat') {
      if (hasImages) continue; // Kimi 不支持图片
      askKimiStream(question, res, 'moonshot-v1-8k');
    } else if (p === 'qwen-chat') {
      if (hasImages) continue; // Qwen Turbo 不支持图片
      askQwen(question, res);
    } else if (p.startsWith('silicon-')) {
      const modelKey = p.replace('silicon-', '');
      const modelId = SILICON_MODELS[modelKey];
      if (!modelId) continue;
      if (VISION_MODEL_IDS.has(modelId)) {
        // 视觉模型直接读图（不去预识别）
        askSiliconVision(question, images, modelKey).then(r => {
          if (r && r.answer) res.write(`data: ${JSON.stringify({ type: 'answer', ...r, done: true })}\n\n`);
        });
      } else {
        if (hasImages) continue; // 文本模型不支持图片
        askSiliconText(question, modelKey).then(r => {
          if (r && r.answer) res.write(`data: ${JSON.stringify({ type: 'answer', ...r, done: true })}\n\n`);
        });
      }
    }
  }

  setTimeout(() => {
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  }, 120000);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Exam Killer v8.0 running on :${PORT}`);
  console.log(`DeepSeek 直连: ${DEEPSEEK_KEY ? '✓' : '✗'}`);
  console.log(`Silicon Flow: ${SILICON_FLOW_KEY ? '✓' : '✗'}`);
});
