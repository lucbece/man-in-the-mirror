const $ = (sel) => document.querySelector(sel);

const els = {
  botStatus: $('#botStatus'),
  connectionForm: $('#connectionForm'),
  behaviourForm: $('#behaviourForm'),
  tokenHint: $('#tokenHint'),
  volumeOut: $('#volumeOut'),
  sessions: $('#sessions'),
  guildSelect: $('#guildSelect'),
  channelSelect: $('#channelSelect'),
  joinBtn: $('#joinBtn'),
  soundList: $('#soundList'),
  soundCount: $('#soundCount'),
  soundsDir: $('#soundsDir'),
  sourcesCard: $('#sourcesCard'),
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  browseBtn: $('#browseBtn'),
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

function toast(message, kind = 'ok') {
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
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
  if (!isEditing(els.behaviourForm)) renderBehaviour(next.config);
  renderSessions(next.sessions);
  renderGuilds(next.guilds);
  renderSounds(next);
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

function renderBehaviour(cfg) {
  const f = els.behaviourForm.elements;
  f.minIntervalSeconds.value = cfg.minIntervalSeconds;
  f.maxIntervalSeconds.value = cfg.maxIntervalSeconds;
  f.volume.value = Math.round(cfg.volume * 100);
  f.autoStart.checked = cfg.autoStart;
  f.playOnJoin.checked = cfg.playOnJoin;
  f.pauseWhenAlone.checked = cfg.pauseWhenAlone;
  f.webPort.value = cfg.webPort;
  els.volumeOut.textContent = `${Math.round(cfg.volume * 100)}%`;
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
      const bits = [
        s.running ? 'scheduler running' : 'paused',
        `${s.listeners} listening`,
        s.secondsUntilNext !== null ? `next in ~${s.secondsUntilNext}s` : null,
        s.lastPlayed ? `last: ${s.lastPlayed}` : null,
        `${s.playCount} played`,
      ].filter(Boolean);
      meta.textContent = bits.join(' · ');

      const row = document.createElement('div');
      row.className = 'row';
      row.append(
        button(s.running ? 'Pause' : 'Start', () =>
          act('/api/voice/scheduler', { guildId: s.guildId, running: !s.running }),
        ),
        button('Play now', () => act('/api/voice/play', { guildId: s.guildId })),
        button('Leave', () => act('/api/voice/leave', { guildId: s.guildId }), 'danger'),
      );

      card.append(title, meta, row);
      return card;
    }),
  );
}

function renderGuilds(guilds) {
  const connectedGuilds = new Set((state.sessions ?? []).map((s) => s.guildId));
  const previousGuild = els.guildSelect.value;

  els.guildSelect.replaceChildren(
    ...guilds.map((g) => new Option(g.name, g.id)),
  );
  if (guilds.length === 0) {
    els.guildSelect.replaceChildren(new Option('— bot offline or in no servers —', ''));
  }
  if (previousGuild && guilds.some((g) => g.id === previousGuild)) {
    els.guildSelect.value = previousGuild;
  }

  const guild = guilds.find((g) => g.id === els.guildSelect.value);
  const previousChannel = els.channelSelect.value;
  const channels = guild?.channels ?? [];

  els.channelSelect.replaceChildren(
    ...channels.map((c) => new Option(`#${c.name}${c.members ? ` (${c.members})` : ''}`, c.id)),
  );
  if (channels.length === 0) {
    els.channelSelect.replaceChildren(new Option('— no voice channels —', ''));
  }
  if (previousChannel && channels.some((c) => c.id === previousChannel)) {
    els.channelSelect.value = previousChannel;
  }

  els.joinBtn.disabled = channels.length === 0;
  els.joinBtn.textContent = connectedGuilds.has(els.guildSelect.value)
    ? 'Move to channel'
    : 'Join channel';
}

function renderSounds(next) {
  els.soundCount.textContent = next.sounds.length;
  els.soundsDir.textContent = next.soundsDir;
  // Draw the eye to the download links only while there's nothing to play.
  els.sourcesCard.classList.toggle('wanted', next.sounds.length === 0);

  els.soundList.replaceChildren(
    ...next.sounds.map((name) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'name';
      label.textContent = name;

      const row = document.createElement('span');
      row.className = 'row';
      row.style.margin = '0';

      const session = next.sessions[0];
      if (session) {
        row.append(
          button('Play', () =>
            act('/api/voice/play', { guildId: session.guildId, sound: name }),
          ),
        );
      }
      row.append(
        button('Delete', async () => {
          if (!confirm(`Delete ${name}?`)) return;
          await api(`/api/sounds/${encodeURIComponent(name)}`, { method: 'DELETE' });
          toast(`Deleted ${name}`);
          refresh();
        }, 'danger'),
      );

      li.append(label, row);
      return li;
    }),
  );
}

function button(text, onClick, className = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (className) b.className = className;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await onClick();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

async function act(url, body) {
  await api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  refresh();
}

// --- events -----------------------------------------------------------------

els.connectionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(els.connectionForm));
  try {
    const res = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    els.connectionForm.elements.token.value = '';
    toast(res.restarted ? 'Saved — restarting the bot…' : 'Saved.');
    refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
});

els.behaviourForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = els.behaviourForm.elements;
  const payload = {
    minIntervalSeconds: Number(f.minIntervalSeconds.value),
    maxIntervalSeconds: Number(f.maxIntervalSeconds.value),
    volume: Number(f.volume.value) / 100,
    autoStart: f.autoStart.checked,
    playOnJoin: f.playOnJoin.checked,
    pauseWhenAlone: f.pauseWhenAlone.checked,
    webPort: Number(f.webPort.value),
  };
  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    toast('Saved.');
    document.activeElement?.blur();
    refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
});

els.behaviourForm.elements.volume.addEventListener('input', (event) => {
  els.volumeOut.textContent = `${event.target.value}%`;
});

document.querySelectorAll('[data-bot]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const res = await api(`/api/bot/${btn.dataset.bot}`, { method: 'POST' });
      toast(res.error ? res.error : `Bot ${res.state}.`, res.error ? 'error' : 'ok');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
});

els.guildSelect.addEventListener('change', () => renderGuilds(state.guilds));

els.joinBtn.addEventListener('click', async () => {
  els.joinBtn.disabled = true;
  try {
    await act('/api/voice/join', {
      guildId: els.guildSelect.value,
      channelId: els.channelSelect.value,
    });
    toast('Joined.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    els.joinBtn.disabled = false;
  }
});

// --- uploads ----------------------------------------------------------------

async function uploadFiles(files) {
  for (const file of files) {
    try {
      await api(`/api/sounds/${encodeURIComponent(file.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      toast(`Uploaded ${file.name}`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 'error');
    }
  }
  refresh();
}

els.browseBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  uploadFiles([...els.fileInput.files]);
  els.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((type) =>
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((type) =>
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove('over');
  }),
);
els.dropzone.addEventListener('drop', (event) => {
  uploadFiles([...event.dataTransfer.files]);
});

// --- polling ----------------------------------------------------------------

async function refresh() {
  try {
    render(await api('/api/state'));
  } catch (err) {
    els.botStatus.querySelector('.label').textContent = `Control panel offline: ${err.message}`;
  }
}

refresh();
setInterval(refresh, 2000);
