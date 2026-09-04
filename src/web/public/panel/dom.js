/**
 * The few DOM helpers the panel needs. No framework: a settings page is a
 * DOM problem, and `h` is the whole of what a template would give it.
 */

/**
 * `h('button.btn.primary', { onclick }, 'Save')`: a tag with optional
 * `.classes`, attributes, and children. `on*` keys are listeners, `data`
 * is a dataset object, booleans set or clear the attribute, and children
 * may be strings, nodes, arrays or null.
 */
export function h(selector, attrs = {}, ...children) {
  const [tag, ...classes] = selector.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'data') Object.assign(el.dataset, value);
      else if (key === 'value' || key === 'checked' || key === 'selected' || key === 'disabled' || key === 'hidden') el[key] = value;
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  } else {
    children.unshift(attrs);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** An inline SVG icon from a path list, in currentColor. */
export function icon(paths, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

let toastEl = null;
let toastTimer = null;

/** One toast at a time, bottom centre, gone after three seconds. */
export function toast(message, kind = 'ok') {
  if (!toastEl) {
    toastEl = h('div.toast', { role: 'status' });
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.dataset.kind = kind;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
}

/** Seconds as people say them: 90 → "1.5 min", 45 → "45 s". */
export function describeSeconds(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const mins = seconds / 60;
  return `${Number.isInteger(mins) ? mins : mins.toFixed(1)} min`;
}

export const ms = (value) => (typeof value === 'number' ? `${(value / 1000).toFixed(1)} s` : '—');
