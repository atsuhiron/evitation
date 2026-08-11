/**
 * 黒体放射シミュレータ。
 *
 * 温度からプランクの法則で分光分布を求め、その連続スペクトルの色を表示する。
 * 既存の 2 ページが扱っていたのは δ 関数的な線スペクトルだったので、
 * spectrumToXYZ による連続スペクトルの積分を実際に通す初めてのページでもある。
 */

import './blackbody.css';
import { xyzToColor, type ColorResult, type NormalizeMode } from '../../color/index.ts';
import { GradientBar } from '../../ui/gradient-bar.ts';
import { createRadioGroup, type RadioGroup } from '../../ui/radio-group.ts';
import { ValueList } from '../../ui/value-list.ts';
import { blackbodyXYZ, luminousEfficacy } from './planck.ts';
import { defaultPreset, presets } from './presets.ts';
import { SpectrumChart, type ChartScale } from './spectrum-chart.ts';
import {
  clampTemperature,
  MAX_TEMPERATURE_K,
  MIN_TEMPERATURE_K,
  positionToTemperature,
  SLIDER_STEPS,
  temperatureToPosition,
} from './temperature.ts';

/** 色温度帯の目盛り。逆数目盛なので低温側が広く、間隔もそれに合わせて粗くしていく。 */
const BAR_TICKS = [1000, 1500, 2000, 3000, 5000, 10000, 20000];

interface State {
  temperatureK: number;
  chartScale: ChartScale;
  brightness: NormalizeMode;
}

const state: State = {
  temperatureK: defaultPreset.temperatureK,
  chartScale: 'peak',
  brightness: 'max',
};

let temperatureBar: GradientBar | null = null;
let chart: SpectrumChart | null = null;
let values: ValueList;
let modeGroups: RadioGroup[] = [];

// mount 時に組み立て、render で中身を書き替える要素。
let slider: HTMLInputElement;
let numberInput: HTMLInputElement;
let swatch: HTMLElement;
let notes: HTMLElement;
let presetHint: HTMLElement;

function setTemperature(value: number): void {
  const temperatureK = clampTemperature(value);
  if (temperatureK === state.temperatureK) return;
  state.temperatureK = temperatureK;
  render();
}

/**
 * `luminance` モードで使う、このページ共通のスケール係数。
 *
 * xyzToColor の相対輝度モードは「単位放射強度の単色光」を基準に係数が決まっている。
 * 一方こちらは ∫B̂ dλ = 1 に正規化した黒体なので Y はせいぜい 0.14(発光効率の
 * 上限 95/683 に対応)しかなく、そのまま渡すとページ全体が暗く沈んでしまう。
 *
 * そこで扱う温度範囲を走査し、最も明るくなる温度がちょうど上限に届く係数を求める。
 * 効率が最大の温度(≈6600K)とは一致しない — 高温側は色度が青に寄り、同じ Y でも
 * 最大成分が大きくなるため、実際のピークは 8000K 台に来る。だから決め打ちにせず走査する。
 */
let cachedDisplayScale: number | null = null;

function displayScale(): number {
  if (cachedDisplayScale !== null) return cachedDisplayScale;

  let peak = 0;
  for (let temperatureK = MIN_TEMPERATURE_K; temperatureK <= MAX_TEMPERATURE_K; temperatureK += 25) {
    const { linearRGB } = xyzToColor(blackbodyXYZ(temperatureK), 'luminance');
    peak = Math.max(peak, linearRGB[0], linearRGB[1], linearRGB[2]);
  }

  cachedDisplayScale = peak > 0 ? 1 / peak : 1;
  return cachedDisplayScale;
}

/** 表示に使う色。明るさモードによって渡す三刺激値のスケールが変わる。 */
function colorAt(temperatureK: number, brightness: NormalizeMode): ColorResult {
  const xyz = blackbodyXYZ(temperatureK);
  if (brightness === 'max') return xyzToColor(xyz, 'max');

  const scale = displayScale();
  return xyzToColor([xyz[0] * scale, xyz[1] * scale, xyz[2] * scale], 'luminance');
}

// --- 部品の組み立て -----------------------------------------------------------

function buildTemperatureControl(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'panel';

  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = 'temperature-slider';
  label.textContent = `温度 T(${MIN_TEMPERATURE_K}–${MAX_TEMPERATURE_K} K)`;

  slider = document.createElement('input');
  slider.type = 'range';
  slider.id = 'temperature-slider';
  slider.className = 'bb__slider';
  slider.min = '0';
  slider.max = String(SLIDER_STEPS);
  slider.step = '1';

  numberInput = document.createElement('input');
  numberInput.type = 'number';
  numberInput.className = 'bb__number';
  numberInput.min = String(MIN_TEMPERATURE_K);
  numberInput.max = String(MAX_TEMPERATURE_K);
  numberInput.step = '1';
  numberInput.setAttribute('aria-label', '温度 (K)');

  const unit = document.createElement('span');
  unit.className = 'bb__unit';
  unit.textContent = 'K';

  const inputGroup = document.createElement('div');
  inputGroup.className = 'bb__number-group';
  inputGroup.append(numberInput, unit);

  const row = document.createElement('div');
  row.className = 'bb__control-row';
  row.append(slider, inputGroup);

  slider.addEventListener('input', () => {
    setTemperature(positionToTemperature(Number(slider.value) / SLIDER_STEPS));
  });

  // 入力途中の値も反映するが、範囲外や空欄でその場では書き戻さない
  // (打ち込んでいる最中に勝手に値が変わると入力しづらいため)。
  numberInput.addEventListener('input', () => {
    const value = Number(numberInput.value);
    if (numberInput.value !== '' && Number.isFinite(value)) {
      setTemperature(value);
    }
  });
  const writeBack = (): void => {
    numberInput.value = String(state.temperatureK);
  };
  numberInput.addEventListener('change', writeBack);
  numberInput.addEventListener('blur', writeBack);

  panel.append(label, row);
  return panel;
}

function buildBarPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = '色温度帯(クリックまたはドラッグで温度を選択。目盛りは 1/T に比例)';

  temperatureBar = new GradientBar({
    min: MIN_TEMPERATURE_K,
    max: MAX_TEMPERATURE_K,
    // 帯は常に最大成分正規化で描く。相対輝度で描くと低温側が真っ黒に沈んで
    // 目盛りとして読めなくなる(スペクトル帯と同じ理由)。
    colorAt: (temperatureK) => xyzToColor(blackbodyXYZ(temperatureK), 'max').rgb8,
    ticks: BAR_TICKS,
    valueAt: positionToTemperature,
    positionOf: temperatureToPosition,
    // 1 点ごとに分光分布を積分するので、画素列ごとに求めると重い。
    // 帯は滑らかな勾配なのでこの程度の標本数で十分。
    maxSamples: 192,
    onSelect: setTemperature,
  });

  section.append(label, temperatureBar.element);
  return section;
}

function buildPresetPanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'panel bb-presets';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = 'プリセット';

  const buttons = document.createElement('div');
  buttons.className = 'bb-presets__buttons';

  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bb-presets__button';
    button.textContent = preset.name;
    button.title = preset.hint;
    button.addEventListener('click', () => {
      presetHint.textContent = preset.hint;
      setTemperature(preset.temperatureK);
    });
    buttons.append(button);
  }

  presetHint = document.createElement('p');
  presetHint.className = 'bb-presets__hint';
  presetHint.textContent = defaultPreset.hint;

  panel.append(label, buttons, presetHint);
  return panel;
}

function buildResultPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel bb-result';

  swatch = document.createElement('div');
  swatch.className = 'bb-result__swatch';

  values = new ValueList([
    { key: 'rgb', term: 'RGB (8bit)' },
    { key: 'hex', term: 'HEX' },
    { key: 'linear', term: 'linear RGB' },
    { key: 'efficacy', term: '発光効率' },
  ]);

  notes = document.createElement('div');
  notes.className = 'bb-result__notes';

  // 注記は値の下、スウォッチの右側に置く。パネルの下に敷くと、注記の増減で
  // パネルの高さが変わってページ全体が動いてしまう。
  const side = document.createElement('div');
  side.className = 'bb-result__side';
  side.append(values.element, notes);

  const layout = document.createElement('div');
  layout.className = 'bb-result__layout';
  layout.append(swatch, side);

  section.append(layout);
  return section;
}

function buildModePanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'radio-group-row';

  modeGroups = [
    createRadioGroup<ChartScale>(
      'chart-scale',
      'スペクトル図の縦軸',
      [
        {
          value: 'peak',
          label: 'ピーク正規化',
          hint: '各温度の曲線を自身のピークで割る。形だけを見るので、ピークが可視域を横切っていく様子が追いやすい。',
        },
        {
          value: 'log',
          label: '対数目盛(絶対値)',
          hint: '分光放射輝度そのもの。曲線が交差せず高温が常に上に来る = どの波長でも高温の方が明るい。',
        },
      ],
      () => state.chartScale,
      (value) => {
        state.chartScale = value;
        render();
      },
    ),
    createRadioGroup<NormalizeMode>(
      'brightness-mode',
      '明るさの決め方',
      [
        {
          value: 'max',
          label: '最大成分正規化',
          hint: 'どの温度も同じ明るさで表示する。色相の比較に向く。',
        },
        {
          value: 'luminance',
          label: '相対輝度',
          hint: '放射の総量を揃えたときの見かけの明るさ。約 6600K で最大になり、両側で暗くなる。',
        },
      ],
      () => state.brightness,
      (value) => {
        state.brightness = value;
        render();
      },
    ),
  ];

  panel.append(...modeGroups.map((group) => group.element));
  return panel;
}

function buildChartPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = 'スペクトル(破線はウィーンの変位則が与えるピーク波長)';

  chart = new SpectrumChart();

  section.append(label, chart.element);
  return section;
}

// --- 描画 --------------------------------------------------------------------

function renderNotes(color: ColorResult): void {
  const messages: string[] = [];

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
      paragraph.className = 'bb-result__note';
      paragraph.textContent = message;
      return paragraph;
    }),
  );
}

function render(): void {
  const { temperatureK } = state;
  const color = colorAt(temperatureK, state.brightness);

  slider.value = String(Math.round(temperatureToPosition(temperatureK) * SLIDER_STEPS));
  if (document.activeElement !== numberInput) {
    numberInput.value = String(temperatureK);
  }

  swatch.style.backgroundColor = color.hex;

  const [r, g, b] = color.rgb8;
  values.set('rgb', `R ${r} / G ${g} / B ${b}`, `rgb(${r}, ${g}, ${b})`);
  values.set('hex', color.hex);

  const linear = color.linearRGB.map((v) => v.toFixed(4));
  values.set('linear', linear.join(' / '), linear.join(', '));

  const efficacy = luminousEfficacy(temperatureK);
  values.set('efficacy', `${efficacy.toFixed(2)} lm/W`, efficacy.toFixed(4));

  renderNotes(color);
  for (const group of modeGroups) group.sync();

  temperatureBar?.setMarkers([{ value: temperatureK }]);
  // 図の曲線は常に最大成分正規化の色で描く。相対輝度だと低温で見えなくなる。
  chart?.setState({
    temperatureK,
    scale: state.chartScale,
    curveColor: xyzToColor(blackbodyXYZ(temperatureK), 'max').hex,
  });
}

// --- ライフサイクル -----------------------------------------------------------

export function mount(root: HTMLElement): void {
  const container = document.createElement('div');
  container.className = 'bb';

  const lead = document.createElement('p');
  lead.className = 'bb__lead';
  lead.textContent =
    '温度だけで分光分布が決まる理想的な放射体(黒体)の色を求めます。分布はプランクの法則 B_λ = (2hc²/λ⁵)/(exp(hc/λkT) − 1) で与えられ、これを等色関数で積分して三刺激値を得ています。温度を変えても放射の総量が変わらないよう正規化してあるので、明るさの違いはそのまま「放射のうちどれだけが可視域に落ちるか」の違いです。なお実在の光源のうち、この形の分布に近いのは白熱電球や星のように熱で光るものだけで、蛍光灯や LED のスペクトルはまったく違う形をしています。';

  // 並び順の意図: スライダーを動かしながらスペクトル図の変化を見たいので、
  // 操作するもの(プリセット・温度・色温度帯)を上に固め、その直後に図を置く。
  // 図より下は、動かしている最中に視線を送らなくても困らないものだけにしてある。
  container.append(
    lead,
    buildPresetPanel(),
    buildTemperatureControl(),
    buildBarPanel(),
    buildChartPanel(),
    buildResultPanel(),
    buildModePanel(),
  );
  root.append(container);

  render();
  // DOM に入って幅が確定してから描く(ResizeObserver の初回通知には頼らない)。
  temperatureBar?.refresh();
  chart?.refresh();
}

export function unmount(): void {
  temperatureBar?.destroy();
  temperatureBar = null;
  chart?.destroy();
  chart = null;
  values.destroy();
  modeGroups = [];
}
