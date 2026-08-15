/**
 * 空の色の TypeScript 実装 — `sky.ts` を継ぎ目の形に合わせるだけの薄い層。
 *
 * DOM に依存しない純粋な数値コード。
 *
 * **こちらが正。**wasm 実装はこの再現でなければならず、`sky-wasm.test.ts` が
 * 両者の一致を固定している。wasm が読めない環境ではそのままフォールバックとして
 * 使われるので、遅いだけで正しく動く。
 */

import type { XYZ } from '../color/index.ts';
import {
  createSkyModel,
  SPECTRUM_TABLE_LAMBDA_MIN,
  SPECTRUM_TABLE_LENGTH,
  type SkyConditions,
} from './sky.ts';
// 型だけを取る。値を取ると sky-backend.ts と実行時の循環になる
// (あちらは既定の実装としてこのモジュールを読む)。
import type { SkyBackend, SkyBackendModel } from './sky-backend.ts';

function createTsModel(conditions: SkyConditions): SkyBackendModel {
  const model = createSkyModel(conditions);

  return {
    xyzMany(angles: Float64Array): Float64Array {
      const out = new Float64Array(angles.length * 3);
      for (let i = 0; i < angles.length; i += 1) {
        const xyz = model.xyzAt(angles[i]!);
        out[i * 3] = xyz[0];
        out[i * 3 + 1] = xyz[1];
        out[i * 3 + 2] = xyz[2];
      }
      return out;
    },

    xyzAt(angleDeg: number): XYZ {
      return model.xyzAt(angleDeg);
    },

    spectrumTable(angleDeg: number): Float64Array {
      // 球殻の行進は samplerFor の中で 1 度だけ。以降は波長を舐めるだけ。
      const sample = model.samplerFor(angleDeg);
      const out = new Float64Array(SPECTRUM_TABLE_LENGTH);
      for (let i = 0; i < out.length; i += 1) {
        out[i] = sample(SPECTRUM_TABLE_LAMBDA_MIN + i);
      }
      return out;
    },

    multipleScatteringShare(): number {
      return model.multipleScatteringShare();
    },

    // TypeScript 実装に解放するものはない。継ぎ目の形を揃えるためだけに置く。
    free(): void {},
  };
}

export const tsSkyBackend: SkyBackend = {
  kind: 'ts',
  createModel: createTsModel,
};
