/**
 * Every visible string, in two languages. Markup carries a `data-t` attribute for
 * static text and scripts call `t(key, vars)` for the rest; nothing is
 * written into the page directly. The two tables must have the same keys,
 * and a test says so.
 */
import en from './strings/en.js';
import es from './strings/es.js';

const TABLES = { en, es };
const KEY = 'mitm.lang';
const listeners = new Set();

function detect() {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && TABLES[stored]) return stored;
  } catch {
    // Storage may be unavailable; the browser's language decides.
  }
  return /^es\b/i.test(navigator.language ?? '') ? 'es' : 'en';
}

let lang = detect();
document.documentElement.lang = lang;

export function t(key, vars = {}) {
  const template = TABLES[lang][key] ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

export const currentLang = () => lang;

export function setLang(next) {
  if (!TABLES[next] || next === lang) return;
  lang = next;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // Not remembered, still applied.
  }
  applyStatic(document);
  for (const fn of listeners) fn(lang);
}

export const onLangChange = (fn) => listeners.add(fn);

/** Fills every `data-t` and `data-t-placeholder` under `root`. */
export function applyStatic(root) {
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of root.querySelectorAll('[data-t-placeholder]')) el.placeholder = t(el.dataset.tPlaceholder);
  for (const el of root.querySelectorAll('[data-t-title]')) el.title = t(el.dataset.tTitle);
}
