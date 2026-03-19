# Exam Killer

> AI 答题聚合器 — 免 API Key，基于浏览器登录方案

## 功能

- 🚀 无需 API Key，用户直接使用
- 🤖 支持 DeepSeek / Qwen / Kimi / 豆包 等主流模型
- ⚡ 速率限制（免费用户每天 20 次）
- 📱 响应式界面

## 架构

```
用户浏览器
    ↓
Exam Killer 前端 (Static)
    ↓
Exam Killer 后端 (Express)
    ↓
Zero Token Gateway (NAS 上运行)
    ↓
DeepSeek / Qwen / Kimi / 豆包...
```

## 快速开始

### 前置要求

- Node.js >= 18
- Zero Token Gateway 运行中（参考 [Zero Token 文档](https://github.com/linuxhsj/openclaw-zero-token)）

### 安装

```bash
# 克隆
git clone https://github.com/LytmX/exam-killer.git
cd exam-killer

# 安装后端
cd backend && npm install

# 配置环境变量
cp ../.env.example .env
# 编辑 .env，填入 Zero Token Gateway 地址和端口

# 启动
npm start
```

### 部署前端

```bash
cd ../frontend
# 将静态文件部署到任意静态托管（Vercel / Netlify / Cloudflare Pages）
```

## 环境变量 (.env)

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ZERO_TOKEN_URL` | Zero Token Gateway 地址 | `http://localhost:3002` |
| `ZERO_TOKEN_KEY` | Zero Token Gateway Token | `your-gateway-token` |
| `PORT` | 后端端口 | `3000` |
| `RATE_LIMIT_DAILY` | 免费用户每日次数 | `20` |

## 开发

```bash
cd backend
npm run dev  # 开发模式（nodemon）
```

## License

MIT
