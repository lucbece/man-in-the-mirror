/**
 * Which section is on screen. The hash names it (`#thinking`), the sidebar
 * reflects it, and the last one is remembered so the panel reopens where it
 * was left. `mitm.tab` is the key the previous panel used; kept so the
 * preview script's `?tab=` keeps working.
 */
const KEY = 'mitm.tab';

export function createRouter({ sections, onChange }) {
  const ids = Object.keys(sections);
  let current = null;

  function wanted() {
    const fromHash = location.hash.replace(/^#\/?/, '');
    if (ids.includes(fromHash)) return fromHash;
    try {
      const stored = localStorage.getItem(KEY);
      if (ids.includes(stored)) return stored;
    } catch {
      // No storage, no memory of the last section.
    }
    return ids[0];
  }

  function apply() {
    const id = wanted();
    if (id === current) return;
    current = id;
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // Fine.
    }
    for (const a of document.querySelectorAll('.nav a.item')) {
      if (a.dataset.section === id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    // A cross-fade where the browser has it; otherwise the swap alone.
    if (document.startViewTransition) document.startViewTransition(() => onChange(id));
    else onChange(id);
  }

  window.addEventListener('hashchange', apply);
  apply();

  return {
    get current() {
      return current;
    },
    go(id) {
      location.hash = `#${id}`;
    },
  };
}
