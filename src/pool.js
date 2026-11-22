import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { log } from './logger.js';

const accountsFilePath = path.join(config.dataDir, 'accounts.json');

class AccountPool {
  constructor() {
    this.accounts = [];
    this.roundRobinIndex = 0;
    this.locks = new Map(); // accountId -> Promise resolving when available
    this.loginSessions = new Map(); // sessionId -> session info
    this.modelsCache = null;
    this.modelsCacheExpires = 0;

    this.load();
    this.importLocalCredentialsIfEmpty();
    this.startAdKeepalive();
    this.startQuotaRefresher();
  }

  load() {
    try {
      if (fs.existsSync(accountsFilePath)) {
        this.accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
      } else {
        this.accounts = [];
      }
    } catch (err) {
      log('ERROR', `Failed to load accounts from ${accountsFilePath}: ${err.message}`);
      this.accounts = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(accountsFilePath, JSON.stringify(this.accounts, null, 2), 'utf8');
      return true;
    } catch (err) {
      log('ERROR', `Failed to save accounts to ${accountsFilePath}: ${err.message}`);
      return false;
    }
  }

  importLocalCredentialsIfEmpty() {
    if (this.accounts.length > 0) return;

    // Check env variable
    if (process.env.FREEPI_TOKEN) {
      log('INFO', 'Found FREEPI_TOKEN in environment. Auto-importing to account pool.');
      this.addAccount({
        name: 'Env Account',
        token: process.env.FREEPI_TOKEN.trim()
      }).catch(() => {});
      return;
    }

    // Check ~/.free-pi/agent/credentials.json
    const credPath = path.join(os.homedir(), '.free-pi', 'agent', 'credentials.json');
    if (fs.existsSync(credPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        if (raw && raw.token) {
          log('INFO', 'Found existing ~/.free-pi credentials. Auto-importing to account pool.');
          this.addAccount({
            name: 'Local GitHub FreePi',
            token: raw.token.trim()
          }).catch(() => {});
        }
      } catch (e) {
        // ignore
      }
    }
  }

  async verifyTokenWithUpstream(token) {
    const url = `${config.freepiBaseUrl}/me`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-client-version': config.clientVersion
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Upstream returned ${res.status}: ${body || res.statusText}`);
    }

    const data = await res.json();
    return {
      tier: data.tier || 'free',
      remainingCredits: data.remaining_credits_today ?? data.remaining_credits ?? null,
      allowanceCredits: data.allowance_credits ?? 500,
      refillAt: data.refill_at ?? data.credits_refill_at ?? null,
      guest: Boolean(data.guest),
      raw: data
    };
  }

  async addAccount({ name, token }) {
    if (!token || typeof token !== 'string') {
      throw new Error('Token is required');
    }
    const cleanToken = token.trim();
    if (this.accounts.some(a => a.token === cleanToken)) {
      throw new Error('An account with this token already exists in the pool');
    }

    let upstreamInfo = {};
    try {
      upstreamInfo = await this.verifyTokenWithUpstream(cleanToken);
    } catch (err) {
      log('WARN', `Account "${name || 'Unnamed'}" token verification warning: ${err.message}`);
    }

    const account = {
      id: `acc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: name && name.trim() ? name.trim() : `Account ${this.accounts.length + 1}`,
      token: cleanToken,
      enabled: true,
      status: 'active',
      tier: upstreamInfo.tier || 'free',
      remainingCredits: upstreamInfo.remainingCredits,
      allowanceCredits: upstreamInfo.allowanceCredits || 500,
      refillAt: upstreamInfo.refillAt,
      totalRequests: 0,
      failedRequests: 0,
      lastUsed: null,
      lastAdImpression: null,
      coolingDownUntil: 0,
      createdAt: new Date().toISOString()
    };

    this.accounts.push(account);
    this.save();
    log('INFO', `Added account "${account.name}" (${account.id}) to pool.`);
    return account;
  }

  deleteAccount(id) {
    const idx = this.accounts.findIndex(a => a.id === id);
    if (idx === -1) throw new Error('Account not found');
    const removed = this.accounts.splice(idx, 1)[0];
    this.save();
    log('INFO', `Deleted account "${removed.name}" (${id}) from pool.`);
    return true;
  }

  toggleAccount(id, enabled) {
    const account = this.accounts.find(a => a.id === id);
    if (!account) throw new Error('Account not found');
    account.enabled = enabled !== undefined ? Boolean(enabled) : !account.enabled;
    this.save();
    log('INFO', `Toggled account "${account.name}" enabled=${account.enabled}`);
    return account;
  }

  async refreshAccount(id) {
    const account = this.accounts.find(a => a.id === id);
    if (!account) throw new Error('Account not found');
    try {
      const info = await this.verifyTokenWithUpstream(account.token);
      account.tier = info.tier;
      account.remainingCredits = info.remainingCredits;
      account.allowanceCredits = info.allowanceCredits;
      account.refillAt = info.refillAt;
      account.status = (account.remainingCredits !== null && account.remainingCredits <= 0) ? 'quota_exhausted' : 'active';
      this.save();
      return account;
    } catch (err) {
      account.status = 'auth_error';
      this.save();
      throw err;
    }
  }

  getAvailableAccounts() {
    const now = Date.now();
    return this.accounts.filter(a => {
      if (!a.enabled) return false;
      if (a.coolingDownUntil && a.coolingDownUntil > now) return false;
      if (a.remainingCredits !== null && a.remainingCredits <= 0) return false;
      return true;
    });
  }

  async acquireAccount() {
    const now = Date.now();
    const available = this.getAvailableAccounts();
    if (available.length === 0) {
      const total = this.accounts.length;
      if (total === 0) {
        throw new Error('No FreePi accounts found in the pool. Please add an account in the Dashboard.');
      }
      throw new Error('All FreePi accounts are currently busy, rate-limited, or out of daily credits.');
    }

    // Round-robin selection
    this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
    const selected = available[this.roundRobinIndex];

    // Wait if account is locked
    let release;
    while (this.locks.has(selected.id)) {
      try {
        await this.locks.get(selected.id);
      } catch (e) {
        // ignore
      }
    }

    let resolver;
    const lockPromise = new Promise(resolve => {
      resolver = resolve;
    });
    this.locks.set(selected.id, lockPromise);

    release = () => {
      this.locks.delete(selected.id);
      resolver();
    };

    selected.lastUsed = new Date().toISOString();
    selected.totalRequests = (selected.totalRequests || 0) + 1;
    this.save();

    return { account: selected, release };
  }

  markRateLimited(accountId, durationSecs = 60) {
    const account = this.accounts.find(a => a.id === accountId);
    if (account) {
      account.coolingDownUntil = Date.now() + (durationSecs * 1000);
      account.status = 'cooling_down';
      account.failedRequests = (account.failedRequests || 0) + 1;
      this.save();
      log('WARN', `Account "${account.name}" hit rate limit. Cooling down for ${durationSecs}s.`);
    }
  }

  markQuotaExhausted(accountId) {
    const account = this.accounts.find(a => a.id === accountId);
    if (account) {
      account.remainingCredits = 0;
      account.status = 'quota_exhausted';
      this.save();
      log('WARN', `Account "${account.name}" ran out of daily credits.`);
    }
  }

  async resetSession(token) {
    try {
      const res = await fetch(`${config.freepiBaseUrl}/session/reset`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-client-version': config.clientVersion
        }
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  async triggerAdImpression(account) {
    if (!account || !account.token) return false;

    // Accounts with tier other than 'free' (e.g. 'established', 'pro', etc.) are exempt from ads
    if (account.tier && account.tier !== 'free') {
      account.lastAdImpression = new Date().toISOString();
      this.save();
      log('INFO', `[Ad Keepalive] Account "${account.name}" tier is "${account.tier}" (ad-exempt) - verified active.`);
      return true;
    }

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const sessionId = `sess_ad_${account.id.replace(/[^a-zA-Z0-9]/g, '')}`;

    const slots = ['banner', 'interstitial', 'text'];
    for (const slot of slots) {
      try {
        const nextRes = await fetch(`${config.freepiBaseUrl}/ads/next?slot=${slot}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${account.token}`,
            'x-client-version': config.clientVersion,
            'x-session-id': sessionId,
            'x-client-os': process.platform,
            'x-client-timezone': tz,
            'x-ad-trigger': 'keepalive'
          }
        });

        if (nextRes.status === 204) {
          continue; // No ad in this slot, try next
        }

        if (!nextRes.ok) continue;

        const adData = await nextRes.json().catch(() => null);
        if (!adData) continue;

        const adId = adData.id || adData.ad_id;
        if (!adId) continue;

        // If gravity impression url is present, fire it
        if (adData.imp_url && typeof adData.imp_url === 'string') {
          fetch(adData.imp_url, { method: 'GET' }).catch(() => {});
        }

        // Post impression to FreePi
        const impRes = await fetch(`${config.freepiBaseUrl}/ads/impression`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${account.token}`,
            'Content-Type': 'application/json',
            'x-client-version': config.clientVersion,
            'x-session-id': sessionId
          },
          body: JSON.stringify({
            ad_id: adId,
            click_token: adData.click_token || '',
            imp_fired: true
          })
        });

        if (impRes.ok || impRes.status === 204) {
          account.lastAdImpression = new Date().toISOString();
          this.save();
          log('INFO', `[Ad Keepalive] Recorded ad impression (slot: ${slot}, ad_id: ${adId}) for "${account.name}"`);
          return true;
        }
      } catch (err) {
        log('WARN', `[Ad Keepalive] Error reporting ad (${slot}) for "${account.name}": ${err.message}`);
      }
    }

    account.lastAdImpression = new Date().toISOString();
    this.save();
    return true;
  }

  startAdKeepalive() {
    if (!config.autoAd) return;
    const intervalMs = Math.max(60, config.adIntervalSecs) * 1000;

    const run = async () => {
      const active = this.accounts.filter(a => a.enabled);
      for (const acc of active) {
        await this.triggerAdImpression(acc);
        await new Promise(r => setTimeout(r, 1500));
      }
    };

    setInterval(run, intervalMs).unref();
    // Run immediately after 1 second on startup
    setTimeout(run, 1000).unref();
  }

  startQuotaRefresher() {
    // Refresh all account quotas every 30 minutes
    const refreshAll = async () => {
      for (const acc of this.accounts) {
        if (!acc.enabled) continue;
        try {
          await this.refreshAccount(acc.id);
        } catch (e) {}
        await new Promise(r => setTimeout(r, 1000));
      }
    };
    setInterval(refreshAll, 30 * 60 * 1000).unref();
    setTimeout(refreshAll, 10000).unref();
  }

  async startBrowserLogin({ label = '' } = {}) {
    const url = `${config.freepiBaseUrl}/auth/connect/start`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signin-exp': '1'
      },
      body: JSON.stringify({
        consent_version: '4',
        client: {
          os: process.platform,
          cli_version: config.clientVersion
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to start FreePi connect session (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const session = {
      sessionId: data.session_id,
      pollSecret: data.poll_secret,
      token: data.token,
      confirmCode: data.confirm_code,
      connectUrl: data.connect_url,
      expiresIn: data.expires_in || 600,
      interval: data.interval || 2,
      label: label && label.trim() ? label.trim() : `FreePi Account ${this.accounts.length + 1}`,
      status: 'pending',
      account: null,
      error: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + ((data.expires_in || 600) * 1000)
    };

    this.loginSessions.set(session.sessionId, session);
    log('INFO', `[Auth] Started FreePi Connect login session (session_id: ${session.sessionId}, code: ${session.confirmCode})`);

    // Start background poller
    this.pollConnectSession(session);

    return {
      sessionId: session.sessionId,
      connectUrl: session.connectUrl,
      confirmCode: session.confirmCode,
      expiresIn: session.expiresIn,
      interval: session.interval
    };
  }

  async pollConnectSession(session) {
    const intervalMs = Math.max(1500, (session.interval || 2) * 1000);
    const poller = async () => {
      if (session.status !== 'pending') return;
      if (Date.now() > session.expiresAt) {
        session.status = 'expired';
        session.error = 'Login session expired. Please try again.';
        log('WARN', `[Auth] Connect session ${session.sessionId} expired.`);
        return;
      }

      try {
        const res = await fetch(`${config.freepiBaseUrl}/auth/connect/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: session.sessionId,
            poll_secret: session.pollSecret
          })
        });

        if (res.ok) {
          const body = await res.json();
          if (body && body.token) {
            log('INFO', `[Auth] Successfully received token for connect session ${session.sessionId}! Importing account...`);
            try {
              const account = await this.addAccount({
                name: session.label,
                token: body.token
              });
              session.status = 'completed';
              session.account = account;
              log('INFO', `[Auth] Account "${account.name}" (${account.id}) imported and ready!`);
              // Trigger initial ad impression immediately so account is warm
              this.triggerAdImpression(account).catch(() => {});
            } catch (err) {
              session.status = 'failed';
              session.error = err.message;
              log('ERROR', `[Auth] Failed to import account after receiving token: ${err.message}`);
            }
            return;
          }
          if (body && body.status === 'pending') {
            // Keep polling
            setTimeout(poller, intervalMs);
            return;
          }
        } else if (res.status === 403 || res.status === 410) {
          session.status = 'denied';
          session.error = 'Login was denied or expired on FreePi.';
          log('WARN', `[Auth] Connect session ${session.sessionId} was denied or expired.`);
          return;
        }
      } catch (err) {
        // network hiccup, retry
      }
      setTimeout(poller, intervalMs);
    };

    setTimeout(poller, intervalMs);
  }

  getLoginSessionStatus(sessionId) {
    const session = this.loginSessions.get(sessionId);
    if (!session) return { status: 'not_found' };
    return {
      status: session.status,
      account: session.account ? {
        id: session.account.id,
        name: session.account.name,
        tier: session.account.tier,
        remainingCredits: session.account.remainingCredits,
        allowanceCredits: session.account.allowanceCredits
      } : null,
      error: session.error
    };
  }

  async getUpstreamModels(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.modelsCache && this.modelsCacheExpires > now) {
      return this.modelsCache;
    }

    // Default known FreePi models list
    const fallbackModelIds = [
      "particle", "deepseek-v4.1-flash", "glm-5.3-flash", "deepseek-v4-flash",
      "abliterated-large-flash", "abliterated-large-v2", "deepseek-v4.1-flash-1017-ultrafast",
      "deepseek-v4.1-flash-abliterated", "deepseek-v4-pro", "gemini-4-carbon",
      "gemini-4-hydrogen", "gemini-4-neon", "gemma-4-uncensored", "glm-4.7-flash-heretic",
      "gpt-6.2-astra", "gpt-oss-20b", "hy4-flash", "inkling-2-mini", "kimi-k3.1-pro",
      "ling-3.0-flash", "ling-3.1-flash", "mimo-v2.6-flash", "qwen3.5-35b-darkbloom",
      "qwen3.6-plus-uncensored", "qwen3.7-flash", "solar-mini-4", "solar-pro-4",
      "uncensored-1.2"
    ];

    const fallbackList = {
      object: "list",
      data: fallbackModelIds.map(id => ({
        id,
        object: "model",
        created: 1795300113,
        owned_by: "freepi"
      }))
    };

    // Find any valid token to query models
    const active = this.accounts.find(a => a.enabled) || this.accounts[0];
    const headers = { 'x-client-version': config.clientVersion };
    if (active && active.token) {
      headers['Authorization'] = `Bearer ${active.token}`;
    }

    try {
      const res = await fetch(`${config.freepiBaseUrl}/v1/models`, {
        method: 'GET',
        headers
      });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.data) && data.data.length > 0) {
          this.modelsCache = data;
          this.modelsCacheExpires = now + (60 * 1000); // 1 minute cache
          return data;
        }
      }
    } catch (e) {
      log('WARN', `Failed to fetch models from upstream: ${e.message}`);
    }

    this.modelsCache = fallbackList;
    return fallbackList;
  }
}

export const pool = new AccountPool();

