/**
 * Exam Killer Backend v6
 * 多 AI 比对 + 图片理解 — Wolfram Alpha + Silicon Flow 多模型(含视觉)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const WOLFRAM_APP_ID = process.env.WOLFRAM_APP_ID || 'RKVT57E2AW';
const SILICON_FLOW_KEY = process.env.SILICON_FLOW_KEY;
const RATE_LIMIT_DAILY = parseInt(process.env.RATE_LIMIT_DAILY || '50', 10);

// Silicon Flow 模型列表
const SILICON_MODELS = {
  // 文本模型（每个系列只留最强一个）
  'deepseek-v3':   'deepseek-ai/DeepSeek-V3',
  'deepseek-r1':   'deepseek-ai/DeepSeek-R1',
  'qwen-14b':      'Qwen/Qwen2.5-14B-Instruct',
  'glm-4':         'zai-org/GLM-4-9B-Chat',
  // 视觉模型（支持图片理解）
  'qwen-vl-72b':   'Qwen/Qwen2.5-VL-72B-Instruct',
  'qwen3-vl-32b':  'Qwen/Qwen3-VL-32B-Instruct',
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
    let steps = '';
    
    for (const pod of pods) {
      const title = (pod.title || '').toLowerCase();
      const plaintext = pod.subpods?.map(s => s.plaintext).filter(Boolean).join('\n') || '';
      if (title.includes('result') || title.includes('solutions') || title.includes('answer')) {
        if (plaintext && !answer) answer = plaintext;
      }
      if (title.includes('step') || title.includes('derivation')) {
        if (plaintext) steps = plaintext;
      }
    }
    
    if (!answer) {
      for (const pod of pods) {
        const text = pod.subpods?.map(s => s.plaintext).filter(Boolean).join('\n');
        if (text) { answer = text; break; }
      }
    }

    return { 
      provider: 'Wolfram Alpha', 
      answer: answer || '无解析结果',
      steps: steps || '',
      confidence: answer ? 0.95 : 0.2,
    };
  } catch (error) {
    return { provider: 'Wolfram Alpha', error: error.message, answer: null, confidence: 0 };
  }
}

// Silicon Flow 文本模型
async function askSiliconText(question, modelKey) {
  const modelId = SILICON_MODELS[modelKey];
  if (!modelId) return { provider: `Silicon Flow (${modelKey})`, error: '未知模型', answer: null, confidence: 0 };
  
  try {
    const response = await axios.post(
      'https://api.siliconflow.cn/v1/chat/completions',
      {
        model: modelId,
        messages: [{
          role: 'user',
          content: `你是一个专业的 AI 答题助手。请解答以下问题，给出详细步骤和最终答案。\n\n问题：${question}`,
        }],
        stream: false,
      },
      {
        headers: {
          'Authorization': `Bearer ${SILICON_FLOW_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 90000,
      }
    );
    
    const answer = response.data?.choices?.[0]?.message?.content || '';
    return {
      provider: `Silicon Flow (${modelKey.toUpperCase()})`,
      model: modelId,
      answer,
      steps: '',
      confidence: 0.85,
    };
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    return { provider: `Silicon Flow (${modelKey.toUpperCase()})`, error: msg, answer: null, confidence: 0 };
  }
}

// Silicon Flow 视觉模型（支持图片理解）
async function askSiliconVision(question, images, modelKey) {
  const modelId = SILICON_MODELS[modelKey];
  if (!modelId) return { provider: `Silicon Flow (${modelKey})`, error: '未知模型', answer: null, confidence: 0 };
  
  try {
    // 构建多模态消息内容
    const content = [];
    
    // 文本部分
    let textPrompt = question;
    if (images && images.length > 0) {
      textPrompt = `请看这张图片，解答以下问题。如果图片中有图表、坐标系、表格或示意图，请仔细分析后再作答。\n\n问题：${question}`;
    }
    content.push({ type: 'text', text: textPrompt });
    
    // 图片部分（支持多张）
    if (images && images.length > 0) {
      for (const img of images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: img.url.startsWith('data:') ? img.url : `data:image/jpeg;base64,${img.url}`,
            detail: 'high',
          },
        });
      }
    }
    
    const response = await axios.post(
      'https://api.siliconflow.cn/v1/chat/completions',
      {
        model: modelId,
        messages: [{ role: 'user', content }],
        stream: false,
      },
      {
        headers: {
          'Authorization': `Bearer ${SILICON_FLOW_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000,
      }
    );
    
    const answer = response.data?.choices?.[0]?.message?.content || '';
    return {
      provider: `Silicon Flow (${modelKey.toUpperCase()} +视觉)`,
      model: modelId,
      answer,
      steps: '',
      confidence: 0.88,
      images: images ? images.length : 0,
    };
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    return { provider: `Silicon Flow (${modelKey.toUpperCase()} +视觉)`, error: msg, answer: null, confidence: 0 };
  }
}

// ==================== Routes ====================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '6.0.0', 
    providers: Object.keys(SILICON_MODELS),
    vision_models: ['qwen-vl-72b', 'qwen-vl-32b', 'qwen3-vl-32b', 'qwen3-vl-8b'],
  });
});

app.get('/api/models', (req, res) => {
  const text = Object.entries(SILICON_MODELS)
    .filter(([k]) => !k.startsWith('qwen-vl') && !k.startsWith('qwen3-vl'))
    .map(([key, id]) => ({ key, id, type: 'text' }));
  const vision = Object.entries(SILICON_MODELS)
    .filter(([k]) => k.startsWith('qwen-vl') || k.startsWith('qwen3-vl'))
    .map(([key, id]) => ({ key, id, type: 'vision' }));
  res.json({ text, vision, all: Object.entries(SILICON_MODELS).map(([key, id]) => ({ key, id })) });
});

app.get('/api/usage', (req, res) => {
  const { used, limit } = checkRateLimit(getUserId(req));
  res.json({ used, limit, remaining: Math.max(0, limit - used) });
});

app.post('/api/ask', async (req, res) => {
  const userId = getUserId(req);
  const { allowed } = checkRateLimit(userId);
  
  if (!allowed) {
    return res.status(429).json({
      error: '今日次数已用完',
      message: `免费用户每天 ${RATE_LIMIT_DAILY} 次，明天再来吧 🎓`,
    });
  }
  
  // providers: wolfram, silicon-deepseek-v3, silicon-qwen-14b, silicon-qwen-vl-72b, ...
  // images: [{url: 'data:image/...;base64,...'}] 或 [{url: 'https://...'}] 
  const { question, providers = ['wolfram', 'silicon-deepseek-v3', 'silicon-qwen-vl-72b'], images = [] } = req.body;
  
  if (!question?.trim() && images.length === 0) {
    return res.status(400).json({ error: 'question 或 images 是必填项' });
  }
  
  incrementUsage(userId);
  
  const tasks = [];
  for (const p of providers) {
    if (p === 'wolfram') {
      // Wolfram 不支持图片，纯文本
      if (images.length === 0) {
        tasks.push(askWolframAlpha(question));
      }
    } else if (p.startsWith('silicon-')) {
      const modelKey = p.replace('silicon-', '');
      const modelId = SILICON_MODELS[modelKey];
      if (!modelId) continue;
      
      if (VISION_MODEL_IDS.has(modelId)) {
        // 视觉模型：传入图片
        tasks.push(askSiliconVision(question, images, modelKey));
      } else {
        // 文本模型：如果有图片就跳过（不支持）
        if (images.length === 0) {
          tasks.push(askSiliconText(question, modelKey));
        }
      }
    }
  }
  
  if (tasks.length === 0) {
    return res.json({
      question,
      images: images.length,
      answers: [],
      comparison: images.length > 0 
        ? '所选模型均不支持图片，或无可用文本模型' 
        : '请至少选择一个可用的 AI 模型',
      bestAnswer: null,
    });
  }
  
  const results = await Promise.allSettled(tasks);
  const answers = results
    .filter(r => r.status === 'fulfilled' && r.value?.answer)
    .map(r => r.value);
  
  if (answers.length === 0) {
    return res.json({
      question,
      images: images.length,
      answers: [],
      comparison: '所有 AI 均无法解答此问题',
      bestAnswer: null,
    });
  }
  
  const comparison = analyzeComparison(answers);
  
  res.json({
    question,
    images: images.length,
    answers,
    comparison,
    bestAnswer: comparison.bestAnswer,
    stats: { count: answers.length, ...checkRateLimit(userId) },
  });
});

// 图片上传接口（支持 base64 或 URL）
app.post('/api/upload', async (req, res) => {
  const { image } = req.body; // base64 或 URL
  if (!image) return res.status(400).json({ error: 'image 是必填项' });
  
  // 简单验证：是否为有效 base64 或 URL
  const isBase64 = image.startsWith('data:') || /^[A-Za-z0-9+/=]{50,}$/.test(image);
  const isUrl = image.startsWith('http://') || image.startsWith('https://');
  
  if (!isBase64 && !isUrl) {
    return res.status(400).json({ error: '无效的图片格式' });
  }
  
  res.json({ success: true, hasImage: true });
});

function analyzeComparison(answers) {
  if (answers.length === 1) {
    return {
      summary: `仅有 ${answers[0].provider} 给出了答案`,
      bestAnswer: answers[0],
      consensus: true,
    };
  }
  
  // 提取数字找共识
  const texts = answers.map(a => 
    (a.answer || '').toLowerCase()
      .replace(/[^\w\.\-\+\=\≈≈]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  
  const numbers = texts.map(t => {
    const matches = t.match(/[\d\.\-\+]+/g);
    return matches ? matches[0] : null;
  }).filter(Boolean);
  
  const consensusNumber = numbers.length > 1 
    ? numbers.find(n => numbers.filter(x => x === n).length > answers.length / 2) 
    : null;
  
  if (consensusNumber) {
    const agreeing = answers.filter(a => (a.answer || '').includes(consensusNumber));
    return {
      summary: `${agreeing.length}/${answers.length} 个 AI 达成共识：${consensusNumber}`,
      bestAnswer: agreeing[0],
      consensus: true,
      consensusNumber,
    };
  }
  
  const best = answers.reduce((a, b) => (a.confidence > b.confidence ? a : b));
  return {
    summary: `${answers.length} 个 AI 给出不同答案，建议核实`,
    bestAnswer: best,
    consensus: false,
    answers: answers.map(a => ({
      provider: a.provider,
      answer: (a.answer || '').slice(0, 500),
      confidence: a.confidence,
    })),
  };
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Exam Killer v6.0 running on :${PORT}`);
  console.log(`Text models: ${Object.entries(SILICON_MODELS).filter(([k]) => !k.startsWith('qwen-vl') && !k.startsWith('qwen3-vl')).map(([k]) => k).join(', ')}`);
  console.log(`Vision models: ${Object.entries(SILICON_MODELS).filter(([k]) => k.startsWith('qwen-vl') || k.startsWith('qwen3-vl')).map(([k]) => k).join(', ')}`);
  console.log(`Rate limit: ${RATE_LIMIT_DAILY}/day per IP`);
});
