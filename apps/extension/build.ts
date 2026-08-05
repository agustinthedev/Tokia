import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname);
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await Promise.all([
  build({ entryPoints: [path.join(root, 'src/content.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: path.join(out, 'content.js'), sourcemap: true }),
  build({ entryPoints: [path.join(root, 'src/popup.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: path.join(out, 'popup.js'), sourcemap: true }),
  build({ entryPoints: [path.join(root, 'src/options.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: path.join(out, 'options.js'), sourcemap: true })
]);
for (const file of ['manifest.json', 'popup.html', 'options.html', 'popup.css']) fs.copyFileSync(path.join(root, file), path.join(out, file));
console.log(`Extension built at ${out}`);
