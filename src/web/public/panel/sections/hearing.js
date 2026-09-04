import { h } from '../dom.js';
import { t } from '../i18n.js';

/** Placeholder until package P5 builds this section against docs/design/panel.md. */
export function mount(root) {
  root.append(h('div.card', h('p.help', t('section.soon'))));
  return { update() {} };
}
