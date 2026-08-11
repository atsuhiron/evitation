/**
 * 「項目名 : 値」を並べ、クリックで値をコピーできるリスト(共有コンポーネント)。
 *
 * どのシミュレータでも算出値を並べたくなるので、クリップボード処理ごとまとめてある。
 */

import './value-list.css';

export interface ValueListItem {
  /** set() で指すためのキー。 */
  readonly key: string;
  /** 画面に出す項目名。 */
  readonly term: string;
}

export class ValueList {
  readonly element: HTMLElement;

  private readonly buttons = new Map<string, HTMLButtonElement>();
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(items: readonly ValueListItem[]) {
    this.element = document.createElement('dl');
    this.element.className = 'value-list';

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'value-list__row';

      const term = document.createElement('dt');
      term.textContent = item.term;

      const definition = document.createElement('dd');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'value-list__value';
      button.title = 'クリックでコピー';
      button.addEventListener('click', () => {
        void this.copy(button);
      });
      definition.append(button);

      row.append(term, definition);
      this.element.append(row);
      this.buttons.set(item.key, button);
    }
  }

  /**
   * 値を書き替える。
   *
   * @param copyText コピーされる文字列。省略時は表示文字列そのもの
   *   (`R 255 / G 0 / B 0` のような読みやすい表示と、貼り付けたい形式は別物なので分けている)。
   */
  set(key: string, text: string, copyText?: string): void {
    const button = this.buttons.get(key);
    if (button === undefined) {
      throw new Error(`ValueList に未登録のキーです: ${key}`);
    }
    button.textContent = text;
    button.dataset['copy'] = copyText ?? text;
  }

  destroy(): void {
    if (this.feedbackTimer !== null) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
    }
  }

  private async copy(button: HTMLButtonElement): Promise<void> {
    const text = button.dataset['copy'] ?? button.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // クリップボードが使えない環境(非セキュアコンテキストや権限拒否)では
      // 黙って何もしない。表示自体は読めているので機能上の支障はない。
      return;
    }

    if (this.feedbackTimer !== null) clearTimeout(this.feedbackTimer);
    button.classList.add('value-list__value--copied');
    this.feedbackTimer = setTimeout(() => {
      button.classList.remove('value-list__value--copied');
      this.feedbackTimer = null;
    }, 900);
  }
}
