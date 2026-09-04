import { h } from '../dom.js';
import { t } from '../i18n.js';
import { SettingsForm, field, callout } from '../form.js';

/**
 * Tools: the MCP servers the agent can reach, the folders a filesystem
 * server is scoped to, and how many tool rounds it gets per answer.
 *
 * These only run in Agent and Fast-model-in-front modes. Chat mode still
 * shows the section — a server left configured there is still configured,
 * just unused — and the header says so instead of hiding anything.
 */
export function mount(root) {
  const introText = h('p', t('tools.intro'));

  const mcpTextarea = h('textarea.textarea', {
    name: 'mcpServers',
    rows: 8,
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const mcpHelp = h('p.help', t('tools.mcp.help'));
  const mcpField = h(
    'div.field',
    h('label', t('tools.mcp.label')),
    mcpTextarea,
    mcpHelp,
    h(
      'details.more',
      h('summary', t('tools.mcp.more.summary')),
      h('p', t('tools.mcp.more.text')),
    ),
  );

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

  const card = h('div.card', mcpField, dirsField, turnsField, callout(t('tools.warn'), 'warn'));
  root.append(h('header', introText), card);

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

  mcpTextarea.addEventListener('input', () => {
    saveBtn.disabled = !validateMcp();
  });

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
    saveBtn.disabled = !validateMcp();
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
      introText.textContent = state.config.brainKind === 'chat' ? t('tools.intro.idle') : t('tools.intro');
      form.update(state.config);
    },
  };
}
