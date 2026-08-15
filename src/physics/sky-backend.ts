/**
 * 空の色の計算をどの実装で解くか、という継ぎ目。
 *
 * DOM に依存しない純粋な数値コード。
 *
 * 中身は `sky.ts`(TypeScript)と Rust/wasm の 2 通りある。ページはどちらかを
 * 意識せず、この継ぎ目ごしにモデルを作る。速いのは wasm だが、**TypeScript 実装が
 * 正**であり、wasm はその再現でなければならない — `sky-wasm.test.ts` が両者の
 * 一致を固定している。
 *
 * ## なぜページ側の呼び出しを「まとめて」にするか
 *
 * 帯は 363 方向を描く。方向ごとに境界を跨ぐと、可視域 81 波長のコールバックが
 * 1 描画で約 29,000 回 JS と wasm を往復して、移植の意味がなくなる。だから
 * `xyzMany` で 1 回に、グラフは `spectrumTable` で 1 回にまとめてある。
 */

import type { XYZ } from '../color/index.ts';
import type { SkyConditions } from './sky.ts';
import { tsSkyBackend } from './sky-backend-ts.ts';

export interface SkyBackendModel {
  /**
   * 角度の配列 → 3N の三刺激値(X, Y, Z の順に詰めた平坦な配列)。
   *
   * **wasm の線形メモリへのビューではなく、必ずコピーを返すこと。**アロケータが
   * メモリを伸ばした瞬間にビューは detach され、間欠的で追いにくい不具合になる。
   * 1 描画あたり 8.7KB のコピーは、その危険に見合わない。
   */
  xyzMany(angles: Float64Array): Float64Array;

  /** 単発。帯の標本数が `xyzMany` に渡した角度と一致しないときの取りこぼし用。 */
  xyzAt(angleDeg: number): XYZ;

  /**
   * 380–780nm を 1nm 刻みで並べた 401 点の分光放射輝度。
   *
   * グラフは画素ごとに値を要るので、**関数ではなく表**で渡す。表なら
   * ワーカー境界を転送でき、解放の要るハンドルも増えない。
   */
  spectrumTable(angleDeg: number): Float64Array;

  /** 天頂で、輝度 Y のうち多重散乱が占める割合 (0..1)。単散乱モードでは 0。 */
  multipleScatteringShare(): number;

  /**
   * wasm 側のハンドルを解放する。TypeScript 実装では何もしない。
   *
   * **両方の実装に置いてあるのが要。**呼ぶ側がどちらの実装かで分岐しないので、
   * 解放を書き忘れる経路が構造的に存在しない。
   */
  free(): void;
}

export interface SkyBackend {
  readonly kind: 'ts' | 'wasm';
  createModel(conditions: SkyConditions): SkyBackendModel;
}

/**
 * 既定は TypeScript 実装。
 *
 * wasm が読めたら `initWasmBackend()` が差し替える。読めなくてもページは
 * 遅いだけで動く — フォールバックを残すのが、この継ぎ目を置いた目的のひとつ。
 */
let current: SkyBackend = tsSkyBackend;

export function backend(): SkyBackend {
  return current;
}

let initPromise: Promise<boolean> | null = null;

/**
 * wasm 実装を読み込んで差し替える。成功したら true。何度呼んでも 1 回しか走らない。
 *
 * **静的 import ではなく動的 import で到達する。**`sky-backend-wasm.ts` の側は
 * glue を静的に import しているので、`src/wasm/` が消えていればビルドが明示的に
 * 落ちる(生成物はコミットされている前提なので、それが正しい)。一方この動的な
 * 段差があることで、実行時の失敗は白いページではなく「TypeScript 実装で動く
 * 遅いページ」になる。
 *
 * 差し替えたあとも、それ以前に作ったモデルは有効なまま(モデルは自分を作った
 * 実装に紐づく)。ページは描画ごとに作り直すので、次の描画から乗り換わる。
 */
export function initWasmBackend(): Promise<boolean> {
  initPromise ??= (async (): Promise<boolean> => {
    try {
      const module = await import('./sky-backend-wasm.ts');
      current = await module.createWasmBackend();
      return true;
    } catch (error) {
      console.warn('wasm を読めなかったので TypeScript 実装で描画します', error);
      return false;
    }
  })();
  return initPromise;
}
