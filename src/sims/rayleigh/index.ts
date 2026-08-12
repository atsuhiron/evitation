/**
 * 大気によるレイリー散乱シミュレータ。
 *
 * 単色光か黒体放射のどちらかを光源に選び、air mass を与えて、大気を通ったあとの
 * 色とスペクトルを見る。
 *
 * 既存 3 ページが扱ってきたのは「光そのものの色」だったが、ここで初めて
 * 光が媒質を通って変質する側に入る。とはいえ減衰は波長ごとの掛け算
 * S'(λ) = S(λ)·exp(−τ(λ)·m) にすぎないので、色のパイプラインは何も変わらない。
 * 新しいのは τ(λ) の中身だけ。
 */

import './rayleigh.css';
import {
  cmfAt,
  spectrumToXYZ,
  VISIBLE_LAMBDA_MAX,
  VISIBLE_LAMBDA_MIN,
  xyzToColor,
  type ColorResult,
  type XYZ,
} from '../../color/index.ts';
import { normalizedSpectrum } from '../../physics/planck.ts';
import { transmittance } from '../../physics/rayleigh.ts';
import { createRadioGroup, type RadioGroup } from '../../ui/radio-group.ts';
import { SpectrumChart, type ChartCurve, type ChartMarker } from '../../ui/spectrum-chart.ts';
import {
  clampTemperature,
  MAX_TEMPERATURE_K,
  MIN_TEMPERATURE_K,
  positionToTemperature,
  SLIDER_STEPS as TEMPERATURE_SLIDER_STEPS,
  temperatureToPosition,
} from '../../ui/temperature-axis.ts';
import { ValueList } from '../../ui/value-list.ts';
import {
  AIR_MASS_STEP,
  clampAirMass,
  MAX_AIR_MASS,
  MIN_AIR_MASS,
  SLIDER_STEPS as AIR_MASS_SLIDER_STEPS,
} from './air-mass.ts';
import { defaultPreset, presets } from './presets.ts';

/**
 * スペクトル図の波長範囲 [nm]。
 *
 * 可視域の両側を少しずつ含める。300nm 側は τ が 1 を超えて透過率が急落する様子が、
 * 1000nm 側は逆にほとんど減らない様子が見える。λ⁻⁴ の効き方を掴むには
 * 可視域だけでは足りない。
 */
const CHART_LAMBDA_MIN_NM = 300;
const CHART_LAMBDA_MAX_NM = 1000;
const CHART_X_TICKS = [300, 400, 500, 600, 700, 800, 900, 1000];
const CHART_Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

/** 透過率曲線の色。光源の色と紛れないよう、スペクトル色にない色を使う。 */
const TRANSMITTANCE_COLOR = '#7cc4ff';

/** 光源の種類。 */
type SourceKind = 'monochromatic' | 'blackbody';

/**
 * 明るさの決め方。
 *
 * - `common`: 入射光を基準にした共通の係数を減衰前後の両方に掛ける。減衰が
 *   明るさの差として見える(このページの既定)
 * - `max`: 前後それぞれを最大成分正規化する。色相の変化だけを比べる
 */
type BrightnessMode = 'common' | 'max';

const DEFAULT_LAMBDA_NM = 550;
const DEFAULT_TEMPERATURE_K = 5778;

interface State {
  source: SourceKind;
  lambdaNm: number;
  temperatureK: number;
  airMass: number;
  brightness: BrightnessMode;
}

const state: State = {
  source: 'blackbody',
  lambdaNm: DEFAULT_LAMBDA_NM,
  temperatureK: DEFAULT_TEMPERATURE_K,
  airMass: defaultPreset.airMass,
  brightness: 'common',
};

let chart: SpectrumChart | null = null;
let values: ValueList;
let modeGroups: RadioGroup[] = [];

// mount 時に組み立て、render で中身を書き替える要素。
let sourcePanels: Record<SourceKind, HTMLElement>;
let lambdaSlider: HTMLInputElement;
let lambdaNumber: HTMLInputElement;
let temperatureSlider: HTMLInputElement;
let temperatureNumber: HTMLInputElement;
let airMassSlider: HTMLInputElement;
let airMassNumber: HTMLInputElement;
let incidentSwatch: HTMLElement;
let transmittedSwatch: HTMLElement;
let notes: HTMLElement;
let presetHint: HTMLElement;

// --- 光の計算 ------------------------------------------------------------------

/** 三刺激値を定数倍する。減衰も共通スケールも、結局これしかしていない。 */
function scaleXYZ(xyz: XYZ, factor: number): XYZ {
  return [xyz[0] * factor, xyz[1] * factor, xyz[2] * factor];
}

/**
 * 入射光の三刺激値。
 *
 * 単色光は δ 関数なので等色関数の値そのもの、黒体は連続スペクトルなので積分する。
 * 黒体側は ∫B̂ dλ = 1 に正規化済みの分布を使うので、温度を変えても放射の総量は変わらない。
 */
function incidentXYZ(): XYZ {
  if (state.source === 'monochromatic') return cmfAt(state.lambdaNm);
  return spectrumToXYZ((lambdaNm) => normalizedSpectrum(lambdaNm, state.temperatureK));
}

/** 透過光の三刺激値。入射のスペクトルに透過率を掛けてから積分するだけ。 */
function transmittedXYZ(): XYZ {
  const { airMass } = state;
  if (state.source === 'monochromatic') {
    return scaleXYZ(cmfAt(state.lambdaNm), transmittance(state.lambdaNm, airMass));
  }
  return spectrumToXYZ(
    (lambdaNm) => normalizedSpectrum(lambdaNm, state.temperatureK) * transmittance(lambdaNm, airMass),
  );
}

/**
 * 減衰前後で共有するスケール係数。入射光の最大成分がちょうど 1 になる値。
 *
 * これがこの画面の要になっている。xyzToColor をそれぞれに掛けると前後とも最大成分が
 * 1 に揃ってしまい、減衰が画面から消える — 単色光にいたっては前後が完全に同じ色になる。
 *
 * 同じ係数を掛けるだけで済むのは、相対輝度モードが入力について 1 次同次だから
 * (色域マッピングも輝度の正規化も入力を k 倍すれば出力が k 倍になる)。
 * この性質は rayleigh.test.ts で固定してある。
 */
function commonScale(xyz: XYZ): number {
  const max = Math.max(...xyzToColor(xyz, 'luminance').linearRGB);
  return max > 0 ? 1 / max : 1;
}

interface Rendered {
  readonly incident: ColorResult;
  readonly transmitted: ColorResult;
  /** 可視域の明るさが何倍残ったか。Y_out / Y_in。 */
  readonly luminanceRatio: number;
}

function computeColors(): Rendered {
  const inXYZ = incidentXYZ();
  const outXYZ = transmittedXYZ();
  const luminanceRatio = inXYZ[1] > 0 ? outXYZ[1] / inXYZ[1] : 0;

  if (state.brightness === 'max') {
    return {
      incident: xyzToColor(inXYZ, 'max'),
      transmitted: xyzToColor(outXYZ, 'max'),
      luminanceRatio,
    };
  }

  const scale = commonScale(inXYZ);
  const apply = (xyz: XYZ): ColorResult => xyzToColor(scaleXYZ(xyz, scale), 'luminance');
  return { incident: apply(inXYZ), transmitted: apply(outXYZ), luminanceRatio };
}

// --- 状態の更新 ----------------------------------------------------------------

function setSource(source: SourceKind): void {
  if (source === state.source) return;
  state.source = source;
  render();
}

function setLambda(value: number): void {
  const lambdaNm = Math.min(VISIBLE_LAMBDA_MAX, Math.max(VISIBLE_LAMBDA_MIN, Math.round(value)));
  if (lambdaNm === state.lambdaNm) return;
  state.lambdaNm = lambdaNm;
  render();
}

function setTemperature(value: number): void {
  const temperatureK = clampTemperature(value);
  if (temperatureK === state.temperatureK) return;
  state.temperatureK = temperatureK;
  render();
}

function setAirMass(value: number): void {
  const airMass = clampAirMass(value);
  if (airMass === state.airMass) return;
  state.airMass = airMass;
  render();
}

// --- 部品の組み立て -----------------------------------------------------------

/**
 * スライダーと数値入力の組。3 ページで同じ作法を繰り返しているので、
 * このページの中だけでもまとめておく。
 *
 * 数値入力は打ち込み途中の値も反映するが、範囲外や空欄をその場では書き戻さない
 * (入力中に勝手に値が変わると打ちづらいため)。確定時に丸めた値を反映する。
 */
function buildSliderRow(config: {
  readonly sliderId: string;
  readonly sliderClass: string;
  readonly ariaLabel: string;
  readonly numberMin: number;
  readonly numberMax: number;
  readonly numberStep: number;
  readonly unit: string;
  readonly onSlider: (position: number) => void;
  readonly onNumber: (value: number) => void;
  readonly writeBack: () => string;
}): { row: HTMLElement; slider: HTMLInputElement; number: HTMLInputElement } {
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = config.sliderId;
  slider.className = config.sliderClass;
  slider.step = '1';

  const number = document.createElement('input');
  number.type = 'number';
  number.className = 'ray__number';
  number.min = String(config.numberMin);
  number.max = String(config.numberMax);
  number.step = String(config.numberStep);
  number.setAttribute('aria-label', config.ariaLabel);

  const unit = document.createElement('span');
  unit.className = 'ray__unit';
  unit.textContent = config.unit;

  const group = document.createElement('div');
  group.className = 'ray__number-group';
  group.append(number, unit);

  const row = document.createElement('div');
  row.className = 'ray__control-row';
  row.append(slider, group);

  slider.addEventListener('input', () => {
    config.onSlider(Number(slider.value));
  });
  number.addEventListener('input', () => {
    const value = Number(number.value);
    if (number.value !== '' && Number.isFinite(value)) config.onNumber(value);
  });
  const writeBack = (): void => {
    number.value = config.writeBack();
  };
  number.addEventListener('change', writeBack);
  number.addEventListener('blur', writeBack);

  return { row, slider, number };
}

function buildSourcePanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'panel ray-source';

  const group = createRadioGroup<SourceKind>(
    'source-kind',
    '光源',
    [
      {
        value: 'monochromatic',
        label: '単色光',
        hint: '波長 1 本だけの光。減るのは強さだけで、色相はまったく動かない。',
      },
      {
        value: 'blackbody',
        label: '黒体放射',
        hint: '温度で決まる連続スペクトル。青側から削られるので色が赤へ移る。',
      },
    ],
    () => state.source,
    setSource,
  );
  group.element.classList.add('radio-group--inline');
  modeGroups.push(group);

  // --- 単色光の控え ---
  const monoLabel = document.createElement('label');
  monoLabel.className = 'field-label';
  monoLabel.htmlFor = 'ray-lambda-slider';
  monoLabel.textContent = `波長 λ(${VISIBLE_LAMBDA_MIN}–${VISIBLE_LAMBDA_MAX} nm)`;

  const mono = buildSliderRow({
    sliderId: 'ray-lambda-slider',
    sliderClass: 'ray__slider',
    ariaLabel: '波長 (nm)',
    numberMin: VISIBLE_LAMBDA_MIN,
    numberMax: VISIBLE_LAMBDA_MAX,
    numberStep: 1,
    unit: 'nm',
    onSlider: setLambda,
    onNumber: setLambda,
    writeBack: () => String(state.lambdaNm),
  });
  lambdaSlider = mono.slider;
  lambdaNumber = mono.number;
  lambdaSlider.min = String(VISIBLE_LAMBDA_MIN);
  lambdaSlider.max = String(VISIBLE_LAMBDA_MAX);

  const monoPanel = document.createElement('div');
  monoPanel.className = 'ray-source__control';
  monoPanel.append(monoLabel, mono.row);

  // --- 黒体の控え ---
  const bbLabel = document.createElement('label');
  bbLabel.className = 'field-label';
  bbLabel.htmlFor = 'ray-temperature-slider';
  bbLabel.textContent = `温度 T(${MIN_TEMPERATURE_K}–${MAX_TEMPERATURE_K} K)`;

  const blackbody = buildSliderRow({
    sliderId: 'ray-temperature-slider',
    sliderClass: 'ray__slider',
    ariaLabel: '温度 (K)',
    numberMin: MIN_TEMPERATURE_K,
    numberMax: MAX_TEMPERATURE_K,
    numberStep: 1,
    unit: 'K',
    // 黒体ページと同じく 1/T について線形に並べる。
    onSlider: (position) => setTemperature(positionToTemperature(position / TEMPERATURE_SLIDER_STEPS)),
    onNumber: setTemperature,
    writeBack: () => String(state.temperatureK),
  });
  temperatureSlider = blackbody.slider;
  temperatureNumber = blackbody.number;
  temperatureSlider.min = '0';
  temperatureSlider.max = String(TEMPERATURE_SLIDER_STEPS);

  const bbPanel = document.createElement('div');
  bbPanel.className = 'ray-source__control';
  bbPanel.append(bbLabel, blackbody.row);

  sourcePanels = { monochromatic: monoPanel, blackbody: bbPanel };

  panel.append(group.element, monoPanel, bbPanel);
  return panel;
}

function buildAirMassPanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'panel ray-airmass';

  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = 'ray-airmass-slider';
  label.textContent = `air mass(${MIN_AIR_MASS}–${MAX_AIR_MASS}。天頂の大気を 1 とした通過量)`;

  const control = buildSliderRow({
    sliderId: 'ray-airmass-slider',
    sliderClass: 'ray__slider',
    ariaLabel: 'air mass',
    numberMin: MIN_AIR_MASS,
    numberMax: MAX_AIR_MASS,
    numberStep: AIR_MASS_STEP,
    unit: 'AM',
    onSlider: (position) => setAirMass(position * AIR_MASS_STEP),
    onNumber: setAirMass,
    writeBack: () => state.airMass.toFixed(1),
  });
  airMassSlider = control.slider;
  airMassNumber = control.number;
  airMassSlider.min = '0';
  airMassSlider.max = String(AIR_MASS_SLIDER_STEPS);

  const buttons = document.createElement('div');
  buttons.className = 'ray-presets__buttons';
  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ray-presets__button';
    button.textContent = preset.name;
    button.title = preset.hint;
    button.addEventListener('click', () => {
      presetHint.textContent = preset.hint;
      setAirMass(preset.airMass);
    });
    buttons.append(button);
  }

  presetHint = document.createElement('p');
  presetHint.className = 'ray-presets__hint';
  presetHint.textContent = defaultPreset.hint;

  panel.append(label, control.row, buttons, presetHint);
  return panel;
}

function buildChartPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = 'スペクトルと透過率(縦軸は入射のピークを 1 とした比)';

  chart = new SpectrumChart({
    lambdaMin: CHART_LAMBDA_MIN_NM,
    lambdaMax: CHART_LAMBDA_MAX_NM,
    xTicks: CHART_X_TICKS,
  });

  section.append(label, chart.element);
  return section;
}

function buildResultPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel ray-result';

  incidentSwatch = document.createElement('div');
  incidentSwatch.className = 'ray-result__swatch';
  transmittedSwatch = document.createElement('div');
  transmittedSwatch.className = 'ray-result__swatch';

  const swatches = document.createElement('div');
  swatches.className = 'ray-result__swatches';
  swatches.append(
    buildCaptionedSwatch('減衰前(入射光)', incidentSwatch),
    buildCaptionedSwatch('減衰後(透過光)', transmittedSwatch),
  );

  // 前後の HEX を並べるのがこのページの主眼なので、他ページの linear RGB の枠を
  // 「入射光の HEX」に譲っている。値の文字列が長いと右列で折り返してパネルの
  // 高さが動くので、1 行に収まる長さに留めること。
  values = new ValueList([
    { key: 'incident', term: '入射光' },
    { key: 'transmitted', term: '透過光' },
    { key: 'rgb', term: 'RGB (8bit)' },
    { key: 'ratio', term: '輝度の透過率' },
  ]);

  notes = document.createElement('div');
  notes.className = 'ray-result__notes';

  // 注記は値の下、スウォッチの右側に置く。パネルの下に敷くと、注記の増減で
  // パネルの高さが変わってページ全体が動いてしまう。
  const side = document.createElement('div');
  side.className = 'ray-result__side';
  side.append(values.element, notes);

  const layout = document.createElement('div');
  layout.className = 'ray-result__layout';
  layout.append(swatches, side);

  section.append(layout);
  return section;
}

function buildCaptionedSwatch(caption: string, swatch: HTMLElement): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'ray-result__swatch-wrapper';

  const label = document.createElement('span');
  label.className = 'ray-result__caption';
  label.textContent = caption;

  wrapper.append(swatch, label);
  return wrapper;
}

function buildModePanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'radio-group-row';

  const group = createRadioGroup<BrightnessMode>(
    'brightness-mode',
    '明るさの決め方',
    [
      {
        value: 'common',
        label: '共通スケール',
        hint: '入射光を基準にした同じ係数を両方に掛ける。減衰がそのまま明るさの差として見える。',
      },
      {
        value: 'max',
        label: 'それぞれ最大成分正規化',
        hint: '色相の変化だけを比べる。単色光では前後が完全に同じ色になる — 色は変わらないので。',
      },
    ],
    () => state.brightness,
    (value) => {
      state.brightness = value;
      render();
    },
  );
  modeGroups.push(group);

  panel.append(group.element);
  return panel;
}

// --- 描画 --------------------------------------------------------------------

function renderNotes(color: ColorResult): void {
  const messages: string[] = [];

  if (state.airMass === 0) {
    messages.push('大気圏外なので減衰はありません。前後のスウォッチは同一の色です。');
  }
  if (color.outOfGamut) {
    const ratio = color.whiteAdded / (color.whiteAdded + Math.max(color.xyz[1], 1e-12));
    messages.push(
      `sRGB の色域外です。白を約 ${(ratio * 100).toFixed(0)}% 混ぜて彩度を落としてあり、実際はこれより鮮やかな色に見えます。`,
    );
  }
  if (color.clipped) {
    messages.push('明るさが表示の上限を超えています(白飛び)。');
  }
  // 何も問題がないときも同じ場所に文章を出す。空にしておくと、確保した余白が
  // ただの隙間に見えてしまう。
  if (messages.length === 0) {
    messages.push('この色は sRGB の色域内に収まっており、表示色は忠実です。');
  }

  notes.replaceChildren(
    ...messages.map((message) => {
      const paragraph = document.createElement('p');
      paragraph.className = 'ray-result__note';
      paragraph.textContent = message;
      return paragraph;
    }),
  );
}

function renderChart(): void {
  const { airMass } = state;
  const curves: ChartCurve[] = [];
  const markers: ChartMarker[] = [];
  const legend: Array<{ label: string; color: string; dashed?: boolean }> = [];

  const incidentColor = xyzToColor(incidentXYZ(), 'max').hex;

  if (state.source === 'blackbody') {
    // 正規化は「窓の中での入射スペクトルの最大値」で行う。λmax が窓の外(低温)でも
    // 曲線が枠いっぱいに収まり、透過との比が読める。
    let peak = 0;
    for (let lambdaNm = CHART_LAMBDA_MIN_NM; lambdaNm <= CHART_LAMBDA_MAX_NM; lambdaNm += 5) {
      peak = Math.max(peak, normalizedSpectrum(lambdaNm, state.temperatureK));
    }
    const scale = peak > 0 ? 1 / peak : 0;

    curves.push({
      valueAt: (lambdaNm) => normalizedSpectrum(lambdaNm, state.temperatureK) * scale,
      color: incidentColor,
      dashed: true,
      width: 1.5,
    });
    curves.push({
      valueAt: (lambdaNm) =>
        normalizedSpectrum(lambdaNm, state.temperatureK) * transmittance(lambdaNm, airMass) * scale,
      color: incidentColor,
      fill: true,
    });
    legend.push(
      { label: '入射', color: incidentColor, dashed: true },
      { label: '透過', color: incidentColor },
    );
  } else {
    // 単色光は線スペクトルなので曲線にならない。縦棒 2 本で前後を示す。
    const t = transmittance(state.lambdaNm, airMass);
    markers.push(
      { lambdaNm: state.lambdaNm, height: 1, color: '#ffffff' },
      {
        lambdaNm: state.lambdaNm,
        height: t,
        color: incidentColor,
        label: `λ ${state.lambdaNm} nm`,
      },
    );
    legend.push({ label: '入射', color: '#ffffff' }, { label: '透過', color: incidentColor });
  }

  curves.push({
    valueAt: (lambdaNm) => transmittance(lambdaNm, airMass),
    color: TRANSMITTANCE_COLOR,
    width: 1.5,
  });
  legend.push({ label: '透過率 T(λ)', color: TRANSMITTANCE_COLOR });

  chart?.setState({
    axis: { kind: 'linear', max: 1, ticks: CHART_Y_TICKS },
    axisTitle: '入射のピークを 1 とした比 / 透過率',
    curves,
    markers,
    legend,
  });
}

function render(): void {
  // 光源の控えは選ばれた側だけを見せる。DOM を作り直さないのは、
  // 入力欄のフォーカスと canvas の実測幅を保つため。
  for (const [kind, panel] of Object.entries(sourcePanels)) {
    panel.hidden = kind !== state.source;
  }

  lambdaSlider.value = String(state.lambdaNm);
  if (document.activeElement !== lambdaNumber) lambdaNumber.value = String(state.lambdaNm);

  temperatureSlider.value = String(
    Math.round(temperatureToPosition(state.temperatureK) * TEMPERATURE_SLIDER_STEPS),
  );
  if (document.activeElement !== temperatureNumber) {
    temperatureNumber.value = String(state.temperatureK);
  }

  airMassSlider.value = String(Math.round(state.airMass / AIR_MASS_STEP));
  if (document.activeElement !== airMassNumber) airMassNumber.value = state.airMass.toFixed(1);

  const { incident, transmitted, luminanceRatio } = computeColors();

  incidentSwatch.style.backgroundColor = incident.hex;
  transmittedSwatch.style.backgroundColor = transmitted.hex;

  values.set('incident', incident.hex);
  values.set('transmitted', transmitted.hex);

  const [r, g, b] = transmitted.rgb8;
  values.set('rgb', `R ${r} / G ${g} / B ${b}`, `rgb(${r}, ${g}, ${b})`);

  // 1% を下回ると小数第 1 位では 0.0% に潰れるので、そこだけ指数で出す。
  const percent = luminanceRatio * 100;
  values.set(
    'ratio',
    percent >= 0.1 ? `${percent.toFixed(1)} %` : `${percent.toExponential(1)} %`,
    luminanceRatio.toExponential(6),
  );

  renderNotes(transmitted);
  for (const group of modeGroups) group.sync();
  renderChart();
}

// --- ライフサイクル -----------------------------------------------------------

export function mount(root: HTMLElement): void {
  const container = document.createElement('div');
  container.className = 'ray';

  const lead = document.createElement('p');
  lead.className = 'ray__lead';
  lead.textContent =
    '光が大気を通るとき、空気分子によるレイリー散乱で S′(λ) = S(λ)·exp(−τ(λ)·m) だけ減衰します。光学的厚さ τ は分子 1 個の散乱断面積から積み上げていて、可視域では λ の −4.08 乗にほぼ比例します(λ⁻⁴ からのずれは空気の屈折率の分散と分子の異方性によるもの)。青が先に失われるので、通る大気が厚くなるほど光は赤へ寄ります。なお実際の大気の減光にはエアロゾルとオゾンも効くので、ここで見えるのはレイリー散乱だけを取り出した理想化です。地平線に近い AM 38 付近では、大気を平行平面とみなすこの扱い自体も精度を失います。';

  // 並び順の意図: スライダーを動かしながら図の変化を見たいので、操作するものを
  // 上に固め、その直後に図を置く。図より下は、動かしている最中に視線を送らなくても
  // 困らないものだけにしてある(黒体放射ページと同じ判断)。
  container.append(
    lead,
    buildSourcePanel(),
    buildAirMassPanel(),
    buildChartPanel(),
    buildResultPanel(),
    buildModePanel(),
  );
  root.append(container);

  render();
  // DOM に入って幅が確定してから描く(ResizeObserver の初回通知には頼らない)。
  chart?.refresh();
}

export function unmount(): void {
  chart?.destroy();
  chart = null;
  values.destroy();
  modeGroups = [];
}
