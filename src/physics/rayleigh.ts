/**
 * 大気によるレイリー散乱。
 *
 * DOM に依存しない純粋な数値コード。
 *
 * τ(λ) を `0.008569 λ⁻⁴(1 + …)` のような当てはめ式でベタ書きすることもできるが、
 * それでは検算のしようがない。σ や ウィーンの b を SI 定義値から導出したのと
 * 同じ方針で、**分子 1 個の散乱断面積から積み上げる**。手順は
 * Bodhaine et al. (1999), "On Rayleigh Optical Depth Calculations",
 * J. Atmos. Oceanic Technol. 16, 1854–1861 に従う。
 *
 * 導出するとひとつ副産物が出る。可視域での実効的なべきは 4 ちょうどではなく
 * **≈ 4.09** になる — 屈折率の分散とキング因子が波長に依存するため。
 * λ⁻⁴ を直に書いていたら決して出てこない値で、テストで確認できる。
 */

// --- 標準大気 -----------------------------------------------------------------

/** 標準大気圧 [Pa]。 */
export const STANDARD_PRESSURE_PA = 101325;
/** 標準状態の気温 [K](15 °C)。屈折率と分子密度がこの条件で与えられている。 */
export const STANDARD_TEMPERATURE_K = 288.15;
/** アボガドロ定数 [mol⁻¹]。2019 年の SI 改定以降は定義値。 */
export const AVOGADRO = 6.02214076e23;
/** 標準重力加速度 [m/s²]。SI の定義値。 */
export const STANDARD_GRAVITY = 9.80665;

/**
 * CO₂ 濃度 [ppm]。
 *
 * 屈折率・キング因子・平均分子量のすべてに(僅かに)効くので 1 か所にまとめてある。
 * Bodhaine が基準に採った 360ppm を使う。現在の実際の値はこれより高いが、
 * τ への影響は 0.01% に満たない。
 */
export const CO2_PPM = 360;

/** 標準状態での分子数密度 N_s [m⁻³](288.15K, 1013.25hPa)。屈折率と同じ条件。 */
export const MOLECULAR_DENSITY_STD = 2.546899e25;

/** 乾燥空気の平均モル質量 [kg/mol]。CO₂ の割合から導出する。 */
export const MEAN_MOLAR_MASS_AIR = ((): number => {
  const co2 = CO2_PPM * 1e-4; // ppm → 体積百分率
  // 体積比 (%) と分子量。N₂ / O₂ / Ar は CO₂ を除いた残りを埋める形で与えられている。
  return (
    (28.0134 * 78.084 + 31.9988 * 20.946 + 39.948 * 0.934 + 44.00995 * co2) /
    (78.084 + 20.946 + 0.934 + co2) /
    1000
  );
})();

// --- 屈折率 --------------------------------------------------------------------

/**
 * 標準乾燥空気の屈折率 n(λ)。
 *
 * Peck & Reeder (1972) の分散式に、CO₂ 濃度の補正を掛ける。550nm で n ≈ 1.000278。
 *
 *   (n − 1)×10⁸ = 8060.51 + 2480990/(132.274 − σ²) + 17455.7/(39.32957 − σ²)
 *
 * σ = 1/λ [µm⁻¹]。分母が 0 に近づく共鳴は紫外の奥(λ ≈ 87nm と 159nm)にあり、
 * 扱う波長域からは十分離れている。
 */
export function refractiveIndex(lambdaNm: number): number {
  const inverseSquare = (1000 / lambdaNm) ** 2; // σ² [µm⁻²]
  const excess =
    (8060.51 + 2480990 / (132.274 - inverseSquare) + 17455.7 / (39.32957 - inverseSquare)) * 1e-8;

  // Bodhaine eq.(6)。基準組成 300ppm からのずれの分だけ屈折率が増える。
  const co2Correction = 1 + 0.54 * (CO2_PPM * 1e-6 - 0.0003);
  return 1 + excess * co2Correction;
}

// --- キング補正係数 -------------------------------------------------------------

/**
 * キング補正係数 F(λ)。550nm で ≈ 1.048。
 *
 * 空気の分子は球対称ではなく、向きによって分極率が違う。そのぶん散乱光は
 * 完全には偏光せず、散乱の総量も等方な分子を仮定した場合より大きくなる。
 * その増分がこの係数で、**4% ほどあるので無視できない**。
 *
 * N₂ と O₂ は測定された波長依存があり、Ar と CO₂ は定数として扱う
 * (Bodhaine eq.(5)、体積比による加重平均)。
 */
export function kingFactor(lambdaNm: number): number {
  const inverseSquare = (1000 / lambdaNm) ** 2; // σ² [µm⁻²]
  const nitrogen = 1.034 + 3.17e-4 * inverseSquare;
  const oxygen = 1.096 + 1.385e-3 * inverseSquare + 1.448e-4 * inverseSquare ** 2;
  const argon = 1.0;
  const carbonDioxide = 1.15;

  const co2 = CO2_PPM * 1e-4; // ppm → 体積百分率
  return (
    (78.084 * nitrogen + 20.946 * oxygen + 0.934 * argon + co2 * carbonDioxide) /
    (78.084 + 20.946 + 0.934 + co2)
  );
}

// --- 散乱断面積と光学的厚さ -------------------------------------------------------

/**
 * 分子 1 個あたりのレイリー散乱断面積 σ(λ) [m²]。550nm で 4.51e-31 m²。
 *
 *   σ = 24π³(n² − 1)² / (λ⁴ N²(n² + 2)²) · F(λ)
 *
 * λ⁻⁴ はここに現れる。ただし n も F も λ に依存するので、実効的なべきは
 * 4 より少し大きくなる。
 */
export function scatteringCrossSection(lambdaNm: number): number {
  if (!(lambdaNm > 0)) return 0;

  const lambda = lambdaNm * 1e-9;
  const n = refractiveIndex(lambdaNm);
  const nSquared = n * n;
  const density = MOLECULAR_DENSITY_STD;

  return (
    ((24 * Math.PI ** 3 * (nSquared - 1) ** 2) /
      (lambda ** 4 * density ** 2 * (nSquared + 2) ** 2)) *
    kingFactor(lambdaNm)
  );
}

/**
 * 大気全体を鉛直に貫く分子数 [m⁻²]。
 *
 *   N_column = P·A / (m_air·g)
 *
 * 静水圧平衡そのもの — 地表の気圧は真上にある空気の重さに等しい。だから
 * 大気の温度分布も高度分布も知らずに、気圧だけから分子数が決まる。
 */
export const COLUMN_DENSITY =
  (STANDARD_PRESSURE_PA * AVOGADRO) / (MEAN_MOLAR_MASS_AIR * STANDARD_GRAVITY);

/**
 * 海面から大気圏外までのレイリー光学的厚さ τ_R(λ)。550nm で ≈ 0.097。
 *
 * 断面積にカラム密度を掛けるだけ。「光路上にある分子の断面積を全部足すと、
 * 空の何割を覆うか」がそのまま τ になる。
 */
export function opticalDepth(lambdaNm: number): number {
  return scatteringCrossSection(lambdaNm) * COLUMN_DENSITY;
}

/**
 * air mass m だけ大気を通ったあとの透過率 T = exp(−τ(λ)·m)。
 *
 * ランベール・ベールの法則。散乱で光路から失われた分だけ減るので、
 * 「どこへ行ったか」(空を明るくしている)はここには出てこない。
 *
 * @param airMass 天頂方向の大気を 1 とした通過量。0 なら大気圏外で減衰なし。
 */
export function transmittance(lambdaNm: number, airMass: number): number {
  if (!(airMass > 0)) return 1;
  return Math.exp(-opticalDepth(lambdaNm) * airMass);
}
