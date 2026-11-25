// src/launch.mjs
// Entry point for the .bat double-click launcher. Starts the HTTP console
// and opens the default browser to it. Kept dependency-free: uses the OS
// `start`/`open`/`xdg-open` command via child_process, never a browser lib.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dataDir = process.env.CLAIM_MEMORY_DATA_DIR || path.join(__dirname, '..', 'data');
  const port = Number(process.env.CLAIM_MEMORY_PORT || 3457);
  const host = '127.0.0.1';

  const server = await startServer({ dataDir, port, host });
  const url = `http://${host}:${port}`;
  console.log(`[agent-claim-memory] console listening at ${url}`);
  console.log(`[agent-claim-memory] data dir: ${dataDir}`);

  openBrowser(url);

  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (err) {
    console.warn(`[agent-claim-memory] could not auto-open browser: ${err.message}`);
    console.warn(`[agent-claim-memory] open manually: ${url}`);
  }
}

main().catch((err) => {
  console.error('[agent-claim-memory] failed to start:', err);
  process.exit(1);
});
