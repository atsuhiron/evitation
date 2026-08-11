/**
 * トップページのメニュー。
 *
 * 項目はレジストリから生成するので、シミュレータが増減してもこのファイルは変わらない。
 */

import { sims } from '../sims/registry.ts';

export function renderMenu(container: HTMLElement): void {
  const lead = document.createElement('p');
  lead.className = 'menu-lead';
  lead.textContent = 'シミュレータを選んでください。';

  const list = document.createElement('ul');
  list.className = 'menu-list';

  for (const sim of sims) {
    const item = document.createElement('li');

    const card = document.createElement('a');
    card.className = 'menu-card';
    card.href = `#/${sim.id}`;

    const title = document.createElement('span');
    title.className = 'menu-card__title';
    title.textContent = sim.title;

    const description = document.createElement('span');
    description.className = 'menu-card__description';
    description.textContent = sim.description;

    card.append(title, description);
    item.append(card);
    list.append(item);
  }

  container.append(lead, list);
}
