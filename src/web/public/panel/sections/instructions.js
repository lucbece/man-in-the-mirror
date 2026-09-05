import { h } from '../dom.js';
import { t } from '../i18n.js';
import { SettingsForm } from '../form.js';

/**
 * Instructions: the list of things the people in the call have taught the
 * bot, edited here exactly as it is edited by voice — see
 * `src/agent/instructions.js`, which is what actually enforces the limits
 * below and what `/api/config` validates against.
 *
 * Browser code cannot import a server module, so the two limits are copied
 * by hand. `test/panel-limits.test.js` reads this file as text and fails if
 * the numbers here drift from the real `MAX_INSTRUCTIONS` and
 * `MAX_INSTRUCTION_CHARS` exported there.
 */
const MAX_INSTRUCTIONS = 20;
const MAX_INSTRUCTION_CHARS = 300;

/** `<@id|Name>`, the same shape `src/agent/instructions.js` writes and reads. */
const PERSON_TOKEN = /<@(\d{1,32})\|([^<>|]*)>/g;

/** One line, stripped of a leading bullet, the way `parseInstructions` reads it. */
function splitLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
}

/** A raw line with person tokens turned into `.chip.person` nodes. */
function renderText(raw) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of raw.matchAll(PERSON_TOKEN)) {
    if (m.index > last) frag.append(document.createTextNode(raw.slice(last, m.index)));
    frag.append(h('span.chip.person', { contenteditable: 'false', data: { id: m[1] } }, m[2].trim()));
    last = m.index + m[0].length;
  }
  if (last < raw.length) frag.append(document.createTextNode(raw.slice(last)));
  return frag;
}

/**
 * The reverse: a `.text` node back to a raw line. Every chip becomes
 * `<@id|Name>` again; everything else is read as `textContent`, so no markup
 * a paste might have left behind survives.
 */
function serialiseText(container) {
  let out = '';
  for (const node of container.childNodes) {
    if (node.nodeType === 1 && node.classList.contains('chip') && node.classList.contains('person')) {
      out += `<@${node.dataset.id}|${node.textContent.trim()}>`;
    } else {
      out += node.textContent;
    }
  }
  return out;
}

export function mount(root) {
  const introText = h('p', t('instructions.intro'));

  const emptyRow = h('div.empty', t('instructions.empty'));
  const addInput = h('input.input', {
    type: 'text',
    placeholder: t('instructions.add.placeholder'),
    autocomplete: 'off',
  });
  const addBtn = h('button.btn', { type: 'button' }, t('instructions.add.button'));
  const addRow = h('div.add', addInput, addBtn);
  const list = h('div.list', emptyRow, addRow);
  const helpLine = h('p.help');

  const card = h('div.card', list, helpLine);
  root.append(h('header', introText), card);

  function makeItem(raw) {
    const text = h('div.text', { contenteditable: 'true' });
    text.append(renderText(raw));
    const remove = h('button.remove', { type: 'button', 'aria-label': t('instructions.remove') }, '×');
    const item = h('div.item', text, remove);

    remove.addEventListener('click', () => {
      item.remove();
      afterChange();
    });
    text.addEventListener('keydown', (event) => {
      // One line per instruction: Enter finishes editing rather than
      // starting a second one inside the same item.
      if (event.key === 'Enter') {
        event.preventDefault();
        text.blur();
      }
    });
    text.addEventListener('input', validate);
    return item;
  }

  function items() {
    return [...list.querySelectorAll(':scope > .item')];
  }

  /** After add/remove, which no input event covers on its own — typing does. */
  function afterChange() {
    validate();
    list.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function addFromInput() {
    const raw = addInput.value.replace(/\s+/g, ' ').trim();
    if (!raw) return;
    list.insertBefore(makeItem(raw), addRow);
    addInput.value = '';
    afterChange();
  }
  addBtn.addEventListener('click', addFromInput);
  addInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addFromInput();
    }
  });

  let saveBtn = null;

  function validate() {
    const rows = items();
    let overChars = false;
    for (const item of rows) {
      const textEl = item.querySelector('.text');
      const invalid = textEl.textContent.length > MAX_INSTRUCTION_CHARS;
      if (invalid) {
        textEl.setAttribute('aria-invalid', 'true');
        overChars = true;
      } else {
        textEl.removeAttribute('aria-invalid');
      }
    }
    const count = rows.length;
    const overCount = count > MAX_INSTRUCTIONS;
    const bad = overChars || overCount;

    helpLine.classList.toggle('error', bad);
    if (overChars) helpLine.textContent = t('instructions.help.overChars', { max: MAX_INSTRUCTION_CHARS });
    else if (overCount) helpLine.textContent = t('instructions.help.overCount', { n: count, max: MAX_INSTRUCTIONS });
    else helpLine.textContent = t('instructions.help', { n: count, max: MAX_INSTRUCTIONS });

    if (saveBtn) saveBtn.disabled = bad;
    emptyRow.hidden = count > 0;
    return !bad;
  }

  function read() {
    const rows = items()
      .map((item) => serialiseText(item.querySelector('.text')).trim())
      .filter(Boolean);
    return { customInstructions: rows.join('\n') };
  }

  function write(cfg) {
    for (const item of items()) item.remove();
    for (const raw of splitLines(cfg.customInstructions)) list.insertBefore(makeItem(raw), addRow);
    validate();
  }

  const form = new SettingsForm({ section: root, read, write });
  saveBtn = form.bar.querySelector('.btn.primary');

  return {
    update(state) {
      form.update(state.config);
    },
  };
}
