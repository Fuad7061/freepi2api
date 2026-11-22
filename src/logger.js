import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const logDir = path.join(config.dataDir, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const memoryLogs = [];
const MAX_MEMORY_LOGS = 600;

function getTodayLogFileName() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(logDir, `app-${date}.log`);
}

function writeToFile(line) {
  try {
    fs.appendFileSync(getTodayLogFileName(), line + '\n', 'utf8');
  } catch (err) {
    console.error('[Logger] Failed to write log file:', err.message);
  }
}

export function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(logDir);
    const retentionMs = config.logRetentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      if (!file.startsWith('app-') || !file.endsWith('.log')) continue;
      const fullPath = path.join(logDir, file);
      try {
        const stats = fs.statSync(fullPath);
        if (now - stats.mtimeMs > retentionMs) {
          fs.unlinkSync(fullPath);
          deletedCount++;
        }
      } catch (e) {
        // file stat error
      }
    }
    if (deletedCount > 0) {
      log('INFO', `[Storage Cleanup] Deleted ${deletedCount} log file(s) older than ${config.logRetentionDays} days.`);
    }
  } catch (err) {
    console.error('[Logger] Cleanup error:', err.message);
  }
}

// Run cleanup every 4 hours
setInterval(cleanupOldLogs, 4 * 60 * 60 * 1000).unref();
// Run once on load
cleanupOldLogs();

export function log(level, message, meta = null) {
  const timestamp = new Date().toISOString();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp,
    level: level.toUpperCase(),
    message: typeof message === 'string' ? message : JSON.stringify(message),
    meta
  };

  memoryLogs.push(entry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.shift();
  }

  const consoleMsg = `[${timestamp}] [${entry.level}] ${entry.message}${meta ? ' ' + JSON.stringify(meta) : ''}`;
  if (entry.level === 'ERROR') {
    console.error(consoleMsg);
  } else if (entry.level === 'WARN') {
    console.warn(consoleMsg);
  } else {
    console.log(consoleMsg);
  }

  writeToFile(JSON.stringify(entry));
  return entry;
}

export function getLogs(options = {}) {
  const { limit = 200, level, search } = options;
  let results = [...memoryLogs];

  if (level && level !== 'ALL') {
    const lvl = level.toUpperCase();
    results = results.filter(l => l.level === lvl);
  }

  if (search) {
    const s = search.toLowerCase();
    results = results.filter(l => l.message.toLowerCase().includes(s));
  }

  results.reverse();
  return results.slice(0, parseInt(limit, 10));
}

export function clearLogs() {
  memoryLogs.length = 0;
  log('INFO', 'In-memory logs cleared by administrator.');
}

