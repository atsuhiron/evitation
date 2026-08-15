/**
 * wasm 実装が TypeScript 実装と一致することを固定する。
 *
 * **この 1 本がこの移植の安全網。**Rust 側にも `cargo test` で不変量を移してあるが、
 * それは「Rust が物理として正しい」ことしか言わない。「TypeScript と同じ答えを出す」
 * ことを言えるのはここだけで、CI では毎回 wasm をビルドし直してからこれを走らせる
 * (コミット済みの生成物が古くなっていても、意味的なずれはここで落ちる)。
 *
 * `src/wasm/` が無ければ丸ごとスキップする。Rust 未導入のクローンで
 * `npm test` が落ちないようにするため。
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { xyzToColor, type XYZ } from '../color/index.ts';
import { tsSkyBackend } from './sky-backend-ts.ts';
import { SPECTRUM_TABLE_LENGTH, sunSkyAngleDeg, type SkyConditions } from './sky.ts';
import type { SkyBackendModel } from './sky-backend.ts';

const wasmPath = fileURLToPath(new URL('../wasm/evitation_sky_bg.wasm', import.meta.url));
const available = existsSync(wasmPath);

/**
 * 相対 1e-9(絶対の下限つき)。
 *
 * 同じ演算を同じ順序で f64 で回しているので、ずれるのは Rust の libm と V8 の
 * `exp`/`sin`/`cos`/`expm1` が高々 1ulp 違う分だけ。標本 ≤96 と波長 81 点に
 * 積み上げても相対 1e-13 程度に収まる。絶対の下限が要るのは、薄明で X と Z が
 * 0 に落ちるため。
 */
const RELATIVE_TOLERANCE = 1e-9;
const ABSOLUTE_FLOOR = 1e-15;

function expectClose(actual: number, expected: number, label: string): void {
  const limit = RELATIVE_TOLERANCE * Math.max(Math.abs(actual), Math.abs(expected)) + ABSOLUTE_FLOOR;
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    limit,
  );
}

describe.skipIf(!available)('wasm 実装は TypeScript 実装と一致する', () => {
  let createWasmModel: (conditions: SkyConditions) => SkyBackendModel;

  beforeAll(async () => {
    // `--target web` の glue でも、BufferSource を渡せば `WebAssembly.instantiate`
    // に直行する(fetch も instantiateStreaming も document も通らない)ので、
    // node 環境のまま初期化できる。`--target nodejs` の 2 つ目のビルドは要らない。
    const glue = await import('../wasm/evitation_sky.js');
    await glue.default({ module_or_path: await readFile(wasmPath) });

    createWasmModel = (conditions) => {
      const model = new glue.SkyModel(
        conditions.sunAltitudeDeg,
        conditions.temperatureK,
        conditions.multipleScattering,
        conditions.aerosolOpticalDepth,
      );
      return {
        xyzMany: (angles) => model.xyzMany(angles),
        xyzAt: (angle) => {
          const flat = model.xyzAt(angle);
          return [flat[0]!, flat[1]!, flat[2]!] as XYZ;
        },
        spectrumTable: (angle) => model.spectrumTable(angle),
        multipleScatteringShare: () => model.multipleScatteringShare(),
        free: () => model.free(),
      };
    };
  });

  /**
   * 太陽高度。**ちょうど 0 を必ず含める** — `sin(h·DEG)` で μ₀ を作っている
   * 早期リターンが「厳密に 0」に懸かっているので、その両側も踏む。
   */
  const ALTITUDES = [-12, -6, -2, -0.5, 0, 0.1, 1, 5, 15, 30, 45, 60, 89.9, 90];
  /** 0 は短絡経路(Henyey–Greenstein が一度も走らない)、0.5 は UI の上限。 */
  const AEROSOLS = [0, 0.01, 0.1, 0.5];
  /** ±90 が重要 — 光路積分の括り出し順と地球の影が効く場所。 */
  const ANGLES = [-90, -89.9, -60, -30, -1, -0.5, 0, 0.5, 1, 30, 60, 89.9, 90];

  function anglesFor(sunAltitudeDeg: number): Float64Array {
    const sunAngle = Math.min(sunSkyAngleDeg(sunAltitudeDeg), 90);
    return Float64Array.from([...ANGLES, sunAngle, -sunAngle]);
  }

  /** 1 つの状態について、両実装を突き合わせる。 */
  function compare(conditions: SkyConditions): void {
    const label =
      `h=${conditions.sunAltitudeDeg} T=${conditions.temperatureK} ` +
      `ms=${conditions.multipleScattering} aod=${conditions.aerosolOpticalDepth}`;

    const ts = tsSkyBackend.createModel(conditions);
    const wasm = createWasmModel(conditions);
    try {
      const angles = anglesFor(conditions.sunAltitudeDeg);
      const tsFlat = ts.xyzMany(angles);
      const wasmFlat = wasm.xyzMany(angles);

      expect(wasmFlat.length, `${label}: 長さ`).toBe(tsFlat.length);

      // (2) 数値の一致。
      for (let i = 0; i < angles.length; i += 1) {
        for (let k = 0; k < 3; k += 1) {
          expectClose(
            wasmFlat[i * 3 + k]!,
            tsFlat[i * 3 + k]!,
            `${label} a=${angles[i]} XYZ[${k}]`,
          );
        }
      }

      // (1) 8bit の一致。ユーザーが実際に見る性質そのものなので、ε より意味がある。
      // スケールは TypeScript 側から決めて両方に同じものを掛ける。
      let peak = 0;
      for (let i = 0; i < angles.length; i += 1) {
        const { linearRGB } = xyzToColor(
          [tsFlat[i * 3]!, tsFlat[i * 3 + 1]!, tsFlat[i * 3 + 2]!],
          'luminance',
        );
        peak = Math.max(peak, linearRGB[0], linearRGB[1], linearRGB[2]);
      }
      const scale = peak > 0 ? 1 / peak : 1;

      for (let i = 0; i < angles.length; i += 1) {
        const hex = (flat: Float64Array): string =>
          xyzToColor(
            [flat[i * 3]! * scale, flat[i * 3 + 1]! * scale, flat[i * 3 + 2]! * scale],
            'luminance',
          ).hex;
        expect(hex(wasmFlat), `${label} a=${angles[i]}`).toBe(hex(tsFlat));
      }

      // (3) 構造。まとめた経路が単発と一致すること。
      for (const angle of [0, 45, -45]) {
        const single = wasm.xyzAt(angle);
        const reference = ts.xyzAt(angle);
        for (let k = 0; k < 3; k += 1) {
          expectClose(single[k]!, reference[k]!, `${label} 単発 a=${angle} [${k}]`);
        }
      }

      expectClose(
        wasm.multipleScatteringShare(),
        ts.multipleScatteringShare(),
        `${label} 多重散乱の寄与`,
      );
    } finally {
      wasm.free();
      ts.free();
    }
  }

  it('太陽高度・エアロゾル量・散乱の次数を振っても一致する', () => {
    for (const sunAltitudeDeg of ALTITUDES) {
      for (const aerosolOpticalDepth of AEROSOLS) {
        for (const multipleScattering of [false, true]) {
          compare({
            sunAltitudeDeg,
            temperatureK: 5778,
            multipleScattering,
            aerosolOpticalDepth,
          });
        }
      }
    }
  });

  it('太陽の温度を振っても一致する', () => {
    for (const temperatureK of [2000, 3000, 5778, 12000, 20000]) {
      compare({
        sunAltitudeDeg: 20,
        temperatureK,
        multipleScattering: true,
        aerosolOpticalDepth: 0.1,
      });
    }
  });

  /** グラフが読む 401 点の表も、端から端まで一致すること。 */
  it('分光の表が一致する', () => {
    const conditions: SkyConditions = {
      sunAltitudeDeg: 10,
      temperatureK: 5778,
      multipleScattering: true,
      aerosolOpticalDepth: 0.1,
    };
    const ts = tsSkyBackend.createModel(conditions);
    const wasm = createWasmModel(conditions);
    try {
      for (const angle of [-90, -30, 0, 30, 80, 90]) {
        const tsTable = ts.spectrumTable(angle);
        const wasmTable = wasm.spectrumTable(angle);
        expect(wasmTable.length).toBe(SPECTRUM_TABLE_LENGTH);
        expect(wasmTable.length).toBe(tsTable.length);
        for (let i = 0; i < tsTable.length; i += 1) {
          expectClose(wasmTable[i]!, tsTable[i]!, `a=${angle} λ=${380 + i}nm`);
        }
      }
    } finally {
      wasm.free();
      ts.free();
    }
  });
});
