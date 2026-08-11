/**
 * 単色光の合成シミュレータ。
 *
 * 複数の単色光を重ね合わせた光の色を求める。合成そのものは
 * XYZ = Σ Iᵢ·cmf(λᵢ) という単なる線形和(グラスマンの法則)で、
 * 面白いのはその帰結のほう — 3 本の単色光から白ができること、
 * そして 2 本から「どの単一波長でも作れない色」ができること。
 */

import './mixture.css';
import {
  spectralLinesToXYZ,
  VISIBLE_LAMBDA_MAX,
  VISIBLE_LAMBDA_MIN,
  wavelengthToColor,
  xyzToColor,
  type NormalizeMode,
} from '../../color/index.ts';
import { SpectrumBar } from '../../ui/spectrum-bar.ts';
import { ValueList } from '../../ui/value-list.ts';
import {
  INTENSITY_DIGITS,
  INTENSITY_STEP,
  toRadianceLines,
  type IntensityBasis,
} from './intensity.ts';
import { defaultPreset, presets, type Preset } from './presets.ts';

const MAX_COMPONENTS = 6;
const MIN_COMPONENTS = 1;

interface Component {
  /** DOM の作り直しをまたいで行を識別するための番号。 */
  id: number;
  lambdaNm: number;
  intensity: number;
}

interface State {
  components: Component[];
  basis: IntensityBasis;
  brightness: NormalizeMode;
}

let nextComponentId = 0;

function componentsFromPreset(preset: Preset): Component[] {
  return preset.components.map((c) => ({
    id: nextComponentId++,
    lambdaNm: c.lambdaNm,
    intensity: c.intensity,
  }));
}

const state: State = {
  components: componentsFromPreset(defaultPreset),
  basis: defaultPreset.basis,
  brightness: 'max',
};

let spectrumBar: SpectrumBar | null = null;
let values: ValueList;

// mount 時に組み立て、render で中身を書き替える要素。
let componentList: HTMLElement;
let addButton: HTMLButtonElement;
let swatch: HTMLElement;
let notes: HTMLElement;
let rows: ComponentRow[] = [];

// --- 成分の行 -----------------------------------------------------------------

interface ComponentRow {
  readonly element: HTMLElement;
  /** state に合わせて色チップと入力欄を描き替える。 */
  update(): void;
}

function buildComponentRow(component: Component): ComponentRow {
  const item = document.createElement('li');
  item.className = 'mix-row';

  const chip = document.createElement('span');
  chip.className = 'mix-row__chip';

  const lambdaSlider = document.createElement('input');
  lambdaSlider.type = 'range';
  lambdaSlider.className = 'mix-row__slider';
  lambdaSlider.min = String(VISIBLE_LAMBDA_MIN);
  lambdaSlider.max = String(VISIBLE_LAMBDA_MAX);
  lambdaSlider.step = '1';
  lambdaSlider.setAttribute('aria-label', '波長 (nm)');

  const lambdaNumber = document.createElement('input');
  lambdaNumber.type = 'number';
  lambdaNumber.className = 'mix-row__number';
  lambdaNumber.min = String(VISIBLE_LAMBDA_MIN);
  lambdaNumber.max = String(VISIBLE_LAMBDA_MAX);
  lambdaNumber.step = '1';
  lambdaNumber.setAttribute('aria-label', '波長 (nm)');

  const intensitySlider = document.createElement('input');
  intensitySlider.type = 'range';
  intensitySlider.className = 'mix-row__slider';
  intensitySlider.min = '0';
  intensitySlider.max = '1';
  intensitySlider.step = String(INTENSITY_STEP);
  intensitySlider.setAttribute('aria-label', '強度');

  const intensityNumber = document.createElement('input');
  intensityNumber.type = 'number';
  intensityNumber.className = 'mix-row__number';
  intensityNumber.min = '0';
  intensityNumber.max = '1';
  intensityNumber.step = String(INTENSITY_STEP);
  intensityNumber.setAttribute('aria-label', '強度');

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'mix-row__remove';
  remove.textContent = '×';
  remove.title = 'この成分を削除';
  remove.setAttribute('aria-label', 'この成分を削除');

  const update = (): void => {
    lambdaSlider.value = String(component.lambdaNm);
    if (document.activeElement !== lambdaNumber) {
      lambdaNumber.value = String(component.lambdaNm);
    }
    intensitySlider.value = String(component.intensity);
    if (document.activeElement !== intensityNumber) {
      intensityNumber.value = component.intensity.toFixed(INTENSITY_DIGITS);
    }
    // チップはその成分の単独の色。強度ではなく波長だけを反映する
    // (強度 0 でも「何色の光か」は見えていてほしいので)。
    chip.style.backgroundColor = wavelengthToColor(component.lambdaNm, 'max').hex;
    remove.disabled = state.components.length <= MIN_COMPONENTS;
  };

  const setLambda = (value: number): void => {
    const clamped = Math.min(VISIBLE_LAMBDA_MAX, Math.max(VISIBLE_LAMBDA_MIN, Math.round(value)));
    if (clamped === component.lambdaNm) return;
    component.lambdaNm = clamped;
    update();
    renderResult();
  };

  const setIntensity = (value: number): void => {
    const clamped = Math.min(1, Math.max(0, value));
    if (clamped === component.intensity) return;
    component.intensity = clamped;
    update();
    renderResult();
  };

  lambdaSlider.addEventListener('input', () => setLambda(Number(lambdaSlider.value)));
  intensitySlider.addEventListener('input', () => setIntensity(Number(intensitySlider.value)));

  // 数値入力は打ち込み途中の値も反映するが、範囲外や空欄をその場で書き戻さない
  // (入力中に勝手に値が変わると打ちづらいため)。確定時に丸めた値を反映する。
  for (const [input, apply] of [
    [lambdaNumber, setLambda],
    [intensityNumber, setIntensity],
  ] as const) {
    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (input.value !== '' && Number.isFinite(value)) apply(value);
    });
    input.addEventListener('change', update);
    input.addEventListener('blur', update);
  }

  remove.addEventListener('click', () => {
    if (state.components.length <= MIN_COMPONENTS) return;
    state.components = state.components.filter((c) => c.id !== component.id);
    renderComponents();
    renderResult();
  });

  const lambdaField = document.createElement('div');
  lambdaField.className = 'mix-row__field';
  lambdaField.append(labelled('λ', lambdaSlider, lambdaNumber, 'nm'));

  const intensityField = document.createElement('div');
  intensityField.className = 'mix-row__field';
  intensityField.append(labelled('I', intensitySlider, intensityNumber));

  item.append(chip, lambdaField, intensityField, remove);
  return { element: item, update };
}

function labelled(
  symbol: string,
  slider: HTMLInputElement,
  numberInput: HTMLInputElement,
  unit?: string,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'mix-row__control';

  const label = document.createElement('span');
  label.className = 'mix-row__symbol';
  label.textContent = symbol;
  label.setAttribute('aria-hidden', 'true');

  wrapper.append(label, slider, numberInput);
  if (unit !== undefined) {
    const unitLabel = document.createElement('span');
    unitLabel.className = 'mix-row__unit';
    unitLabel.textContent = unit;
    wrapper.append(unitLabel);
  }
  return wrapper;
}

// --- 部品の組み立て -----------------------------------------------------------

function buildComponentPanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'panel';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = '合成する単色光';

  componentList = document.createElement('ul');
  componentList.className = 'mix-list';

  addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'mix-add';
  addButton.textContent = '+ 成分を追加';
  addButton.addEventListener('click', () => {
    if (state.components.length >= MAX_COMPONENTS) return;
    state.components.push({ id: nextComponentId++, lambdaNm: 550, intensity: 0.5 });
    renderComponents();
    renderResult();
  });

  panel.append(label, componentList, addButton);
  return panel;
}

function buildPresetPanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'panel mix-presets';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = 'プリセット';

  const buttons = document.createElement('div');
  buttons.className = 'mix-presets__buttons';

  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mix-presets__button';
    button.textContent = preset.name;
    button.title = preset.hint;
    button.addEventListener('click', () => {
      state.components = componentsFromPreset(preset);
      state.basis = preset.basis;
      renderComponents();
      renderModes();
      renderResult();
      presetHint.textContent = preset.hint;
    });
    buttons.append(button);
  }

  const presetHint = document.createElement('p');
  presetHint.className = 'mix-presets__hint';
  presetHint.textContent = defaultPreset.hint;

  panel.append(label, buttons, presetHint);
  return panel;
}

interface RadioGroupOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint: string;
}

const radioInputs: HTMLInputElement[] = [];

function buildRadioGroup<T extends string>(
  name: string,
  legend: string,
  options: readonly RadioGroupOption<T>[],
  current: () => T,
  onChange: (value: T) => void,
): HTMLElement {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'mix-modes__group';

  const caption = document.createElement('legend');
  caption.className = 'field-label';
  caption.textContent = legend;
  fieldset.append(caption);

  for (const option of options) {
    const wrapper = document.createElement('label');
    wrapper.className = 'mix-modes__option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = option.value;
    radio.checked = current() === option.value;
    radio.addEventListener('change', () => {
      if (radio.checked) onChange(option.value);
    });
    radioInputs.push(radio);

    const text = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'mix-modes__title';
    title.textContent = option.label;
    const hint = document.createElement('span');
    hint.className = 'mix-modes__hint';
    hint.textContent = option.hint;
    text.append(title, hint);

    wrapper.append(radio, text);
    fieldset.append(wrapper);
  }

  return fieldset;
}

function buildModePanel(): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'mix-modes';

  panel.append(
    buildRadioGroup<IntensityBasis>(
      'intensity-basis',
      '強度の基準',
      [
        {
          value: 'radiance',
          label: '放射強度',
          hint: 'XYZ = Σ I·cmf(λ)。物理量そのもの。視感度の低い波長は強度を上げてもあまり明るくならない。',
        },
        {
          value: 'luminance',
          label: '輝度基準',
          hint: 'I をその成分が担う輝度とみなす。強度が同じなら同じ明るさに見える。',
        },
      ],
      () => state.basis,
      (value) => {
        state.basis = value;
        renderResult();
      },
    ),
    buildRadioGroup<NormalizeMode>(
      'brightness-mode',
      '明るさの決め方',
      [
        {
          value: 'max',
          label: '最大成分正規化',
          hint: '合成後の色相を見る。全体の明るさは問わない。',
        },
        {
          value: 'luminance',
          label: '相対輝度',
          hint: '合成後の輝度をそのまま反映する。成分を足すほど明るくなる。',
        },
      ],
      () => state.brightness,
      (value) => {
        state.brightness = value;
        renderResult();
      },
    ),
  );

  return panel;
}

function buildResultPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel mix-result';

  swatch = document.createElement('div');
  swatch.className = 'mix-result__swatch';

  values = new ValueList([
    { key: 'rgb', term: 'RGB (8bit)' },
    { key: 'hex', term: 'HEX' },
    { key: 'linear', term: 'linear RGB' },
    { key: 'luminance', term: '合成輝度 Y' },
  ]);
  values.element.classList.add('mix-result__values');

  const layout = document.createElement('div');
  layout.className = 'mix-result__layout';
  layout.append(swatch, values.element);

  notes = document.createElement('div');
  notes.className = 'mix-result__notes';

  section.append(layout, notes);
  return section;
}

function buildSpectrumPanel(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'panel';

  const label = document.createElement('p');
  label.className = 'field-label';
  label.textContent = '可視光スペクトル(縦線が各成分。高さは強度の比)';

  // onSelect は渡さない = 表示専用。成分が複数あるので、帯のどこを掴んでも
  // どの成分を動かすべきか決まらない。
  spectrumBar = new SpectrumBar({
    lambdaMin: VISIBLE_LAMBDA_MIN,
    lambdaMax: VISIBLE_LAMBDA_MAX,
  });

  section.append(label, spectrumBar.element);
  return section;
}

// --- 描画 --------------------------------------------------------------------

/** 成分の増減があったときだけ呼ぶ(行の DOM を作り直す)。 */
function renderComponents(): void {
  rows = state.components.map(buildComponentRow);
  componentList.replaceChildren(...rows.map((row) => row.element));
  for (const row of rows) row.update();
  addButton.disabled = state.components.length >= MAX_COMPONENTS;
}

/** ラジオの選択状態を state に合わせ直す(プリセットが基準を変えることがある)。 */
function renderModes(): void {
  for (const radio of radioInputs) {
    if (radio.name === 'intensity-basis') radio.checked = radio.value === state.basis;
    if (radio.name === 'brightness-mode') radio.checked = radio.value === state.brightness;
  }
}

function renderNotes(color: ReturnType<typeof xyzToColor>): void {
  notes.replaceChildren();

  const messages: string[] = [];
  if (color.outOfGamut) {
    const ratio = color.whiteAdded / (color.whiteAdded + Math.max(color.xyz[1], 1e-12));
    messages.push(
      `この色は sRGB の色域外です。表示のために白を混ぜて彩度を落としてあり(白の割合 約 ${(
        ratio * 100
      ).toFixed(0)}%)、実際にはこれよりも鮮やかな色に見えます。`,
    );
  }
  if (color.clipped) {
    messages.push(
      '合成後の輝度が表示できる上限を超えています(白飛び)。強度を下げるか、明るさの決め方を「最大成分正規化」にすると本来の色相が見えます。',
    );
  }

  for (const message of messages) {
    const paragraph = document.createElement('p');
    paragraph.className = 'mix-result__note';
    paragraph.textContent = message;
    notes.append(paragraph);
  }
}

function renderResult(): void {
  const xyz = spectralLinesToXYZ(toRadianceLines(state.components, state.basis));
  const color = xyzToColor(xyz, state.brightness);

  swatch.style.backgroundColor = color.hex;

  const [r, g, b] = color.rgb8;
  values.set('rgb', `R ${r} / G ${g} / B ${b}`, `rgb(${r}, ${g}, ${b})`);
  values.set('hex', color.hex);

  const linear = color.linearRGB.map((v) => v.toFixed(4));
  values.set('linear', linear.join(' / '), linear.join(', '));
  values.set('luminance', xyz[1].toFixed(4), xyz[1].toFixed(6));

  renderNotes(color);

  // マーカーの高さは強度の「比」。最大の成分が全高になるよう正規化する。
  const peak = Math.max(...state.components.map((c) => c.intensity), 0);
  spectrumBar?.setMarkers(
    state.components.map((c) => ({
      lambdaNm: c.lambdaNm,
      weight: peak > 0 ? c.intensity / peak : 0,
    })),
  );
}

// --- ライフサイクル -----------------------------------------------------------

export function mount(root: HTMLElement): void {
  const container = document.createElement('div');
  container.className = 'mix';

  const lead = document.createElement('p');
  lead.className = 'mix__lead';
  lead.textContent =
    '複数の単色光を重ね合わせた光の色を求めます。合成後の三刺激値は各成分の単純な和 XYZ = Σ Iᵢ·cmf(λᵢ) になります(グラスマンの法則)。線形和が成り立つのは XYZ 空間の中だけで、波長を平均しても RGB 値を足しても混色の結果にはなりません。なお、ここで足しているのは強度であって振幅ではありません — 干渉は起きないインコヒーレントな重ね合わせです。';

  container.append(
    lead,
    buildComponentPanel(),
    buildPresetPanel(),
    buildModePanel(),
    buildResultPanel(),
    buildSpectrumPanel(),
  );
  root.append(container);

  renderComponents();
  renderResult();
  // DOM に入って幅が確定してから帯を描く(ResizeObserver の初回通知には頼らない)。
  spectrumBar?.refresh();
}

export function unmount(): void {
  spectrumBar?.destroy();
  spectrumBar = null;
  values.destroy();
  rows = [];
  radioInputs.length = 0;
}
