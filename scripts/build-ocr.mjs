import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'autoclick/offscreen/ocr-entry.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110'],
  loader: { '.wasm': 'dataurl' },
  alias: {
    path: path.join(root, 'scripts/stubs/path.js'),
    fs: path.join(root, 'scripts/stubs/fs.js'),
    crypto: path.join(root, 'scripts/stubs/crypto.js')
  },
  outfile: path.join(root, 'autoclick/offscreen/ocr-lib.js'),
  logLevel: 'warning'
});
console.log('ocr-lib.js built OK');