import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { log, getLogs, clearLogs } from './logger.js';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const serverStartTime = Date.now();
let totalChatRequests = 0;
let totalChatSuccess = 0;
let totalChatErrors = 0;

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key, x-session-id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(payload);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(text);
}

async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON format: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

function verifyBridgeAuth(req) {
  if (!config.bridgeApiKey) return true;
  const auth = req.headers['authorization'] || '';
  const xKey = req.headers['x-api-key'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
  return bearer === config.bridgeApiKey || xKey === config.bridgeApiKey;
}

function verifyAdminAuth(req) {
  if (!config.adminPassword) return true;
  const auth = req.headers['authorization'] || '';
  const xAdmin = req.headers['x-admin-password'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
  return bearer === config.adminPassword || xAdmin === config.adminPassword;
}

// Transform Anthropic messages format to OpenAI format
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      messages.push({ role: 'system', content: body.system.map(s => s.text || '').join('\n') });
    }
  }

  for (const m of (body.messages || [])) {
    let content = m.content;
    if (Array.isArray(m.content)) {
      content = m.content.map(c => c.text || '').join('\n');
    }
    messages.push({ role: m.role, content });
  }

  return {
    model: body.model || 'particle',
    messages,
    stream: Boolean(body.stream),
    temperature: body.temperature,
    max_tokens: body.max_tokens
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key, x-admin-password, x-session-id',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  try {
    // -------------------------------------------------------------
    // Static Dashboard UI & Direct Login Link
    // -------------------------------------------------------------
    if ((method === 'GET' || method === 'HEAD') && (pathname === '/' || pathname === '/dashboard')) {
      const htmlFile = path.join(publicDir, 'index.html');
      if (fs.existsSync(htmlFile)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (method === 'HEAD') return res.end();
        fs.createReadStream(htmlFile).pipe(res);
        return;
      }
    }

    if ((method === 'GET' || method === 'HEAD') && pathname === '/login') {
      const label = url.searchParams.get('label') || '';
      try {
        const session = await pool.startBrowserLogin({ label });
        res.writeHead(302, {
          'Location': session.connectUrl,
          'Content-Type': 'text/html; charset=utf-8'
        });
        return res.end(`<!doctype html><p>Redirecting to FreePi login... <a href="${session.connectUrl}">Click here if not redirected</a>.</p>`);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // -------------------------------------------------------------
    // Health & Info
    // -------------------------------------------------------------
    if ((method === 'GET' || method === 'HEAD') && (pathname === '/health' || pathname === '/healthz')) {
      const activeCount = pool.getAvailableAccounts().length;
      if (method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end();
      }
      return sendJson(res, 200, {
        ok: true,
        status: 'healthy',
        version: '1.0.0',
        totalAccounts: pool.accounts.length,
        activeAccounts: activeCount,
        uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000)
      });
    }

    // -------------------------------------------------------------
    // Dashboard Admin APIs
    // -------------------------------------------------------------
    if (pathname.startsWith('/api/')) {
      // Public check whether admin password is required
      if (method === 'GET' && pathname === '/api/auth/admin-check') {
        return sendJson(res, 200, {
          required: Boolean(config.adminPassword),
          hasBridgeKey: Boolean(config.bridgeApiKey)
        });
      }

      // Public verification of admin password
      if (method === 'POST' && pathname === '/api/auth/verify-admin') {
        const body = await parseJsonBody(req);
        const inputKey = body.password ? String(body.password).trim() : '';
        if (!config.adminPassword || inputKey === config.adminPassword) {
          return sendJson(res, 200, { valid: true });
        }
        return sendJson(res, 401, { valid: false, error: 'Invalid Admin Dashboard Key' });
      }

      // Require admin password for all other /api/ endpoints
      if (!verifyAdminAuth(req)) {
        return sendJson(res, 401, { error: 'Unauthorized: Invalid Admin Password' });
      }

      // GET /api/status
      if (method === 'GET' && pathname === '/api/status') {
        const available = pool.getAvailableAccounts();
        return sendJson(res, 200, {
          uptime: Math.floor((Date.now() - serverStartTime) / 1000),
          totalAccounts: pool.accounts.length,
          activeAccounts: available.length,
          totalChatRequests,
          totalChatSuccess,
          totalChatErrors,
          config: {
            port: config.port,
            host: config.host,
            autoAd: config.autoAd,
            hasBridgeKey: Boolean(config.bridgeApiKey),
            hasAdminPassword: Boolean(config.adminPassword),
            freepiBaseUrl: config.freepiBaseUrl,
            logRetentionDays: config.logRetentionDays
          }
        });
      }

      // POST /api/auth/connect/start (One-Click OAuth login)
      if (method === 'POST' && pathname === '/api/auth/connect/start') {
        const body = await parseJsonBody(req);
        try {
          const session = await pool.startBrowserLogin({ label: body.label || '' });
          return sendJson(res, 200, { success: true, ...session });
        } catch (err) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      // GET /api/auth/connect/status (Poll login status)
      if (method === 'GET' && pathname === '/api/auth/connect/status') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) return sendJson(res, 400, { error: 'sessionId query parameter is required' });
        const status = pool.getLoginSessionStatus(sessionId);
        return sendJson(res, 200, status);
      }

      // GET /api/accounts
      if (method === 'GET' && pathname === '/api/accounts') {
        const masked = pool.accounts.map(a => ({
          ...a,
          tokenMasked: a.token ? `${a.token.slice(0, 10)}...${a.token.slice(-6)}` : ''
        }));
        return sendJson(res, 200, { accounts: masked });
      }

      // POST /api/accounts
      if (method === 'POST' && pathname === '/api/accounts') {
        const body = await parseJsonBody(req);
        try {
          const account = await pool.addAccount(body);
          return sendJson(res, 201, { success: true, account });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      // DELETE /api/accounts/:id
      if (method === 'DELETE' && pathname.startsWith('/api/accounts/')) {
        const id = pathname.replace('/api/accounts/', '');
        try {
          pool.deleteAccount(id);
          return sendJson(res, 200, { success: true });
        } catch (err) {
          return sendJson(res, 404, { error: err.message });
        }
      }

      // POST /api/accounts/:id/toggle
      if (method === 'POST' && pathname.endsWith('/toggle')) {
        const id = pathname.replace('/api/accounts/', '').replace('/toggle', '');
        const body = await parseJsonBody(req);
        try {
          const acc = pool.toggleAccount(id, body.enabled);
          return sendJson(res, 200, { success: true, account: acc });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      // POST /api/accounts/:id/refresh
      if (method === 'POST' && pathname.endsWith('/refresh')) {
        const id = pathname.replace('/api/accounts/', '').replace('/refresh', '');
        try {
          const acc = await pool.refreshAccount(id);
          return sendJson(res, 200, { success: true, account: acc });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      // POST /api/accounts/:id/ad-impression
      if (method === 'POST' && pathname.endsWith('/ad-impression')) {
        const id = pathname.replace('/api/accounts/', '').replace('/ad-impression', '');
        const acc = pool.accounts.find(a => a.id === id);
        if (!acc) return sendJson(res, 404, { error: 'Account not found' });
        const ok = await pool.triggerAdImpression(acc);
        return sendJson(res, 200, { success: ok, account: acc });
      }

      // POST /api/accounts/:id/reset-session
      if (method === 'POST' && pathname.endsWith('/reset-session')) {
        const id = pathname.replace('/api/accounts/', '').replace('/reset-session', '');
        const acc = pool.accounts.find(a => a.id === id);
        if (!acc) return sendJson(res, 404, { error: 'Account not found' });
        const ok = await pool.resetSession(acc.token);
        log('INFO', `Manual session reset requested for "${acc.name}": result=${ok}`);
        return sendJson(res, 200, { success: ok });
      }

      // GET /api/logs
      if (method === 'GET' && pathname === '/api/logs') {
        const level = url.searchParams.get('level') || 'ALL';
        const search = url.searchParams.get('search') || '';
        const limit = url.searchParams.get('limit') || 200;
        const logs = getLogs({ level, search, limit });
        return sendJson(res, 200, { logs, retentionDays: config.logRetentionDays });
      }

      // POST /api/logs/clear
      if (method === 'POST' && pathname === '/api/logs/clear') {
        clearLogs();
        return sendJson(res, 200, { success: true });
      }

      // GET /api/models
      if (method === 'GET' && pathname === '/api/models') {
        const force = url.searchParams.get('refresh') === '1';
        const models = await pool.getUpstreamModels(force);
        return sendJson(res, 200, models);
      }

      // GET /api/config
      if (method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, {
          bridgeApiKey: config.bridgeApiKey,
          hasAdminPassword: Boolean(config.adminPassword),
          autoAd: config.autoAd,
          adIntervalSecs: config.adIntervalSecs,
          logRetentionDays: config.logRetentionDays
        });
      }

      // POST /api/config
      if (method === 'POST' && pathname === '/api/config') {
        const body = await parseJsonBody(req);
        config.save(body);
        log('INFO', 'System settings (Keys / Retention) updated via Dashboard UI');
        return sendJson(res, 200, {
          success: true,
          config: {
            bridgeApiKey: config.bridgeApiKey,
            hasAdminPassword: Boolean(config.adminPassword),
            autoAd: config.autoAd,
            adIntervalSecs: config.adIntervalSecs,
            logRetentionDays: config.logRetentionDays
          }
        });
      }
    }

    // -------------------------------------------------------------
    // OpenAI / Anthropic Public Gateway
    // -------------------------------------------------------------

    // GET /v1/models
    if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      if (!verifyBridgeAuth(req)) {
        return sendJson(res, 401, { error: { message: 'Invalid bridge API key', type: 'auth_error' } });
      }
      const models = await pool.getUpstreamModels();
      return sendJson(res, 200, models);
    }

    // POST /v1/chat/completions (OpenAI) & POST /v1/messages (Anthropic)
    const isOpenAIChat = method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions');
    const isAnthropicMessages = method === 'POST' && (pathname === '/v1/messages' || pathname === '/messages');

    if (isOpenAIChat || isAnthropicMessages) {
      if (!verifyBridgeAuth(req)) {
        return sendJson(res, 401, { error: { message: 'Invalid bridge API key', type: 'auth_error' } });
      }

      let body = await parseJsonBody(req);
      if (isAnthropicMessages) {
        body = anthropicToOpenAI(body);
      }

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return sendJson(res, 400, { error: { message: 'messages[] is required', type: 'invalid_request' } });
      }

      totalChatRequests++;
      const isStream = Boolean(body.stream);
      let attempts = 0;
      const maxAttempts = Math.min(3, Math.max(1, pool.accounts.length));
      let lastError = null;

      while (attempts < maxAttempts) {
        attempts++;
        let acquired;
        try {
          acquired = await pool.acquireAccount();
        } catch (err) {
          totalChatErrors++;
          return sendJson(res, 503, {
            error: { message: err.message, type: 'pool_exhausted' }
          });
        }

        const { account, release } = acquired;

        try {
          log('INFO', `[Chat] Forwarding request (model=${body.model}, stream=${isStream}) using account "${account.name}" (attempt ${attempts})`);

          const upstreamRes = await fetch(`${config.freepiBaseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${account.token}`,
              'Content-Type': 'application/json',
              'x-client-version': config.clientVersion,
              'x-session-id': req.headers['x-session-id'] || `sess_${Date.now()}`
            },
            body: JSON.stringify(body)
          });

          // Check if rate limited (429)
          if (upstreamRes.status === 429) {
            release();
            pool.markRateLimited(account.id, 60);
            log('WARN', `Account "${account.name}" returned 429 Rate Limit. Rotating to next account.`);
            continue;
          }

          // Check if ad required (403)
          if (upstreamRes.status === 403) {
            const errText = await upstreamRes.text().catch(() => '');
            if (errText.includes('ads_required')) {
              log('WARN', `Account "${account.name}" returned ads_required. Triggering immediate ad impression.`);
              await pool.triggerAdImpression(account);
              // Retry with same account once
              const retryRes = await fetch(`${config.freepiBaseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${account.token}`,
                  'Content-Type': 'application/json',
                  'x-client-version': config.clientVersion
                },
                body: JSON.stringify(body)
              });
              if (retryRes.ok) {
                totalChatSuccess++;
                return handleStreamOrJson(retryRes, res, isStream, release);
              }
            }
            release();
            continue;
          }

          // Check if concurrent session (409)
          if (upstreamRes.status === 409) {
            log('WARN', `Account "${account.name}" returned 409 Concurrent Session. Resetting session.`);
            await pool.resetSession(account.token);
            release();
            continue;
          }

          if (!upstreamRes.ok) {
            const errBody = await upstreamRes.json().catch(() => ({}));
            release();
            totalChatErrors++;
            return sendJson(res, upstreamRes.status, errBody);
          }

          totalChatSuccess++;
          return handleStreamOrJson(upstreamRes, res, isStream, release);

        } catch (err) {
          release();
          lastError = err;
          log('ERROR', `Chat dispatch error on account "${account.name}": ${err.message}`);
        }
      }

      totalChatErrors++;
      return sendJson(res, 502, {
        error: {
          message: `All retry attempts failed across account pool: ${lastError ? lastError.message : 'Unknown error'}`,
          type: 'upstream_error'
        }
      });
    }

    // 404
    return sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });

  } catch (globalErr) {
    log('ERROR', `Unhandled server error: ${globalErr.message}`);
    if (!res.headersSent) {
      return sendJson(res, 500, { error: globalErr.message });
    }
  }
});

function handleStreamOrJson(upstreamRes, clientRes, isStream, release) {
  if (isStream && upstreamRes.body) {
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const stream = Readable.fromWeb(upstreamRes.body);
    let released = false;
    const finish = () => {
      if (!released) {
        released = true;
        release();
      }
    };

    stream.on('end', finish);
    stream.on('error', finish);
    clientRes.on('close', () => {
      finish();
      stream.destroy();
    });

    stream.pipe(clientRes);
  } else {
    upstreamRes.text().then(text => {
      release();
      clientRes.writeHead(upstreamRes.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      clientRes.end(text);
    }).catch(err => {
      release();
      clientRes.writeHead(500, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: err.message }));
    });
  }
}

server.listen(config.port, config.host, () => {
  log('INFO', `==========================================================`);
  log('INFO', ` FreePi Bridge & Management Dashboard is running!`);
  log('INFO', ` - Web Dashboard:  http://localhost:${config.port}`);
  log('INFO', ` - OpenAI API:     http://localhost:${config.port}/v1`);
  log('INFO', ` - Upstream:       ${config.freepiBaseUrl}`);
  log('INFO', ` - Accounts in pool: ${pool.accounts.length}`);
  log('INFO', ` - Log Retention:  ${config.logRetentionDays} days (auto-cleaned)`);
  log('INFO', `==========================================================`);
});
