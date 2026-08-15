/**
 * src/color/cie1931-data.ts を生成する。
 *
 * CIE 1931 2° 標準観測者の等色関数を colour-science のデータセットから取り出し、
 * TypeScript のテーブルとして書き出す。生成物はコミットするので、
 * 通常の開発でこのスクリプトを走らせる必要はない
 * (データを更新したい / 出所を検算したいときだけ)。
 *
 *   node scripts/generate-cie1931.mjs
 *
 * 原典は CIE の刊行物で、本来の一次配布元は cvrl.org (Colour & Vision Research
 * Laboratory, UCL)。ここで colour-science を経由しているのは、cvrl.org が
 * 到達不能なことがあるため。colour-science は BSD-3-Clause で、
 * この等色関数の値は CIE 由来の同一データ。
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  'https://raw.githubusercontent.com/colour-science/colour/develop/colour/colorimetry/datasets/cmfs.py';
const OBSERVER_KEY = 'CIE 1931 2 Degree Standard Observer';

const OUTPUT_PATH = fileURLToPath(new URL('../src/color/cie1931-data.ts', import.meta.url));

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
