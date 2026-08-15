/**
 * wasm-pack の出力先 (src/wasm/) を、コミットできる状態に整える。
 *
 * `npm run build:wasm` が wasm-pack のあとに呼ぶ。
 *
 * ## なぜ .gitignore を消すのか
 *
 * wasm-pack は出力先に `*` だけを書いた `.gitignore` を置く。この生成物は
 * cie1931-data.ts と同じく **コミットする**方針(Rust 未導入でも dev / test /
 * typecheck / build が通るようにするため)なので、それが残っていると
 * src/wasm/ が丸ごと git から外れる。しかも失敗の出方が
 * 「CI は通るのに、他人のチェックアウトに src/wasm/ が無くてビルドが落ちる」
 * という遠いところに出るので、ここで機械的に消しておく。
 */

import { access, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUT_DIR = new URL('../src/wasm/', import.meta.url);

/** これが揃っていなければビルドは失敗とみなす。 */
const REQUIRED = ['evitation_sky.js', 'evitation_sky.d.ts', 'evitation_sky_bg.wasm'];

const gitignore = fileURLToPath(new URL('.gitignore', OUT_DIR));
await rm(gitignore, { force: true });

const missing = [];
for (const name of REQUIRED) {
  try {
    await access(fileURLToPath(new URL(name, OUT_DIR)));
  } catch {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error(`src/wasm/ に次のファイルがありません: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`src/wasm/ を整えました (${REQUIRED.length} ファイルを確認)`);
