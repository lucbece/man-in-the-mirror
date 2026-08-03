const $ = (sel) => document.querySelector(sel);

const els = {
  botStatus: $('#botStatus'),
  connectionForm: $('#connectionForm'),
  listeningForm: $('#listeningForm'),
  transcriptionForm: $('#transcriptionForm'),
  thinkingForm: $('#thinkingForm'),
  brainAdvice: $('#brainAdvice'),
  anthropicKeyHint: $('#anthropicKeyHint'),
  voiceSelect: $('#voiceSelect'),
  localVoiceSelect: $('#localVoiceSelect'),
  sttModelSelect: $('#sttModelSelect'),
  sttModelRow: $('#sttModelRow'),
  openaiVoiceRow: $('#openaiVoiceRow'),
  localVoiceRow: $('#localVoiceRow'),
  speakingForm: $('#speakingForm'),
  tokenHint: $('#tokenHint'),
  keyHint: $('#keyHint'),
  sttAdvice: $('#sttAdvice'),
  bufferOut: $('#bufferOut'),
  sessions: $('#sessions'),
  guildSelect: $('#guildSelect'),
  channelSelect: $('#channelSelect'),
  joinBtn: $('#joinBtn'),
  toast: $('#toast'),
};

let state = null;
// Don't clobber a field the user is currently editing.
const isEditing = (form) => form.contains(document.activeElement);

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

async function act(fn, okMessage) {
  try {
    const result = await fn();
    if (okMessage) toast(okMessage);
    await refresh();
    return result;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

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
  if (!isEditing(els.connectionForm)) renderConnection(next.config);
  if (!isEditing(els.listeningForm)) renderListening(next.config);
  if (!isEditing(els.transcriptionForm)) renderTranscription(next.config);
  if (!isEditing(els.thinkingForm)) renderThinking(next.config);
  if (!isEditing(els.speakingForm)) renderSpeaking(next.config);
  renderSessions(next.sessions);
  renderGuilds(next.guilds);
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

function renderConnection(cfg) {
  els.tokenHint.textContent = cfg.hasToken
    ? `A token is stored (${cfg.tokenPreview}). Leave blank to keep it.`
    : 'No token stored yet.';
  const guildInput = els.connectionForm.elements.guildId;
  if (document.activeElement !== guildInput) guildInput.value = cfg.guildId ?? '';
}

function renderListening(cfg) {
  const f = els.listeningForm.elements;
  f.bufferSeconds.value = cfg.bufferSeconds;
  f.agentNames.value = cfg.agentNames ?? '';
  f.eagerTranscription.checked = cfg.eagerTranscription;
  f.wakeEnabled.checked = cfg.wakeEnabled;
  els.bufferOut.textContent = describeSeconds(cfg.bufferSeconds);
}

function renderTranscription(cfg) {
  const f = els.transcriptionForm.elements;
  for (const radio of f.sttProvider) radio.checked = radio.value === cfg.sttProvider;

  els.keyHint.textContent = cfg.hasOpenaiApiKey
    ? `A key is stored (${cfg.openaiApiKeyPreview}). Leave blank to keep it.`
    : 'No key stored yet.';

  const models = cfg.sttModels ?? [];
  if (els.sttModelSelect.options.length !== models.length) {
    els.sttModelSelect.replaceChildren(...models.map((m) => new Option(m.label, m.id)));
  }
  els.sttModelSelect.value = cfg.sttLocalModel;

  // The key only matters for the cloud provider, the model only for the local one.
  const usingOpenAi = cfg.sttProvider === 'openai';
  f.openaiApiKey.closest('label').classList.toggle('dim', !usingOpenAi);
  els.sttModelRow.classList.toggle('dim', usingOpenAi);

  if (usingOpenAi && !cfg.hasOpenaiApiKey) {
    els.sttAdvice.textContent =
      'Sin key la transcripción va a fallar. Pegá una de OpenAI abajo, o pasá a transcribir en esta máquina.';
    els.sttAdvice.classList.add('warn');
  } else {
    els.sttAdvice.textContent =
      'Es una decisión de hardware, no de calidad: es el mismo modelo Whisper en los dos lados. Con una GPU, local es más rápido y gratis. Sin GPU es más lento que la API — medido en una laptop: 2.4s contra ~1s.';
    els.sttAdvice.classList.remove('warn');
  }
}

function renderThinking(cfg) {
  const f = els.thinkingForm.elements;
  for (const radio of f.brainProvider) radio.checked = radio.value === cfg.brainProvider;
  f.brainModel.value = cfg.brainModel ?? '';
  f.webSearch.checked = cfg.webSearch;

  els.anthropicKeyHint.textContent = cfg.hasAnthropicApiKey
    ? `A key is stored (${cfg.anthropicApiKeyPreview}). Leave blank to keep it.`
    : 'No key stored yet.';

  const usingClaude = cfg.brainProvider === 'anthropic';
  f.anthropicApiKey.closest('label').classList.toggle('dim', !usingClaude);

  const missing = usingClaude ? !cfg.hasAnthropicApiKey : !cfg.hasOpenaiApiKey;
  els.brainAdvice.textContent = missing
    ? `No ${usingClaude ? 'Anthropic' : 'OpenAI'} key set, so the agent can't answer yet.`
    : 'Ready to answer.';
  els.brainAdvice.classList.toggle('warn', missing);
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
    els.localVoiceSelect.replaceChildren(
      ...localVoices.map((v) => new Option(v.label, v.id)),
    );
  }
  els.localVoiceSelect.value = cfg.ttsLocalVoice;

  // Dim whichever voice list isn't in play, rather than hiding it — seeing the
  // other option exists is the point of offering both.
  const local = cfg.ttsProvider === 'local';
  els.openaiVoiceRow.classList.toggle('dim', local);
  els.localVoiceRow.classList.toggle('dim', !local);

  f.webPort.value = cfg.webPort;
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
        s.eager?.error ? `transcription stopped: ${s.eager.error}` : null,
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
              () =>
                post('/api/voice/listen', {
                  guildId: s.guildId,
                  listening: !s.agentEnabled,
                }),
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
        row.append(button('Shush', () => act(() => post('/api/voice/shush', { guildId: s.guildId }))));
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
      result.transcript ||
      'Got audio but no words out of it — likely too quiet or too short.';
    toast(
      `${result.transcribed} new chunk(s) in ${(result.elapsedMs / 1000).toFixed(1)}s`,
    );
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
      out.textContent =
        `You: ${question}\n\n${result.spoken}` +
        `\n\n— heard ${(t.transcribeMs / 1000).toFixed(1)}s, ` +
        `thought ${(t.thinkMs / 1000).toFixed(1)}s, ` +
        `voiced ${(t.speakMs / 1000).toFixed(1)}s, ` +
        `${(t.totalMs / 1000).toFixed(1)}s total`;
    }
  } catch (err) {
    if (out) out.textContent = `Couldn't answer: ${err.message}`;
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

els.connectionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = els.connectionForm.elements;
  act(
    () => post('/api/config', { token: f.token.value, guildId: f.guildId.value }),
    'Saved.',
  ).then(() => {
    f.token.value = '';
  });
});

els.listeningForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = els.listeningForm.elements;
  act(
    () =>
      post('/api/config', {
        bufferSeconds: Number(f.bufferSeconds.value),
        agentNames: f.agentNames.value,
        eagerTranscription: f.eagerTranscription.checked,
        wakeEnabled: f.wakeEnabled.checked,
      }),
    'Saved.',
  );
});

els.listeningForm.elements.bufferSeconds.addEventListener('input', (event) => {
  els.bufferOut.textContent = describeSeconds(Number(event.target.value));
});

els.transcriptionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = els.transcriptionForm.elements;
  const provider = [...f.sttProvider].find((r) => r.checked)?.value ?? 'openai';
  act(
    () =>
      post('/api/config', {
        sttProvider: provider,
        sttLocalModel: f.sttLocalModel.value,
        openaiApiKey: f.openaiApiKey.value,
      }),
    'Saved.',
  ).then(() => {
    f.openaiApiKey.value = '';
  });
});

els.thinkingForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = els.thinkingForm.elements;
  const provider = [...f.brainProvider].find((r) => r.checked)?.value ?? 'anthropic';
  act(
    () =>
      post('/api/config', {
        brainProvider: provider,
        brainModel: f.brainModel.value,
        webSearch: f.webSearch.checked,
        anthropicApiKey: f.anthropicApiKey.value,
      }),
    'Saved.',
  ).then(() => {
    f.anthropicApiKey.value = '';
  });
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
        webPort: Number(f.webPort.value),
      }),
    'Saved.',
  );
});

for (const btn of document.querySelectorAll('[data-bot]')) {
  btn.addEventListener('click', () =>
    act(() => post(`/api/bot/${btn.dataset.bot}`, {}), `Bot ${btn.dataset.bot}ed.`),
  );
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

refresh();
setInterval(refresh, 2000);
