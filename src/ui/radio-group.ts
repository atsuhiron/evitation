/**
 * ラジオボタン群(共有コンポーネント)。
 *
 * 「見出し + 選択肢ごとに 見出し行と説明行」という形は 3 ページで共通なので、
 * ここにまとめてある。選択肢の説明を必ず添えるのは、どのモードが何を意味するかを
 * 画面上で完結させるため。
 */

import './radio-group.css';

export interface RadioGroupOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint: string;
}

export interface RadioGroup {
  readonly element: HTMLElement;
  /**
   * 選択状態を現在値に合わせ直す。
   * プリセットなど、ラジオ以外の操作で値が変わったときに呼ぶ。
   */
  sync(): void;
}

/**
 * @param name  同じ群のラジオをまとめる name 属性。ページ内で一意にすること。
 * @param current 現在値を返す関数。sync() のたびに評価される。
 */
export function createRadioGroup<T extends string>(
  name: string,
  legend: string,
  options: readonly RadioGroupOption<T>[],
  current: () => T,
  onChange: (value: T) => void,
): RadioGroup {
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'radio-group';

  const caption = document.createElement('legend');
  caption.className = 'field-label';
  caption.textContent = legend;
  fieldset.append(caption);

  const radios: HTMLInputElement[] = [];

  for (const option of options) {
    const wrapper = document.createElement('label');
    wrapper.className = 'radio-group__option';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = option.value;
    radio.checked = current() === option.value;
    radio.addEventListener('change', () => {
      if (radio.checked) onChange(option.value);
    });
    radios.push(radio);

    const text = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'radio-group__title';
    title.textContent = option.label;
    const hint = document.createElement('span');
    hint.className = 'radio-group__hint';
    hint.textContent = option.hint;
    text.append(title, hint);

    wrapper.append(radio, text);
    fieldset.append(wrapper);
  }

  return {
    element: fieldset,
    sync(): void {
      const value = current();
      for (const radio of radios) {
        radio.checked = radio.value === value;
      }
    },
  };
}
