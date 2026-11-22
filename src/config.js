import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DATA_DIR = process.env.DATA_DIR || path.join(rootDir, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const configFilePath = path.join(DATA_DIR, 'config.json');

let storedConfig = {};
try {
  if (fs.existsSync(configFilePath)) {
    storedConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
  }
} catch (e) {
  console.error('[Config] Failed to read stored config:', e.message);
}

export const config = {
  host: process.env.HOST || storedConfig.host || '0.0.0.0',
  port: parseInt(process.env.PORT || storedConfig.port || '8787', 10),
  freepiBaseUrl: (process.env.FREEPI_BASE_URL || storedConfig.freepiBaseUrl || 'https://api.freepi.ai').replace(/\/+$/, ''),
  bridgeApiKey: storedConfig.bridgeApiKey !== undefined ? storedConfig.bridgeApiKey : (process.env.BRIDGE_API_KEY || ''),
  adminPassword: storedConfig.adminPassword !== undefined ? storedConfig.adminPassword : (process.env.ADMIN_PASSWORD || ''),
  autoAd: process.env.AUTO_AD !== undefined ? (process.env.AUTO_AD === '1' || process.env.AUTO_AD === 'true') : (storedConfig.autoAd ?? true),
  adIntervalSecs: parseInt(process.env.AD_INTERVAL_SECS || storedConfig.adIntervalSecs || '300', 10),
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || storedConfig.logRetentionDays || '10', 10),
  clientVersion: process.env.FREEPI_CLIENT_VERSION || storedConfig.clientVersion || '0.6.25',
  dataDir: DATA_DIR,
  configFilePath,

  save(newValues = {}) {
    if (newValues.host !== undefined) this.host = newValues.host;
    if (newValues.port !== undefined) this.port = parseInt(newValues.port, 10);
    if (newValues.freepiBaseUrl !== undefined) this.freepiBaseUrl = newValues.freepiBaseUrl.replace(/\/+$/, '');
    if (newValues.bridgeApiKey !== undefined) this.bridgeApiKey = String(newValues.bridgeApiKey).trim();
    if (newValues.adminPassword !== undefined) this.adminPassword = String(newValues.adminPassword).trim();
    if (newValues.autoAd !== undefined) this.autoAd = Boolean(newValues.autoAd);
    if (newValues.adIntervalSecs !== undefined) this.adIntervalSecs = parseInt(newValues.adIntervalSecs, 10) || 300;
    if (newValues.logRetentionDays !== undefined) this.logRetentionDays = parseInt(newValues.logRetentionDays, 10) || 10;

    try {
      const toPersist = {
        host: this.host,
        port: this.port,
        freepiBaseUrl: this.freepiBaseUrl,
        bridgeApiKey: this.bridgeApiKey,
        adminPassword: this.adminPassword,
        autoAd: this.autoAd,
        adIntervalSecs: this.adIntervalSecs,
        logRetentionDays: this.logRetentionDays,
        clientVersion: this.clientVersion
      };
      fs.writeFileSync(configFilePath, JSON.stringify(toPersist, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[Config] Failed to save config:', err.message);
      return false;
    }
  }
};

