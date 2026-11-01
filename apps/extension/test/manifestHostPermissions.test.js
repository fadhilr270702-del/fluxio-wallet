// Manifest host_permissions lock (prompt 0219, owner keputusan 3): the
// list is EXACTLY these five entries — a sixth host, a dropped host, or
// a reworded pattern is a conscious decision with its own listing
// round, never a drive-by edit. (The Kyber entry joined in 0219 tahap A
// alongside the Privacy.jsx and permissions-justification updates.)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

describe('manifest.json host_permissions', () => {
  it('is exactly the five approved entries, in order', () => {
    expect(manifest.host_permissions).toEqual([
      'http://127.0.0.1:8899/*',
      'http://127.0.0.1:8545/*',
      'https://lite-api.jup.ag/*',
      'https://aggregator-api.kyberswap.com/*',
      'https://api.coingecko.com/*'
    ]);
  });

  it('permissions stay exactly storage, windows, alarms', () => {
    expect(manifest.permissions).toEqual(['storage', 'windows', 'alarms']);
  });
});
