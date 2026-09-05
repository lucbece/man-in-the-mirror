import { h } from '../dom.js';
import { t } from '../i18n.js';
import { SettingsForm } from '../form.js';

/**
 * Instructions: the list of things the people in the call have taught the
 * bot, edited here exactly as it is edited by voice — see
 * `src/agent/instructions.js`, which is what actually enforces the limits
 * below and what `/api/config` validates against. Below it, the notebook:
 * what the bot has learned about the group between calls, the same list
 * shape with its own limits (`src/agent/notebook.js`).
 *
 * Browser code cannot import a server module, so the two limits are copied
 * by hand. `test/panel-limits.test.js` reads this file as text and fails if
 * the numbers here drift from the real `MAX_INSTRUCTIONS` and
 * `MAX_INSTRUCTION_CHARS` exported there.
 */
const MAX_INSTRUCTIONS = 20;
const MAX_INSTRUCTION_CHARS = 300;
/** Same arrangement for the notebook: `src/agent/notebook.js` is the source of truth. */
const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 200;

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

/**
 * One editable list of lines: the add row, the items with their remove
 * buttons, the count-and-limit help line. Used twice, for the instructions
 * and for the notebook, which differ only in key, limits and words.
 */
function listEditor({ prefix, key, max, maxChars, onChange }) {
  const emptyRow = h('div.empty', t(`${prefix}.empty`));
  const addInput = h('input.input', {
    type: 'text',
    placeholder: t(`${prefix}.add.placeholder`),
    autocomplete: 'off',
  });
  const addBtn = h('button.btn', { type: 'button' }, t(`${prefix}.add.button`));
  const addRow = h('div.add', addInput, addBtn);
  const list = h('div.list', emptyRow, addRow);
  const helpLine = h('p.help');

  function makeItem(raw) {
    const text = h('div.text', { contenteditable: 'true' });
    text.append(renderText(raw));
    const remove = h('button.remove', { type: 'button', 'aria-label': t(`${prefix}.remove`) }, '×');
    const item = h('div.item', text, remove);

    remove.addEventListener('click', () => {
      item.remove();
      afterChange();
    });
    text.addEventListener('keydown', (event) => {
      // One line per entry: Enter finishes editing rather than starting a
      // second one inside the same item.
      if (event.key === 'Enter') {
        event.preventDefault();
        text.blur();
      }
    });
    text.addEventListener('input', () => onChange());
    return item;
  }

  function items() {
    return [...list.querySelectorAll(':scope > .item')];
  }

  /** After add/remove, which no input event covers on its own — typing does. */
  function afterChange() {
    onChange();
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

  /** Marks what is over a limit and says so; returns whether all is well. */
  function validate() {
    const rows = items();
    let overChars = false;
    for (const item of rows) {
      const textEl = item.querySelector('.text');
      const invalid = textEl.textContent.length > maxChars;
      if (invalid) {
        textEl.setAttribute('aria-invalid', 'true');
        overChars = true;
      } else {
        textEl.removeAttribute('aria-invalid');
      }
    }
    const count = rows.length;
    const overCount = count > max;
    const bad = overChars || overCount;

    helpLine.classList.toggle('error', bad);
    if (overChars) helpLine.textContent = t(`${prefix}.help.overChars`, { max: maxChars });
    else if (overCount) helpLine.textContent = t(`${prefix}.help.overCount`, { n: count, max });
    else helpLine.textContent = t(`${prefix}.help`, { n: count, max });

    emptyRow.hidden = count > 0;
    return !bad;
  }

  function read() {
    const rows = items()
      .map((item) => serialiseText(item.querySelector('.text')).trim())
      .filter(Boolean);
    return { [key]: rows.join('\n') };
  }

  function write(cfg) {
    for (const item of items()) item.remove();
    for (const raw of splitLines(cfg[key])) list.insertBefore(makeItem(raw), addRow);
    validate();
  }

  return { list, helpLine, read, write, validate };
}

export function mount(root) {
  let saveBtn = null;
  const refresh = () => {
    const ok = instructions.validate() && notebook.validate();
    if (saveBtn) saveBtn.disabled = !ok;
  };

  const instructions = listEditor({
    prefix: 'instructions',
    key: 'customInstructions',
    max: MAX_INSTRUCTIONS,
    maxChars: MAX_INSTRUCTION_CHARS,
    onChange: refresh,
  });
  const notebook = listEditor({
    prefix: 'notebook',
    key: 'notebook',
    max: MAX_NOTES,
    maxChars: MAX_NOTE_CHARS,
    onChange: refresh,
  });

  root.append(
    h('header', h('p', t('instructions.intro'))),
    h('div.card', instructions.list, instructions.helpLine),
    h(
      'div.card',
      h('div.head', h('h2', t('notebook.title')), h('span.meta', t('notebook.note'))),
      notebook.list,
      notebook.helpLine,
    ),
  );

  const form = new SettingsForm({
    section: root,
    read: () => ({ ...instructions.read(), ...notebook.read() }),
    write: (cfg) => {
      instructions.write(cfg);
      notebook.write(cfg);
      refresh();
    },
  });
  saveBtn = form.bar.querySelector('.btn.primary');

  return {
    update(state) {
      form.update(state.config);
    },
  };
}
