const $ = (sel) => document.querySelector(sel);

const els = {
  botStatus: $('#botStatus'),
  pipeline: $('#pipeline'),
  tabs: $('#tabs'),

  setupCard: $('#setupCard'),
  setupForm: $('#setupForm'),
  setupAdvice: $('#setupAdvice'),

  connectionForm: $('#connectionForm'),
  discordAdvice: $('#discordAdvice'),
  guildSelect: $('#guildSelect'),
  channelSelect: $('#channelSelect'),
  joinBtn: $('#joinBtn'),
  sessions: $('#sessions'),

  keysForm: $('#keysForm'),
  tokenHint: $('#tokenHint'),
  keyHint: $('#keyHint'),
  anthropicKeyHint: $('#anthropicKeyHint'),

  hearingForm: $('#hearingForm'),
  sttAdvice: $('#sttAdvice'),
  sttModelSelect: $('#sttModelSelect'),
  sttModelRow: $('#sttModelRow'),
  bufferOut: $('#bufferOut'),

  thinkingForm: $('#thinkingForm'),
  brainAdvice: $('#brainAdvice'),
  chatProviderRow: $('#chatProviderRow'),
  agentRow: $('#agentRow'),
  fastModelRow: $('#fastModelRow'),
  answerStats: $('#answerStats'),

  speakingForm: $('#speakingForm'),
  voiceSelect: $('#voiceSelect'),
  localVoiceSelect: $('#localVoiceSelect'),
  openaiVoiceRow: $('#openaiVoiceRow'),
  localVoiceRow: $('#localVoiceRow'),

  toast: $('#toast'),
};

let state = null;

/**
 * Forms with changes that have not been saved.
 *
 * Focus alone was not enough. The poll runs every two seconds and the guard
 * was `form.contains(document.activeElement)`, so typing an MCP config,
 * clicking away to check something and coming back found the box reset to
 * whatever was on the server. Nothing was lost that could not be retyped,
 * which is precisely the kind of small betrayal that teaches people not to
 * trust a control panel.
 *
 * A form stays untouched until it is saved. That does mean a setting changed
 * by voice will not appear while you have unsaved edits in that tab — which is
 * the right way round: your half-written config outranks a refresh.
 */
const unsaved = new Set();

function markUnsaved(form) {
  unsaved.add(form);
  form.dataset.unsaved = 'true';
}

function markSaved(form) {
  unsaved.delete(form);
  delete form.dataset.unsaved;
}

// Don't clobber a field someone is editing, or one they have edited and not
// yet saved.
const isEditing = (form) => form.contains(document.activeElement) || unsaved.has(form);

// --- api --------------------------------------------------------------------

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

const post = (url, payload) =>
  api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

function toast(message, kind = 'ok') {
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

/**
 * Run something, report it, then re-render.
 *
 * `form` is cleared of its unsaved mark only when the call succeeds. On a
 * rejected save — broken MCP JSON, a folder that isn't there — the typed
 * values stay put and stay protected from the next poll, so the error is
 * something to fix rather than something to retype.
 */
async function act(fn, okMessage, form) {
  try {
    const result = await fn();
    if (okMessage) toast(okMessage);
    if (form) markSaved(form);
    await refresh();
    return result;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

// --- tabs -------------------------------------------------------------------

const TAB_KEY = 'mitm.tab';

function showTab(name) {
  const swap = () => {
    for (const tab of els.tabs.querySelectorAll('.tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    }
    for (const panel of document.querySelectorAll('.panel')) {
      panel.hidden = panel.dataset.panel !== name;
    }
  };

  // Let the browser cross-fade the two sections when it can. Without it the
  // new section simply appears, which reads as a page reload rather than as
  // this thing responding. Falls straight through where unsupported.
  if (document.startViewTransition) document.startViewTransition(swap);
  else swap();

  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    // Private browsing, or storage disabled. The tab just won't be remembered.
  }
}

els.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});

// Arrow keys move between tabs, which is what a tab strip is expected to do.
els.tabs.addEventListener('keydown', (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  const tabs = [...els.tabs.querySelectorAll('.tab')];
  const at = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  const next = tabs[(at + step + tabs.length) % tabs.length];
  next.focus();
  showTab(next.dataset.tab);
  event.preventDefault();
});

// --- rendering --------------------------------------------------------------

const STATE_LABELS = {
  stopped: 'Stopped',
  starting: 'Connecting…',
  ready: 'Online',
  error: 'Error',
};

function render(next) {
  state = next;
  renderBotStatus(next.bot);
  renderPipeline(next.config);
  if (!isEditing(els.setupForm)) renderSetup(next.config);
  if (!isEditing(els.connectionForm)) renderConnection(next.config);
  if (!isEditing(els.keysForm)) renderKeys(next.config);
  if (!isEditing(els.hearingForm)) renderHearing(next.config);
  if (!isEditing(els.thinkingForm)) renderThinking(next.config);
  if (!isEditing(els.speakingForm)) renderSpeaking(next.config);
  renderSessions(next.sessions);
  renderGuilds(next.guilds);
  renderAnswerStats(next.answers);
}

/**
 * What the last few answers actually cost.
 *
 * Here rather than hidden in a log because it answers the one question the
 * Thinking tab cannot otherwise settle: how many turns needed a tool at all.
 * The share that did not is the share a fast model in front could have taken,
 * which is the whole case for or against the cascade — and it is a fact about
 * this channel, not a general claim.
 */
function renderAnswerStats(stats) {
  if (!stats?.count) {
    els.answerStats.hidden = true;
    return;
  }
  els.answerStats.hidden = false;

  const seconds = (ms) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—');
  const noTools = Math.round((1 - stats.toolRate) * 100);
  const rows = [
    ['answers measured', String(stats.count)],
    ['needed no tool', `${noTools}%`],
    ['first words, no tool', seconds(stats.firstAudioWithoutToolsMs)],
    ['first words, with tools', seconds(stats.firstAudioWithToolsMs)],
  ];
  if (stats.escalationRate > 0) {
    rows.push(['handed over', `${Math.round(stats.escalationRate * 100)}%`]);
  }
  // The other half of the wait, and the half nobody had ever measured:
  // silence detection, transcription and the grace pause, before the model is
  // asked anything at all. Only spoken questions have it — one typed here
  // never waited for any of it.
  if (stats.beforeAskMs !== null && stats.beforeAskMs !== undefined) {
    rows.push(['heard → asked', seconds(stats.beforeAskMs)]);
  }
  if (stats.followUpRate > 0) {
    rows.push(['answered without its name', `${Math.round(stats.followUpRate * 100)}%`]);
  }

  els.answerStats.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement('div');
      const name = document.createElement('span');
      name.textContent = label;
      const out = document.createElement('strong');
      out.textContent = value;
      row.append(name, out);
      return row;
    }),
  );
}

function renderBotStatus(bot) {
  const dot = els.botStatus.querySelector('.dot');
  const label = els.botStatus.querySelector('.label');
  dot.dataset.state = bot.state;
  let text = STATE_LABELS[bot.state] ?? bot.state;
  if (bot.state === 'ready' && bot.user) text = `${bot.user.tag} · ${bot.guildCount} server(s)`;
  if (bot.error) text += ` — ${bot.error}`;
  label.textContent = text;
}

/**
 * One line summarising what it's set up to do, on every tab.
 *
 * The old single-column panel answered "what is this actually using?" only by
 * scrolling through all of it, and the tabbed one would have hidden the answer
 * behind three clicks. This keeps it in front of you.
 */
function renderPipeline(cfg) {
  const hearing = cfg.sttProvider === 'local' ? `whisper ${cfg.sttLocalModel}` : 'OpenAI whisper';
  const agentModel = cfg.brainModel || 'claude-sonnet-5';
  const thinking =
    cfg.brainKind === 'cascade'
      ? `${cfg.fastModel || 'claude-haiku-4-5'} → agent · ${agentModel}`
      : cfg.brainKind === 'agent'
        ? `agent · ${agentModel}`
        : `${cfg.brainProvider} · ${cfg.brainModel || (cfg.brainProvider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-5')}`;
  const speaking = cfg.ttsProvider === 'local' ? `Piper ${cfg.ttsLocalVoice}` : `OpenAI ${cfg.ttsVoice}`;

  els.pipeline.replaceChildren(
    stage('hears', hearing),
    arrow(),
    stage('thinks', thinking + (cfg.webSearch ? ' + web' : '')),
    arrow(),
    stage('speaks', speaking),
  );
  els.pipeline.classList.toggle('muted', !cfg.agentEnabled);
}

function stage(what, detail) {
  const el = document.createElement('span');
  el.className = 'stage';
  const label = document.createElement('em');
  label.textContent = what;
  el.append(label, document.createTextNode(` ${detail}`));
  return el;
}

function arrow() {
  const el = document.createElement('span');
  el.className = 'arrow';
  el.textContent = '→';
  return el;
}

/**
 * The first-run card: everything needed to get going, in one place.
 *
 * It disappears once nothing is missing. Keeping it after that would mean two
 * places to change the same key, and the other one is where it belongs.
 */
function renderSetup(cfg) {
  const missing = [];
  if (!cfg.hasToken) missing.push('the Discord token');
  if (!cfg.hasOpenaiApiKey) missing.push('the OpenAI key');
  if (!cfg.hasAnthropicApiKey) missing.push('the Anthropic key');

  els.setupCard.hidden = missing.length === 0;
  if (els.setupCard.hidden) return;

  els.setupAdvice.textContent =
    `Three keys and it's ready. Still missing ${listOf(missing)}. ` +
    'Everything else already has a working default, and each of these can be ' +
    'changed later under Keys.';

  const f = els.setupForm.elements;
  if (document.activeElement !== f.guildId) f.guildId.value = cfg.guildId ?? '';
}

/** "a, b and c" — reads better than a bare join in a sentence. */
function listOf(items) {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function renderConnection(cfg) {
  const f = els.connectionForm.elements;
  if (document.activeElement !== f.guildId) f.guildId.value = cfg.guildId ?? '';

  els.discordAdvice.textContent = !cfg.hasToken
    ? 'No bot token yet — add one under Keys and the bot can connect.'
    : cfg.guildId
      ? 'Slash commands register on your server as soon as the bot starts.'
      : 'No server ID set, so slash commands register globally and can take an hour to appear.';
  els.discordAdvice.classList.toggle('warn', !cfg.hasToken);
}

function renderKeys(cfg) {
  els.tokenHint.textContent = cfg.hasToken
    ? `Stored (${cfg.tokenPreview}). Leave blank to keep it.`
    : 'Not set. The bot cannot connect without this.';
  els.keyHint.textContent = cfg.hasOpenaiApiKey
    ? `Stored (${cfg.openaiApiKeyPreview}). Leave blank to keep it.`
    : 'Not set. Needed unless hearing and speaking both run on this machine.';
  els.anthropicKeyHint.textContent = cfg.hasAnthropicApiKey
    ? `Stored (${cfg.anthropicApiKeyPreview}). Leave blank to keep it.`
    : 'Not set. Needed for the agent, and for Claude in chat mode.';

  for (const [hint, has] of [
    [els.tokenHint, cfg.hasToken],
    [els.keyHint, cfg.hasOpenaiApiKey],
    [els.anthropicKeyHint, cfg.hasAnthropicApiKey],
  ]) {
    hint.classList.toggle('warn', !has);
  }
}

function renderHearing(cfg) {
  const f = els.hearingForm.elements;
  for (const radio of f.sttProvider) radio.checked = radio.value === cfg.sttProvider;

  const models = cfg.sttModels ?? [];
  if (els.sttModelSelect.options.length !== models.length) {
    els.sttModelSelect.replaceChildren(...models.map((m) => new Option(m.label, m.id)));
  }
  els.sttModelSelect.value = cfg.sttLocalModel;

  f.agentEnabled.checked = cfg.agentEnabled;
  f.bufferSeconds.value = cfg.bufferSeconds;
  f.agentNames.value = cfg.agentNames ?? '';
  f.eagerTranscription.checked = cfg.eagerTranscription;
  f.wakeEnabled.checked = cfg.wakeEnabled;
  els.bufferOut.textContent = describeSeconds(cfg.bufferSeconds);

  // The local model only matters for the local provider.
  els.sttModelRow.classList.toggle('dim', cfg.sttProvider === 'openai');

  if (cfg.sttProvider === 'openai' && !cfg.hasOpenaiApiKey) {
    els.sttAdvice.textContent =
      'No OpenAI key, so transcription will fail. Add one under Keys, or switch to this machine.';
    els.sttAdvice.classList.add('warn');
  } else {
    els.sttAdvice.textContent =
      'A hardware question, not a quality one: it is the same Whisper model on both sides. ' +
      'With a discrete GPU, local is faster and free. Without one it is slower than the ' +
      'network round trip it replaces — measured on a laptop, 2.4s against about 1s.';
    els.sttAdvice.classList.remove('warn');
  }
}

function renderThinking(cfg) {
  const f = els.thinkingForm.elements;
  for (const radio of f.brainKind) radio.checked = radio.value === cfg.brainKind;
  for (const radio of f.brainProvider) radio.checked = radio.value === cfg.brainProvider;
  f.brainModel.value = cfg.brainModel ?? '';
  f.fastModel.value = cfg.fastModel ?? '';
  f.webSearch.checked = cfg.webSearch;
  f.customInstructions.value = cfg.customInstructions ?? '';
  f.mcpServers.value = cfg.mcpServers ?? '';
  f.agentDirectories.value = cfg.agentDirectories ?? '';
  f.musicChannel.value = cfg.musicChannel ?? '';
  f.musicPlayCommand.value = cfg.musicPlayCommand ?? '';
  f.musicSkipCommand.value = cfg.musicSkipCommand ?? '';
  f.agentMaxTurns.value = cfg.agentMaxTurns ?? 8;

  applyBrainKind(cfg.brainKind);

  const cascade = cfg.brainKind === 'cascade';
  const agent = cfg.brainKind === 'agent' || cascade;
  const usingClaude = agent || cfg.brainProvider === 'anthropic';
  const missing = usingClaude ? !cfg.hasAnthropicApiKey : !cfg.hasOpenaiApiKey;
  els.brainAdvice.textContent = missing
    ? `No ${usingClaude ? 'Anthropic' : 'OpenAI'} key set, so it can't answer yet. Add one under Keys.`
    : cascade
      ? 'Cascade: the fast model answers what it can and hands the rest to the agent, which keeps the conversation.'
      : agent
        ? 'Agent mode: it remembers the conversation and can use the tools below.'
        : 'Chat mode: one API call per answer, no memory between them.';
  els.brainAdvice.classList.toggle('warn', missing);
}

/**
 * The provider choice belongs to chat mode; the tools belong to the agent,
 * which the cascade also has behind it.
 */
function applyBrainKind(kind) {
  const agent = kind === 'agent' || kind === 'cascade';
  els.chatProviderRow.classList.toggle('dim', agent);
  els.agentRow.classList.toggle('dim', !agent);
  els.fastModelRow.classList.toggle('dim', kind !== 'cascade');
}

function renderSpeaking(cfg) {
  const f = els.speakingForm.elements;
  for (const radio of f.ttsProvider) radio.checked = radio.value === cfg.ttsProvider;

  const voices = cfg.voices ?? [];
  if (els.voiceSelect.options.length !== voices.length) {
    els.voiceSelect.replaceChildren(...voices.map((v) => new Option(v, v)));
  }
  els.voiceSelect.value = cfg.ttsVoice;

  const localVoices = cfg.localVoices ?? [];
  if (els.localVoiceSelect.options.length !== localVoices.length) {
    els.localVoiceSelect.replaceChildren(...localVoices.map((v) => new Option(v.label, v.id)));
  }
  els.localVoiceSelect.value = cfg.ttsLocalVoice;

  // Dim whichever list isn't in play rather than hiding it — seeing the other
  // option exists is the point of offering both.
  const local = cfg.ttsProvider === 'local';
  els.openaiVoiceRow.classList.toggle('dim', local);
  els.localVoiceRow.classList.toggle('dim', !local);
}

function describeSeconds(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = seconds / 60;
  return `${Number.isInteger(mins) ? mins : mins.toFixed(1)} min`;
}

function button(label, onClick, className = '') {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  if (className) el.className = className;
  el.addEventListener('click', onClick);
  return el;
}

function renderSessions(sessions) {
  els.sessions.replaceChildren(
    ...sessions.map((s) => {
      const card = document.createElement('div');
      card.className = 'session';

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = `${s.guildName} — #${s.channelName}`;

      const meta = document.createElement('div');
      meta.className = 'meta';
      const l = s.listening;
      meta.textContent = [
        `${s.listeners} in channel`,
        s.agentEnabled ? 'listening' : 'deafened',
        s.agentEnabled ? `${l.utterances} utterance(s), ${l.speechSeconds}s of speech` : null,
        s.speaking ? 'speaking now' : null,
        s.agentEnabled && s.wakeEnabled ? `answers to "${s.agentNames}"` : null,
        s.eager?.failures ? `${s.eager.failures} transcription failure(s)` : null,
        s.eager?.error ? `transcription stopped: ${s.eager.error}` : null,
        // The agent session is the expensive part and was only ever visible in
        // the console, and then only once it had already ended.
        s.agent
          ? `agent: ${s.agent.answers} answer(s), $${s.agent.spentUsd.toFixed(2)}` +
            (s.agent.answering ? ', answering now' : '')
          : null,
      ]
        .filter(Boolean)
        .join(' · ');

      const row = document.createElement('div');
      row.className = 'row';
      row.append(
        button(
          s.agentEnabled ? 'Stop listening' : 'Start listening',
          () =>
            act(
              () => post('/api/voice/listen', { guildId: s.guildId, listening: !s.agentEnabled }),
              s.agentEnabled ? 'Deafened, buffer wiped.' : 'Listening.',
            ),
          s.agentEnabled ? '' : 'primary',
        ),
        button('Read transcript', () => showTranscript(s.guildId)),
        button('Leave', () =>
          act(() => post('/api/voice/leave', { guildId: s.guildId }), 'Left the channel.'),
        ),
      );
      if (s.speaking) {
        row.append(
          button('Shush', () => act(() => post('/api/voice/shush', { guildId: s.guildId }))),
        );
      }

      const askRow = document.createElement('form');
      askRow.className = 'row ask';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Ask something — it answers out loud';
      input.autocomplete = 'off';
      const send = document.createElement('button');
      send.type = 'submit';
      send.textContent = 'Ask';
      askRow.append(input, send);
      askRow.addEventListener('submit', (event) => {
        event.preventDefault();
        const question = input.value.trim();
        if (!question) return;
        input.value = '';
        askAgent(s.guildId, question);
      });

      const out = document.createElement('pre');
      out.className = 'transcript';
      out.id = `transcript-${s.guildId}`;
      out.hidden = true;

      card.append(title, meta, row, askRow, out);
      return card;
    }),
  );
}

async function showTranscript(guildId) {
  const out = $(`#transcript-${guildId}`);
  if (!out) return;
  out.hidden = false;
  out.textContent = 'Transcribing…';

  try {
    const result = await post('/api/voice/transcript', { guildId });
    out.textContent =
      result.transcript || 'Got audio but no words out of it — likely too quiet or too short.';
    toast(`${result.transcribed} new chunk(s) in ${(result.elapsedMs / 1000).toFixed(1)}s`);
  } catch (err) {
    out.textContent = `Transcription failed: ${err.message}`;
  }
}

async function askAgent(guildId, question) {
  const out = $(`#transcript-${guildId}`);
  if (out) {
    out.hidden = false;
    out.textContent = 'Thinking…';
  }

  try {
    const result = await post('/api/voice/ask', { guildId, question });
    const t = result.timings;
    if (out) {
      // `first words at` is the number that matters — it's when a listener
      // stops wondering whether the thing is broken.
      out.textContent =
        `You: ${question}\n\n${result.spoken}` +
        `\n\n— first words at ${((t.firstAudioMs ?? 0) / 1000).toFixed(1)}s, ` +
        `finished thinking at ${((t.thinkMs ?? 0) / 1000).toFixed(1)}s, ` +
        `${((t.totalMs ?? 0) / 1000).toFixed(1)}s total`;
    }
  } catch (err) {
    if (out) out.textContent = `Could not answer: ${err.message}`;
  }
}

function renderGuilds(guilds) {
  const previousGuild = els.guildSelect.value;
  els.guildSelect.replaceChildren(
    ...(guilds.length
      ? guilds.map((g) => new Option(g.name, g.id))
      : [new Option('— bot offline or in no servers —', '')]),
  );
  if (guilds.some((g) => g.id === previousGuild)) els.guildSelect.value = previousGuild;

  const guild = guilds.find((g) => g.id === els.guildSelect.value);
  const channels = guild?.channels ?? [];
  const previousChannel = els.channelSelect.value;
  els.channelSelect.replaceChildren(
    ...(channels.length
      ? channels.map((c) => new Option(`${c.name} (${c.members})`, c.id))
      : [new Option('— no voice channels —', '')]),
  );
  if (channels.some((c) => c.id === previousChannel)) els.channelSelect.value = previousChannel;
}

// --- events -----------------------------------------------------------------

els.guildSelect.addEventListener('change', () => renderGuilds(state?.guilds ?? []));

// Reflect the choice the moment it's clicked, not only after a save round-trips.
for (const radio of els.thinkingForm.elements.brainKind) {
  radio.addEventListener('change', () => radio.checked && applyBrainKind(radio.value));
}
for (const radio of els.hearingForm.elements.sttProvider) {
  radio.addEventListener('change', () =>
    els.sttModelRow.classList.toggle('dim', radio.value === 'openai' && radio.checked),
  );
}
for (const radio of els.speakingForm.elements.ttsProvider) {
  radio.addEventListener('change', () => {
    const local = radio.value === 'local' && radio.checked;
    els.openaiVoiceRow.classList.toggle('dim', local);
    els.localVoiceRow.classList.toggle('dim', !local);
  });
}

els.joinBtn.addEventListener('click', () =>
  act(
    () =>
      post('/api/voice/join', {
        guildId: els.guildSelect.value,
        channelId: els.channelSelect.value,
      }),
    'Joined.',
  ),
);

els.setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = els.setupForm.elements;
  // Blank secrets mean "not touched", so a partial fill is fine: paste what
  // you have, save, and the card keeps asking for the rest.
  act(
    () =>
      post('/api/config', {
        token: f.token.value,
        openaiApiKey: f.openaiApiKey.value,
        anthropicApiKey: f.anthropicApiKey.value,
        guildId: f.guildId.value,
      }),
    'Saved.',
    els.setupForm,
  ).then(() => {
    for (const name of ['token', 'openaiApiKey', 'anthropicApiKey']) f[name].value = '';
  });
});

els.connectionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  act(
    () => post('/api/config', { guildId: els.connectionForm.elements.guildId.value }),
    'Saved.',
    els.connectionForm,
  );
});

els.keysForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = els.keysForm.elements;
  act(
    () =>
      post('/api/config', {
        token: f.token.value,
        openaiApiKey: f.openaiApiKey.value,
        anthropicApiKey: f.anthropicApiKey.value,
      }),
    'Saved.',
    els.keysForm,
  ).then(() => {
    for (const name of ['token', 'openaiApiKey', 'anthropicApiKey']) f[name].value = '';
  });
});

els.hearingForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = els.hearingForm.elements;
  act(
    () =>
      post('/api/config', {
        sttProvider: [...f.sttProvider].find((r) => r.checked)?.value ?? 'openai',
        sttLocalModel: f.sttLocalModel.value,
        agentEnabled: f.agentEnabled.checked,
        bufferSeconds: Number(f.bufferSeconds.value),
        agentNames: f.agentNames.value,
        eagerTranscription: f.eagerTranscription.checked,
        wakeEnabled: f.wakeEnabled.checked,
      }),
    'Saved.',
    els.hearingForm,
  );
});

els.thinkingForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = els.thinkingForm.elements;
  act(
    () =>
      post('/api/config', {
        brainKind: [...f.brainKind].find((r) => r.checked)?.value ?? 'agent',
        brainProvider: [...f.brainProvider].find((r) => r.checked)?.value ?? 'anthropic',
        brainModel: f.brainModel.value,
        fastModel: f.fastModel.value,
        webSearch: f.webSearch.checked,
        customInstructions: f.customInstructions.value,
        mcpServers: f.mcpServers.value,
        agentDirectories: f.agentDirectories.value,
        musicChannel: f.musicChannel.value,
        musicPlayCommand: f.musicPlayCommand.value,
        musicSkipCommand: f.musicSkipCommand.value,
        agentMaxTurns: Number(f.agentMaxTurns.value) || 8,
      }),
    'Saved.',
    els.thinkingForm,
  );
});

els.speakingForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = els.speakingForm.elements;
  act(
    () =>
      post('/api/config', {
        ttsProvider: [...f.ttsProvider].find((r) => r.checked)?.value ?? 'openai',
        ttsVoice: f.ttsVoice.value,
        ttsLocalVoice: f.ttsLocalVoice.value,
      }),
    'Saved.',
    els.speakingForm,
  );
});

for (const btn of document.querySelectorAll('[data-bot]')) {
  btn.addEventListener('click', () =>
    act(() => post(`/api/bot/${btn.dataset.bot}`, {}), `Bot ${btn.dataset.bot}ed.`),
  );
}

// Any edit to a settings form protects it from the next poll until it saves.
// `input` covers typing, checkboxes and selects; a value set by render() is
// assignment rather than input and correctly does not count.
for (const form of [
  els.setupForm,
  els.connectionForm,
  els.keysForm,
  els.hearingForm,
  els.thinkingForm,
  els.speakingForm,
]) {
  form.addEventListener('input', () => markUnsaved(form));
}

// --- polling ----------------------------------------------------------------

async function refresh() {
  // Fetch and render are reported separately on purpose. Folding them into one
  // catch makes a render bug look identical to a dead server, which sends you
  // hunting the wrong problem.
  let next;
  try {
    next = await api('/api/state');
  } catch {
    els.botStatus.querySelector('.label').textContent = 'Control panel offline — retrying';
    return;
  }

  try {
    render(next);
  } catch (err) {
    console.error('[panel] render failed:', err);
    els.botStatus.querySelector('.label').textContent = `Panel error: ${err.message}`;
  }
}

try {
  showTab(localStorage.getItem(TAB_KEY) || 'discord');
} catch {
  showTab('discord');
}

refresh();
setInterval(refresh, 2000);
