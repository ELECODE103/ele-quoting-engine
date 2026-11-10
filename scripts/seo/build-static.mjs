#!/usr/bin/env node
/**
 * Runs after `vite build` (see client/package.json): builds the server entry
 * and prerenders every public route. See prerender.mjs for what is produced.
 *
 * A failure here must not take the quoting app down with it, so by default it
 * is reported loudly and the build continues: Express then serves the plain
 * client-rendered shell exactly as it did before this step existed. Set
 * SEO_STRICT=1 (CI, or once the step has proven itself on Railway) to make a
 * prerender failure fail the build instead.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT = path.join(ROOT, 'client');
const strict = process.env.SEO_STRICT === '1';

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
  return r.status === 0;
}

const vite = path.join(CLIENT, 'node_modules', 'vite', 'bin', 'vite.js');
fs.rmSync(path.join(CLIENT, 'dist-ssr'), { recursive: true, force: true });

const ok =
  run(process.execPath, [vite, 'build', '--ssr', 'src/entry-server.jsx', '--outDir', 'dist-ssr', '--logLevel', 'warn'], CLIENT) &&
  run(process.execPath, [path.join(ROOT, 'scripts', 'seo', 'prerender.mjs'), ...(strict ? ['--strict'] : [])], ROOT);

if (!ok) {
  console.error('\n==================================================================');
  console.error(' SEO PRERENDER FAILED - the site will deploy as a client-rendered');
  console.error(' SPA without per-route HTML. Fix the error above and redeploy.');
  console.error('==================================================================\n');
  // A half-written manifest would make Express 404 real pages; remove it.
  fs.rmSync(path.join(CLIENT, 'dist', 'seo-manifest.json'), { force: true });
  fs.rmSync(path.join(CLIENT, 'dist', '_prerender'), { recursive: true, force: true });
  process.exit(strict ? 1 : 0);
}
