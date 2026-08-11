/**
 * ハッシュルータ。
 *
 * `#/` でメニュー、`#/<id>` で該当シミュレータ。ハッシュを使うのは、
 * 静的ホスティングにそのまま置けてサーバ側の rewrite 設定が要らないから。
 */

import { findSim, type SimDefinition, type SimModule } from './sims/registry.ts';
import { renderMenu } from './ui/menu.ts';

const MENU_HASH = '#/';

interface Shell {
  readonly header: HTMLElement;
  readonly view: HTMLElement;
}

/** 現在マウントされているシミュレータ。遷移時に unmount するために保持する。 */
let mounted: SimModule | null = null;

/**
 * 非同期ロード中に別の遷移が起きたときに、古い結果を捨てるためのトークン。
 * これが無いと、遅れて解決した import が新しい画面を上書きしてしまう。
 */
let navigationToken = 0;

function buildShell(app: HTMLElement): Shell {
  app.replaceChildren();

  const header = document.createElement('header');
  header.className = 'app-header';

  const view = document.createElement('main');
  view.className = 'app-view';

  app.append(header, view);
  return { header, view };
}

function renderHeader(header: HTMLElement, sim: SimDefinition | null): void {
  header.replaceChildren();

  if (sim === null) {
    const title = document.createElement('h1');
    title.className = 'app-title';
    title.textContent = '物理光学シミュレータ';
    header.append(title);
    return;
  }

  const back = document.createElement('a');
  back.className = 'back-link';
  back.href = MENU_HASH;
  back.textContent = '← メニュー';

  const title = document.createElement('h1');
  title.className = 'app-title app-title--sim';
  title.textContent = sim.title;

  header.append(back, title);
}

function parseHash(hash: string): string | null {
  const match = /^#\/([\w-]+)\/?$/.exec(hash);
  return match?.[1] ?? null;
}

function unmountCurrent(): void {
  if (mounted === null) return;
  try {
    mounted.unmount?.();
  } catch (error) {
    // unmount の失敗で遷移全体を止めたくはないが、握り潰すと
    // リスナのリークに気付けなくなるのでログには残す。
    console.error('シミュレータの unmount に失敗しました', error);
  }
  mounted = null;
}

function showError(view: HTMLElement, sim: SimDefinition, error: unknown): void {
  view.replaceChildren();
  const box = document.createElement('div');
  box.className = 'load-error';
  box.textContent = `「${sim.title}」の読み込みに失敗しました: ${String(error)}`;
  view.append(box);
}

async function navigate(shell: Shell): Promise<void> {
  const token = ++navigationToken;
  const id = parseHash(location.hash);
  const sim = id === null ? undefined : findSim(id);

  unmountCurrent();

  // 未知の id はメニューへ戻す。hash を書き換えると hashchange が再発火し、
  // このあとメニューが描画される。
  if (id !== null && sim === undefined) {
    location.hash = MENU_HASH;
    return;
  }

  if (sim === undefined) {
    renderHeader(shell.header, null);
    shell.view.replaceChildren();
    renderMenu(shell.view);
    return;
  }

  renderHeader(shell.header, sim);
  shell.view.replaceChildren();

  let module: SimModule;
  try {
    module = await sim.load();
  } catch (error) {
    if (token !== navigationToken) return;
    showError(shell.view, sim, error);
    return;
  }

  // ロード中に別の画面へ遷移していたら、この結果は捨てる。
  if (token !== navigationToken) return;

  mounted = module;
  module.mount(shell.view);
}

export function startRouter(app: HTMLElement): void {
  const shell = buildShell(app);

  if (location.hash === '') {
    location.hash = MENU_HASH;
  }

  window.addEventListener('hashchange', () => {
    void navigate(shell);
  });
  void navigate(shell);
}
