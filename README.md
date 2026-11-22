# FreePi2API 🚀

**Multi-Account FreePi to OpenAI/Anthropic API Gateway & Admin Management Dashboard**  
Deploy easily on **Coolify**, Docker, or run locally. Zero external npm dependencies.

[![Deploy on Coolify](https://img.shields.io/badge/Coolify-Ready-6B21A8?style=for-the-badge&logo=docker)](https://coolify.io)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20-green?style=for-the-badge&logo=node.js)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

---

## ✨ Features

- 🖥️ **Full Web Dashboard UI (`/`)**: Manage accounts, view daily credit allowances, and configure API keys directly from your browser.
- ⚡ **One-Click FreePi Login**: Sign in with GitHub directly via URL (`/login`) or with 1-click in the dashboard. No terminal or `npx` commands needed.
- 🔄 **Multi-Account Pool & Smart Rotation**:
  - Pool multiple FreePi accounts/tokens.
  - Automatic round-robin load balancing.
  - **Instant Failover**: If an account hits a rate limit (`429`) or runs out of daily credits, requests automatically switch to the next healthy account.
- 🔒 **Admin Access Control**:
  - Protect the dashboard with an **Admin Dashboard Key** to prevent unauthorized public access on your VPS.
  - Protect `/v1/` endpoints with a custom **Bridge API Key**.
- 🛡️ **Automated Ad Keepalive**:
  - FreePi free tiers pause if ads are not reported periodically. The bridge automatically sends ad keepalive impressions every 5 minutes in the background.
- 🧹 **10-Day Auto-Pruning Log Storage**:
  - Server logs are automatically cleaned up after 10 days to protect your Coolify VPS disk from filling up.
- 💬 **Interactive AI Playground**:
  - Test completions and stream live responses from 28 models (`particle`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `gemini-4-carbon`, `gpt-6.2-astra`, etc.).
- 🌐 **OpenAI & Anthropic Compatible**:
  - OpenAI `/v1/chat/completions` & `/v1/models`
  - Anthropic `/v1/messages` (Claude Code, Cline, Roo Code support)

---

## 🚀 Coolify Deployment Guide (No Data Loss Guarantee)

To ensure your accounts, settings, and logs **never get lost after updates or redeployments**, follow these simple steps in Coolify:

### Step 1: Create Application in Coolify
1. In your Coolify dashboard, click **+ Add Resource** -> **Application**.
2. Select **Public Repository** and enter:
   ```
   https://github.com/Fuad7061/freepi2api
   ```
3. Set **Build Pack** to **Dockerfile**.
4. Set **Port** to `8787`.

### Step 2: Add Persistent Storage (Crucial for Data Persistence)
In your Coolify Application settings:
1. Navigate to the **Storages** tab.
2. Click **+ Add Storage**:
   - **Name:** `freepi_data`
   - **Destination Path:** `/app/data`
3. Click **Save**.  
*(This mounts `/app/data` to your VPS disk so accounts, tokens, and configs remain 100% intact across any container rebuild, update, or redeploy!)*

### Step 3: (Optional) Set Environment Variables
In the **Environment Variables** tab:
```env
PORT=8787
HOST=0.0.0.0
# Optional: Set a secret key required by external AI tools
BRIDGE_API_KEY=
# Optional: Set a password to lock the Admin Dashboard UI
ADMIN_PASSWORD=
AUTO_AD=1
LOG_RETENTION_DAYS=10
```

### Step 4: Click Deploy!
Your bridge will be live at `https://your-domain.com`.

---

## 🔑 Adding Accounts Without Terminal

Once deployed:
1. Open your domain in the browser (e.g. `https://your-domain.com`).
2. Click **`⚡ Connect via FreePi (Auto-Import)`** or simply visit:
   ```
   https://your-domain.com/login
   ```
3. Authorize with GitHub. The bridge will capture your token, read your daily credits, and activate the account in the pool automatically!

---

## 💻 Localhost Setup

Run without Docker:
```bash
git clone https://github.com/Fuad7061/freepi2api.git
cd freepi2api
npm start
```
Open **`http://localhost:8787`** in your browser.

---

## 🔌 Connecting to AI Apps (Cursor, Cline, LibreChat)

Point any OpenAI-compatible client to:
- **Base URL:** `https://your-domain.com/v1` (or `http://localhost:8787/v1`)
- **API Key:** Your configured `BRIDGE_API_KEY` (or any string if unset).
- **Model:** Any model from `/v1/models` (e.g., `particle`, `deepseek-v4.1-flash`, `gpt-6.2-astra`).

### cURL Example
```bash
curl https://your-domain.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model": "particle",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## 📜 License
MIT License. Free and open source for everyone.
