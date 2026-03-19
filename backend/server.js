/**
 * Exam Killer Backend
 * AI 答题聚合器 - 代理到 Zero Token Gateway
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const ZERO_TOKEN_URL = process.env.ZERO_TOKEN_URL || 'http://localhost:3002';
const ZERO_TOKEN_KEY = process.env.ZERO_TOKEN_KEY || '';
const RATE_LIMIT_DAILY = parseInt(process.env.RATE_LIMIT_DAILY || '20', 10);

// In-memory user store (for demo - use Redis/DB in production)
const userUsage = new Map();

function getUserId(req) {
  // Use IP + a simple device ID header, fallback to IP
  return req.headers['x-device-id'] || req.ip || 'anonymous';
}

function checkRateLimit(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${userId}:${today}`;
  const usage = userUsage.get(key) || 0;
  return { allowed: usage < RATE_LIMIT_DAILY, used: usage, limit: RATE_LIMIT_DAILY };
}

function incrementUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${userId}:${today}`;
  userUsage.set(key, (userUsage.get(key) || 0) + 1);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('../frontend'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Usage status
app.get('/api/usage', (req, res) => {
  const userId = getUserId(req);
  const { used, limit } = checkRateLimit(userId);
  res.json({ used, limit, remaining: Math.max(0, limit - used) });
});

// List available models
app.get('/api/models', async (req, res) => {
  try {
    const response = await axios.get(`${ZERO_TOKEN_URL}/v1/models`, {
      headers: ZERO_TOKEN_KEY ? { 'Authorization': `Bearer ${ZERO_TOKEN_KEY}` } : {},
      timeout: 5000,
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: '无法获取模型列表', detail: error.message });
  }
});

// Chat completion - the main API
app.post('/api/chat', async (req, res) => {
  const userId = getUserId(req);
  const { allowed, used, limit } = checkRateLimit(userId);

  if (!allowed) {
    return res.status(429).json({
      error: '今日次数已用完',
      used,
      limit,
      message: `免费用户每天 ${limit} 次，您今天已用完。明天再来吧 🎓`
    });
  }

  const { message, model = 'deepseek-web/deepseek-chat', system = '' } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message 是必填项' });
  }

  incrementUsage(userId);

  try {
    const messages = [];
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    messages.push({ role: 'user', content: message });

    // Proxy to Zero Token Gateway
    const response = await axios.post(
      `${ZERO_TOKEN_URL}/v1/chat/completions`,
      {
        model,
        messages,
        stream: false,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(ZERO_TOKEN_KEY ? { 'Authorization': `Bearer ${ZERO_TOKEN_KEY}` } : {}),
        },
        timeout: 60000,
        responseType: 'json',
      }
    );

    res.json({
      ...response.data,
      usage: {
        ...checkRateLimit(userId),
        dailyLimit: limit,
      }
    });
  } catch (error) {
    console.error('Zero Token error:', error.message);
    res.status(500).json({
      error: 'AI 服务暂时不可用，请稍后再试',
      detail: error.response?.data?.error || error.message,
    });
  }
});

// Streaming chat
app.post('/api/chat/stream', async (req, res) => {
  const userId = getUserId(req);
  const { allowed, used, limit } = checkRateLimit(userId);

  if (!allowed) {
    res.status(429).json({
      error: '今日次数已用完',
      message: `免费用户每天 ${limit} 次，您今天已用完。明天再来吧 🎓`
    });
    return;
  }

  const { message, model = 'deepseek-web/deepseek-chat', system = '' } = req.body;

  if (!message) {
    res.status(400).json({ error: 'message 是必填项' });
    return;
  }

  incrementUsage(userId);

  const messages = [];
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: message });

  try {
    const response = await axios.post(
      `${ZERO_TOKEN_URL}/v1/chat/completions`,
      {
        model,
        messages,
        stream: true,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...(ZERO_TOKEN_KEY ? { 'Authorization': `Bearer ${ZERO_TOKEN_KEY}` } : {}),
        },
        timeout: 120000,
        responseType: 'stream',
      }
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    response.data.on('data', (chunk) => {
      res.write(chunk);
    });

    response.data.on('end', () => {
      res.end();
    });

    response.data.on('error', (err) => {
      console.error('Stream error:', err.message);
      res.end();
    });
  } catch (error) {
    console.error('Stream error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '流式响应失败' });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Exam Killer Backend running on http://localhost:${PORT}`);
  console.log(`Zero Token Gateway: ${ZERO_TOKEN_URL}`);
  console.log(`Daily rate limit: ${RATE_LIMIT_DAILY} requests per IP`);
});
