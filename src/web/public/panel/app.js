/**
 * The panel: a sidebar of sections, one on screen at a time, fed by a poll of
 * `/api/state` every two seconds. Each section is a module under `sections/`
 * exporting `mount(root, ctx)` and returning `{ update(state) }`.
 */
import { h } from './dom.js';
import { api } from './api.js';
import { t, applyStatic, currentLang, setLang, onLangChange } from './i18n.js';
import { createRouter } from './router.js';

import * as now from './sections/now.js';
import * as discord from './sections/discord.js';
import * as keys from './sections/keys.js';
import * as hearing from './sections/hearing.js';
import * as listening from './sections/listening.js';
import * as thinking from './sections/thinking.js';
import * as instructions from './sections/instructions.js';
import * as tools from './sections/tools.js';
import * as speaking from './sections/speaking.js';

const sections = { now, discord, keys, hearing, listening, thinking, instructions, tools, speaking };

const els = {
  title: document.getElementById('title'),
  status: document.getElementById('status'),
  section: document.getElementById('section'),
  topbarActions: document.getElementById('topbarActions'),
  version: document.getElementById('version'),
};

let state = null;
let current = null; // { id, view }

// --- theme -----------------------------------------------------------------------

const THEME_KEY = 'mitm.theme';
const THEMES = ['auto', 'dark', 'light'];

function currentTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (THEMES.includes(stored)) return stored;
  } catch {
    // No storage: the system decides.
  }
  return 'auto';
}

function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function setTheme(theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Applied, not remembered.
  }
  for (const input of document.querySelectorAll('input[name^="theme-"]')) input.checked = input.value === theme;
}

function themeToggle(container) {
  const name = `theme-${container.id}`;
  for (const theme of THEMES) {
    const input = h('input', { type: 'radio', name, value: theme, checked: theme === currentTheme() });
    input.addEventListener('change', () => input.checked && setTheme(theme));
    container.append(h('label', input, h('span', { data: { t: `theme.${theme}` } }, t(`theme.${theme}`))));
  }
}
applyTheme(currentTheme());
themeToggle(document.getElementById('themeNav'));
const themeTop = document.getElementById('themeTop');
themeToggle(themeTop);

// --- language -----------------------------------------------------------------

function langToggle(container) {
  const name = `lang-${container.id}`;
  for (const code of ['en', 'es']) {
    const input = h('input', { type: 'radio', name, value: code, checked: code === currentLang() });
    input.addEventListener('change', () => input.checked && setLang(code));
    container.append(h('label', input, code.toUpperCase()));
  }
}
langToggle(document.getElementById('langNav'));
const langTop = document.getElementById('langTop');
langToggle(langTop);
const narrow = matchMedia('(max-width: 900px)');
const placeLang = () => {
  langTop.hidden = !narrow.matches;
  themeTop.hidden = !narrow.matches;
};
narrow.addEventListener('change', placeLang);
placeLang();

// --- the section on screen -------------------------------------------------------

function show(id) {
  els.section.replaceChildren();
  els.topbarActions.replaceChildren();
  els.title.textContent = t(`nav.${id}`);
  const view = sections[id].mount(els.section, { refresh, topbarActions: els.topbarActions });
  current = { id, view };
  if (state) view.update(state);
}

const router = createRouter({ sections, onChange: show });

onLangChange(() => {
  for (const input of document.querySelectorAll('.seg.small input[type=radio]')) {
    input.checked = input.value === currentLang();
  }
  show(router.current); // sections build their text at mount
});

// --- status -----------------------------------------------------------------------

function renderStatus(bot, sessions) {
  const label = els.status.querySelector('.label');
  const states = { ready: 'ok', starting: 'busy', stopped: '', error: 'error' };
  els.status.dataset.state = states[bot.state] ?? '';
  if (bot.state === 'ready') {
    const inCall = sessions?.[0]?.channelName;
    label.textContent = inCall ? t('bot.readyIn', { channel: inCall }) : t('bot.ready', { tag: bot.user?.tag ?? '' });
  } else if (bot.state === 'error') {
    label.textContent = t('bot.error', { message: bot.error ?? '' });
  } else {
    label.textContent = t(`bot.${bot.state}`);
  }
}

// --- polling -----------------------------------------------------------------------

async function refresh() {
  let next;
  try {
    next = await api('/api/state');
  } catch {
    els.status.querySelector('.label').textContent = t('bot.offline');
    els.status.dataset.state = 'error';
    return;
  }
  state = next;
  try {
    renderStatus(next.bot, next.sessions);
    if (next.version) els.version.textContent = `v${next.version}`;
    current?.view.update(next);
  } catch (err) {
    console.error('[panel] render failed:', err);
  }
}

applyStatic(document);
refresh();
setInterval(refresh, 2000);
