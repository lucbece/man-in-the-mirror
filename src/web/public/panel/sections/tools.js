import { h, toast } from '../dom.js';
import { t } from '../i18n.js';
import { SettingsForm, field, callout } from '../form.js';

/**
 * Tools: the MCP servers the agent can reach, the folders a filesystem
 * server is scoped to, and how many rounds of tool calls it gets per
 * answer.
 *
 * The panel does not import `src/agent/mcp.js` — that's server code — so
 * `serversFrom` below re-implements just enough of `parseMcpServers` to
 * drive the list: an object whose values carry a `command` or a `url`.
 * Validation of the JSON itself still matches the server's rules exactly
 * (object, not array, not null); a value that parses but has no
 * recognisable server shape is simply left out of the list rather than
 * rejected, since `mcpServers` may carry fields (like a server's own
 * `allow` list) this section never needs to touch.
 *
 * These only run in Agent and Fast-model-in-front modes. Chat mode still
 * shows the section — a server left configured there is still configured,
 * just unused — and the header says so instead of hiding anything.
 */

/** The working object behind the textarea, unwrapping a pasted config file. */
function objectFrom(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return {};
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
    return { ...parsed.mcpServers };
  }
  return { ...parsed };
}

/** Only the entries that look like an MCP server, for the list. */
function serversFrom(obj) {
  const out = {};
  for (const [name, entry] of Object.entries(obj)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const hasCommand = typeof entry.command === 'string' && entry.command.trim();
    const hasUrl = typeof entry.url === 'string' && entry.url.trim();
    if (hasCommand || hasUrl) out[name] = entry;
  }
  return out;
}

/** "command args…" for a local server, the bare URL for a remote one. */
function describeServer(entry) {
  if (typeof entry.command === 'string' && entry.command.trim()) {
    const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : [];
    return [entry.command, ...args].join(' ');
  }
  return String(entry.url ?? '');
}

export function mount(root) {
  const introText = h('p', t('tools.intro'));
  const introIdle = h('p', { hidden: true }, t('tools.intro.idle'));

  // --- the configured servers --------------------------------------------------

  const listEl = h('div.list');

  function renderList() {
    const entries = Object.entries(serversFrom(objectFrom(mcpTextarea.value)));
    listEl.replaceChildren();
    if (!entries.length) {
      listEl.append(h('div.empty', t('tools.mcp.empty')));
    } else {
      for (const [name, entry] of entries) {
        const remove = h(
          'button.remove',
          { type: 'button', 'aria-label': t('tools.mcp.remove', { name }), onclick: () => removeServer(name) },
          '×',
        );
        listEl.append(h('div.item', h('div.text', h('strong', name), ' ', h('span.help', describeServer(entry))), remove));
      }
    }
    dirsField.hidden = entries.length === 0;
  }

  function removeServer(name) {
    const obj = objectFrom(mcpTextarea.value);
    delete obj[name];
    mcpTextarea.value = Object.keys(obj).length ? JSON.stringify(obj, null, 2) : '';
    mcpTextarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // --- add from file -------------------------------------------------------------

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const addFileBtn = h('button.btn', { type: 'button', onclick: () => fileInput.click() }, t('tools.mcp.addFile'));

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      try {
        let parsed = JSON.parse(String(reader.result));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
          parsed = parsed.mcpServers;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(t('tools.mcp.notObject'));
        }
        const current = objectFrom(mcpTextarea.value);
        const added = Object.keys(parsed).length;
        Object.assign(current, parsed);
        mcpTextarea.value = JSON.stringify(current, null, 2);
        mcpTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        toast(t('tools.mcp.addFile.added', { n: added }));
      } catch (err) {
        toast(t('tools.mcp.addFile.error', { message: err.message }));
      }
    });
    reader.addEventListener('error', () => {
      toast(t('tools.mcp.addFile.error', { message: t('tools.mcp.addFile.readError') }));
    });
    reader.readAsText(file);
  });

  const addRow = h('div.row', fileInput, addFileBtn);

  // --- the JSON editor -------------------------------------------------------------

  const mcpTextarea = h('textarea.textarea', {
    name: 'mcpServers',
    rows: 8,
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const mcpHelp = h('p.help', t('tools.mcp.help'));
  const exampleMore = h(
    'details.more',
    h('summary', t('tools.mcp.example.summary')),
    h('p', t('tools.mcp.example.text')),
  );
  const editorDetails = h(
    'details.more',
    h('summary', t('tools.mcp.edit')),
    h('div.field', mcpTextarea, mcpHelp, exampleMore),
  );

  /** Empty is fine; otherwise it must parse to a plain object. */
  function validateMcp() {
    const value = mcpTextarea.value.trim();
    if (!value) {
      mcpTextarea.removeAttribute('aria-invalid');
      mcpHelp.classList.remove('error');
      mcpHelp.textContent = t('tools.mcp.help');
      return true;
    }
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(t('tools.mcp.notObject'));
      }
      mcpTextarea.removeAttribute('aria-invalid');
      mcpHelp.classList.remove('error');
      mcpHelp.textContent = t('tools.mcp.help');
      return true;
    } catch (err) {
      mcpTextarea.setAttribute('aria-invalid', 'true');
      mcpHelp.classList.add('error');
      mcpHelp.textContent = t('tools.mcp.error', { message: err.message });
      return false;
    }
  }

  function syncFromTextarea() {
    const valid = validateMcp();
    saveBtn.disabled = !valid;
    if (valid) renderList();
    return valid;
  }
  mcpTextarea.addEventListener('input', syncFromTextarea);

  // --- folders, only when a server is configured ----------------------------------

  const dirsTextarea = h('textarea.textarea', {
    name: 'agentDirectories',
    rows: 3,
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const dirsField = field({
    label: t('tools.dirs.label'),
    control: dirsTextarea,
    help: t('tools.dirs.help'),
  });

  const card = h('div.card', listEl, addRow, editorDetails, dirsField, callout(t('tools.warn'), 'warn'));

  // --- advanced: steps per answer ---------------------------------------------------

  const turnsInput = h('input.input', {
    type: 'number',
    name: 'agentMaxTurns',
    min: 1,
    max: 25,
    step: 1,
  });
  const turnsField = field({
    label: t('tools.maxTurns.label'),
    control: turnsInput,
    help: t('tools.maxTurns.help'),
  });
  const advancedCard = h('div.card', h('details.advanced', h('summary', t('tools.advanced')), turnsField));

  root.append(h('header', introText, introIdle), card, advancedCard);

  function read() {
    return {
      mcpServers: mcpTextarea.value,
      agentDirectories: dirsTextarea.value,
      agentMaxTurns: Number(turnsInput.value) || 1,
    };
  }

  function write(cfg) {
    mcpTextarea.value = cfg.mcpServers ?? '';
    dirsTextarea.value = cfg.agentDirectories ?? '';
    turnsInput.value = cfg.agentMaxTurns ?? 8;
    syncFromTextarea();
  }

  const form = new SettingsForm({
    section: root,
    read,
    write,
    note: () => t('form.note.agentRestart'),
  });
  const saveBtn = form.bar.querySelector('.btn.primary');

  return {
    update(state) {
      introIdle.hidden = state.config.brainKind !== 'chat';
      form.update(state.config);
    },
  };
}
