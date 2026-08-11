/**
 * シミュレータの一覧。
 *
 * ここがシミュレータ定義の唯一の出どころで、トップページのメニューもルータも
 * この配列から組み立てられる。シミュレータを 1 本増やすときにやることは
 *
 *   1. src/sims/<id>/index.ts を作り mount / unmount を export する
 *   2. この配列に 1 要素足す
 *
 * の 2 つだけ。メニュー側には手を入れない。
 */

/** 各シミュレータが満たすべきインタフェース。 */
export interface SimModule {
  /** 与えられた要素の中に UI を構築する。要素は空の状態で渡される。 */
  mount(root: HTMLElement): void;
  /**
   * 画面から離れるときに呼ばれる。DOM そのものはルータ側が破棄するので、
   * ここで解除すべきなのは DOM の外にぶら下がるもの
   * (window のイベント、ResizeObserver、requestAnimationFrame、タイマー等)。
   */
  unmount?(): void;
}

export interface SimDefinition {
  /** URL ハッシュに使う識別子。`#/<id>` でこのシミュレータが開く。 */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /**
   * 動的 import。ここを遅延させておくことで、シミュレータが増えても
   * トップページの初期ロードは太らない。将来 wasm を使うシミュレータを
   * 足しても、そのページを開くまで wasm はフェッチされない。
   */
  readonly load: () => Promise<SimModule>;
}

export const sims: readonly SimDefinition[] = [
  {
    id: 'monochromatic',
    title: '単色光の色',
    description:
      '可視光の波長を指定すると、CIE 1931 等色関数を通してその単色光に対応する sRGB の色を求める。',
    load: () => import('./monochromatic/index.ts'),
  },
  {
    id: 'mixture',
    title: '単色光の合成',
    description:
      '複数の単色光を重ね合わせたときの色を求める。3 本の単色光から白ができること、単一の波長では作れない色があることがわかる。',
    load: () => import('./mixture/index.ts'),
  },
];

export function findSim(id: string): SimDefinition | undefined {
  return sims.find((s) => s.id === id);
}
