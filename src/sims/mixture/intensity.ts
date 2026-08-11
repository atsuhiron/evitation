/**
 * 強度スライダーの意味づけと、放射強度への換算。
 */

import { cmfAt, type SpectralLine } from '../../color/index.ts';

/** 強度スライダーが表す量。 */
export type IntensityBasis = 'radiance' | 'luminance';

/**
 * 強度スライダーの刻み。プリセットの値もここに合わせ、表示と内部状態を一致させる。
 *
 * 0.01 では粗すぎる。CIE RGB の白では青(436nm)が担う輝度が全体の約 1.2% しかなく、
 * 0.01 刻みだと 0.012 → 0.01 の丸めで青が 2 割近く痩せて白が黄ばむ(#FAFFE9)。
 * 0.001 なら #FCFCFF に収まり、白として通用する。
 */
export const INTENSITY_STEP = 0.001;

/** 強度の表示桁数。INTENSITY_STEP に対応させる。 */
export const INTENSITY_DIGITS = 3;

export interface IntensityComponent {
  readonly lambdaNm: number;
  readonly intensity: number;
}

/**
 * スライダーの値を放射強度に直す。
 *
 * 輝度基準では I を「その成分が担う輝度」と解釈するので、放射強度は I / ȳ(λ)。
 * ȳ は可視域で常に正なので 0 除算は起きない。380nm のように視感度が極端に低い波長では
 * 放射強度が桁違いに大きくなるが、これは「その波長で同じ明るさを得るには桁違いの放射が
 * 要る」という事実そのものなので、そのまま計算してよい。
 *
 * この定義の帰結として、輝度基準では合成後の Y がちょうど ΣI に一致する。
 */
export function toRadianceLines(
  components: readonly IntensityComponent[],
  basis: IntensityBasis,
): SpectralLine[] {
  return components.map((component) => ({
    lambdaNm: component.lambdaNm,
    intensity:
      basis === 'radiance'
        ? component.intensity
        : component.intensity / cmfAt(component.lambdaNm)[1],
  }));
}
