/**
 * 空の色の wasm 実装 — Rust クレート (rust/) の glue を継ぎ目の形に合わせる層。
 *
 * **glue は静的に import する。**`src/wasm/` は生成物だがコミットする方針
 * (Rust 未導入でも dev / test / typecheck / build が通るように)なので、
 * 消えていればビルドが明示的に落ちるのが正しい。
 *
 * 一方このモジュール自体は `sky-backend.ts` から**動的に** import される。
 * その段差があることで、実行時の取得や instantiate の失敗
 * (オフライン、Pages の MIME 設定ミス、プロキシが application/wasm を落とす、
 * 古い端末で wasm が使えない)は白いページではなく
 * 「TypeScript 実装で動く遅いページ」になる。
 */

import type { XYZ } from '../color/index.ts';
import init, { SkyModel } from '../wasm/evitation_sky.js';
import type { SkyConditions } from './sky.ts';
import type { SkyBackend, SkyBackendModel } from './sky-backend.ts';

function wrap(conditions: SkyConditions): SkyBackendModel {
  const model = new SkyModel(
    conditions.sunAltitudeDeg,
    conditions.temperatureK,
    conditions.multipleScattering,
    conditions.aerosolOpticalDepth,
  );

  return {
    // どれも wasm-bindgen が線形メモリから JavaScript 側へコピーした
    // Float64Array を返す。線形メモリへのビューではないので、次の呼び出しで
    // アロケータがメモリを伸ばしても無効にならない。
    xyzMany: (angles) => model.xyzMany(angles),
    xyzAt: (angleDeg) => {
      const flat = model.xyzAt(angleDeg);
      return [flat[0]!, flat[1]!, flat[2]!] as XYZ;
    },
    spectrumTable: (angleDeg) => model.spectrumTable(angleDeg),
    multipleScatteringShare: () => model.multipleScatteringShare(),
    // ハンドルなので、呼ぶ側が描画のたびに解放する必要がある。
    free: () => model.free(),
  };
}

export async function createWasmBackend(): Promise<SkyBackend> {
  await init();
  return { kind: 'wasm', createModel: wrap };
}
