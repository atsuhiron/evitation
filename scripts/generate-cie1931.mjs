/**
 * src/color/cie1931-data.ts と rust/src/cie1931_data.rs を生成する。
 *
 * CIE 1931 2° 標準観測者の等色関数を colour-science のデータセットから取り出し、
 * TypeScript と Rust のテーブルとして書き出す。生成物はコミットするので、
 * 通常の開発でこのスクリプトを走らせる必要はない
 * (データを更新したい / 出所を検算したいときだけ)。
 *
 * **2 つの出力は同じ `rows` を同じ `validate()` に通してから書く。**空の色ページの
 * 分光積分は wasm 側にも同じテーブルが要るが、取得と検証を二重に持つと
 * 片方だけが古くなる余地ができる。取得 1 回・検証 1 回・書き出し 2 回。
 *
 *   node scripts/generate-cie1931.mjs
 *
 * 原典は CIE の刊行物で、本来の一次配布元は cvrl.org (Colour & Vision Research
 * Laboratory, UCL)。ここで colour-science を経由しているのは、cvrl.org が
 * 到達不能なことがあるため。colour-science は BSD-3-Clause で、
 * この等色関数の値は CIE 由来の同一データ。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  'https://raw.githubusercontent.com/colour-science/colour/develop/colour/colorimetry/datasets/cmfs.py';
const OBSERVER_KEY = 'CIE 1931 2 Degree Standard Observer';

const OUTPUT_PATH = fileURLToPath(new URL('../src/color/cie1931-data.ts', import.meta.url));
const RUST_OUTPUT_PATH = fileURLToPath(new URL('../rust/src/cie1931_data.rs', import.meta.url));

/** cmfs.py の該当ブロックから `波長: (x, y, z)` の行を拾う。 */
function parseObserver(source, observerKey) {
  const start = source.indexOf(`"${observerKey}": {`);
  if (start < 0) {
    throw new Error(`観測者 "${observerKey}" がソース中に見つかりません`);
  }

  const rows = [];
  const lineRe = /^\s*(\d+):\s*\(\s*([-\d.eE+]+),\s*([-\d.eE+]+),\s*([-\d.eE+]+),?\s*\),?\s*$/;

  for (const line of source.slice(start).split('\n').slice(1)) {
    const match = lineRe.exec(line);
    if (match === null) {
      // 数値行でなくなった = ブロックの終わり。
      if (rows.length > 0) break;
      continue;
    }
    rows.push([Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]);
  }

  if (rows.length === 0) {
    throw new Error('等色関数の行を 1 つも読み取れませんでした');
  }
  return rows;
}

/** 波長が 1nm 刻みで欠けなく並んでいること、値が妥当な範囲にあることを確認する。 */
function validate(rows) {
  const step = 1;
  for (let i = 1; i < rows.length; i += 1) {
    const delta = rows[i][0] - rows[i - 1][0];
    if (delta !== step) {
      throw new Error(`波長 ${rows[i - 1][0]}nm と ${rows[i][0]}nm の間隔が ${delta}nm です`);
    }
  }
  for (const [lambda, x, y, z] of rows) {
    for (const v of [x, y, z]) {
      if (!Number.isFinite(v) || v < 0 || v > 2) {
        throw new Error(`${lambda}nm の値 ${v} が想定範囲外です`);
      }
    }
  }

  // ȳ は視感度関数そのもので、定義上ピークは 555nm 付近のちょうど 1.0。
  // ここがずれていたら列の取り違えかスケールの誤りなので、生成時点で弾く。
  let peak = rows[0];
  for (const row of rows) {
    if (row[2] > peak[2]) peak = row;
  }
  if (Math.abs(peak[2] - 1) > 1e-3 || Math.abs(peak[0] - 555) > 5) {
    throw new Error(`ȳ のピークが ${peak[0]}nm で ${peak[2]} です (555nm で 1.0 のはず)`);
  }

  return { min: rows[0][0], max: rows[rows.length - 1][0], step };
}

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`取得に失敗しました: ${response.status} ${response.statusText}`);
}
const source = await response.text();

const rows = parseObserver(source, OBSERVER_KEY);
const { min, max, step } = validate(rows);

// 有効数字を保ったまま短く書く。Number#toString は往復可能な最短表現を返す。
const flat = rows.flatMap(([, x, y, z]) => [x, y, z]);
const lines = [];
for (let i = 0; i < rows.length; i += 1) {
  const [lambda, x, y, z] = rows[i];
  lines.push(`  ${x}, ${y}, ${z}, // ${lambda}nm`);
}

const output = `/**
 * CIE 1931 2° 標準観測者 等色関数 x̄(λ), ȳ(λ), z̄(λ)。
 *
 * !!! このファイルは scripts/generate-cie1931.mjs による生成物です。手で編集しないこと !!!
 *
 * 出典: ${OBSERVER_KEY}
 *   経由: ${SOURCE_URL}
 *         (colour-science / BSD-3-Clause。値は CIE 由来のもので、
 *          一次配布元は cvrl.org = Colour & Vision Research Laboratory, UCL)
 * 範囲: ${min}–${max}nm / ${step}nm 刻み / ${rows.length} 点
 */

export const CMF_LAMBDA_MIN = ${min};
export const CMF_LAMBDA_MAX = ${max};
export const CMF_LAMBDA_STEP = ${step};
export const CMF_SAMPLE_COUNT = ${rows.length};

/**
 * [x̄, ȳ, z̄] を波長順に平坦化したもの。
 * 波長 λ に対応する添字は (λ - CMF_LAMBDA_MIN) * 3。
 */
export const CMF_DATA: readonly number[] = [
${lines.join('\n')}
];
`;

await writeFile(OUTPUT_PATH, output, 'utf8');
console.log(`${OUTPUT_PATH} を生成しました (${rows.length} 点, ${flat.length} 値)`);

// --- Rust 側 --------------------------------------------------------------------

/**
 * Rust の f64 リテラルとして書く。
 *
 * Number#toString は往復可能な最短表現を返すのでそのまま使えるが、`0` や `1` の
 * ような整数値は Rust では**整数リテラル**になってしまい、`[f64; N]` の中で
 * 型エラーになる。小数点も指数もなければ `.0` を足す。
 */
function rustFloat(value) {
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

const rustLines = rows.map(
  ([lambda, x, y, z]) =>
    `    ${rustFloat(x)}, ${rustFloat(y)}, ${rustFloat(z)}, // ${lambda}nm`,
);

const rustOutput = `//! CIE 1931 2° 標準観測者 等色関数 x̄(λ), ȳ(λ), z̄(λ)。
//!
//! !!! このファイルは scripts/generate-cie1931.mjs による生成物です。手で編集しないこと !!!
//!
//! src/color/cie1931-data.ts と同じ取得・同じ検証から書き出しているので、
//! 両者は常に同じ値を持つ。
//!
//! 出典: ${OBSERVER_KEY}
//!   経由: ${SOURCE_URL}
//!         (colour-science / BSD-3-Clause。値は CIE 由来のもので、
//!          一次配布元は cvrl.org = Colour & Vision Research Laboratory, UCL)
//! 範囲: ${min}–${max}nm / ${step}nm 刻み / ${rows.length} 点

pub const CMF_LAMBDA_MIN: f64 = ${rustFloat(min)};
pub const CMF_LAMBDA_MAX: f64 = ${rustFloat(max)};
pub const CMF_LAMBDA_STEP: f64 = ${rustFloat(step)};
pub const CMF_SAMPLE_COUNT: usize = ${rows.length};

/// [x̄, ȳ, z̄] を波長順に平坦化したもの。
/// 波長 λ に対応する添字は (λ - CMF_LAMBDA_MIN) * 3。
pub static CMF_DATA: [f64; ${flat.length}] = [
${rustLines.join('\n')}
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 長さが標本数と整合する() {
        assert_eq!(CMF_DATA.len(), CMF_SAMPLE_COUNT * 3);
        assert_eq!(
            CMF_SAMPLE_COUNT,
            (CMF_LAMBDA_MAX - CMF_LAMBDA_MIN) as usize + 1
        );
    }

    /// ȳ は視感度関数そのもので、定義上ピークは 555nm 付近のちょうど 1.0。
    /// 列の取り違えやスケールの誤りを 1 点で捕まえられる。
    #[test]
    fn 視感度のピークが555nmで1になる() {
        let mut peak_index = 0;
        for i in 0..CMF_SAMPLE_COUNT {
            if CMF_DATA[i * 3 + 1] > CMF_DATA[peak_index * 3 + 1] {
                peak_index = i;
            }
        }
        let peak_lambda = CMF_LAMBDA_MIN + peak_index as f64;
        assert!((CMF_DATA[peak_index * 3 + 1] - 1.0).abs() < 1e-3);
        assert!((peak_lambda - 555.0).abs() < 5.0);
    }
}
`;

await mkdir(dirname(RUST_OUTPUT_PATH), { recursive: true });
await writeFile(RUST_OUTPUT_PATH, rustOutput, 'utf8');
console.log(`${RUST_OUTPUT_PATH} を生成しました (${rows.length} 点, ${flat.length} 値)`);
