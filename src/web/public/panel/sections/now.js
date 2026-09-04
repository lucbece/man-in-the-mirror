import { h, toast, ms, describeSeconds } from '../dom.js';
import { post } from '../api.js';
import { t } from '../i18n.js';
import { field } from '../form.js';

/**
 * Now: what the bot is doing, and the actions of the moment.
 *
 * Everything here acts at once; nothing is saved. The first-run steps are
 * the one exception, and they disappear once the keys exist.
 */
export function mount(root, ctx) {
  const setup = h('div.card');
  const join = h('div.card');
  const calls = h('div');
  const recent = h('div.card');
  const strip = h('div.strip');
  const stats = h('div.stats');
  root.append(setup, join, calls, recent, strip, stats);

  const askOutputs = new Map(); // guildId → <pre> under the ask row

  async function act(fn, okMessage) {
    try {
      await fn();
      if (okMessage) toast(okMessage);
      await ctx.refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // --- first run -----------------------------------------------------------

  let setupBusy = false;
  function renderSetup(cfg) {
    const missing = !cfg.hasToken || !cfg.hasOpenaiApiKey || !cfg.hasAnthropicApiKey;
    setup.hidden = !missing;
    if (!missing || setupBusy || setup.contains(document.activeElement)) return;

    const step = (n, done, title, help, key, preview) => {
      const body = h('div.body', h('span.title', title));
      if (done) body.append(h('span.help', t('now.setup.set', { preview })));
      else {
        const input = h('input.input', { type: key === 'guildId' ? 'text' : 'password', autocomplete: 'off', spellcheck: 'false' });
        const save = h('button.btn.primary', { type: 'button' }, t('now.setup.save'));
        save.addEventListener('click', () => {
          const value = input.value.trim();
          if (!value) return;
          setupBusy = true;
          act(() => post('/api/config', { [key]: value }), t('now.setup.saved')).finally(() => {
            setupBusy = false;
          });
        });
        input.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
        body.append(h('div.input-row', input, save), h('span.help', help));
      }
      return h(`div.step${done ? '.done' : ''}`, h('span.num', done ? '✓' : String(n)), body);
    };

    setup.replaceChildren(
      h('div.head', h('h2', t('now.setup.title'))),
      h('p.help', t('now.setup.intro')),
      h(
        'div.steps',
        step(1, cfg.hasToken, t('now.setup.token'), t('now.setup.token.help'), 'token', cfg.tokenPreview),
        step(2, cfg.hasOpenaiApiKey, t('now.setup.openai'), t('now.setup.openai.help'), 'openaiApiKey', cfg.openaiApiKeyPreview),
        step(3, cfg.hasAnthropicApiKey, t('now.setup.anthropic'), t('now.setup.anthropic.help'), 'anthropicApiKey', cfg.anthropicApiKeyPreview),
        step(4, Boolean(cfg.guildId), t('now.setup.guild'), t('now.setup.guild.help'), 'guildId', cfg.guildId),
      ),
    );
  }

  // --- join ------------------------------------------------------------------

  const guildSelect = h('select.select');
  const channelSelect = h('select.select');
  guildSelect.addEventListener('change', () => fillChannels(lastGuilds));
  let lastGuilds = [];

  function fillChannels(guilds) {
    const guild = guilds.find((g) => g.id === guildSelect.value);
    const channels = guild?.channels ?? [];
    const previous = channelSelect.value;
    channelSelect.replaceChildren(
      ...(channels.length
        ? channels.map((c) => new Option(`${c.name} (${c.members})`, c.id))
        : [new Option(t('now.join.noChannels'), '')]),
    );
    if (channels.some((c) => c.id === previous)) channelSelect.value = previous;
  }

  function renderJoin(guilds, sessions) {
    join.hidden = sessions.length > 0;
    lastGuilds = guilds;
    const previous = guildSelect.value;
    guildSelect.replaceChildren(
      ...(guilds.length ? guilds.map((g) => new Option(g.name, g.id)) : [new Option(t('now.join.none'), '')]),
    );
    if (guilds.some((g) => g.id === previous)) guildSelect.value = previous;
    fillChannels(guilds);
    if (!join.childElementCount) {
      join.append(
        h('div.head', h('h2', t('now.join.title'))),
        h(
          'div.fields-2',
          field({ label: t('now.join.server'), control: guildSelect }),
          field({ label: t('now.join.channel'), control: channelSelect }),
        ),
        h(
          'div.row',
          h(
            'button.btn.primary',
            {
              type: 'button',
              onclick: () =>
                act(
                  () => post('/api/voice/join', { guildId: guildSelect.value, channelId: channelSelect.value }),
                  t('now.join.done'),
                ),
            },
            t('now.join.button'),
          ),
        ),
      );
    }
  }

  // --- the call ----------------------------------------------------------------

  function pill(text, state) {
    return h('span.pill', { data: { state } }, h('span.dot'), text);
  }

  function callCard(s) {
    const pills = [
      s.agentEnabled ? pill(t('now.call.listening'), 'ok') : pill(t('now.call.deafened'), ''),
      s.speaking ? pill(t('now.call.speaking'), 'busy') : null,
      s.quiet ? h('span.pill.accent', t('now.call.music')) : null,
    ];
    const l = s.listening ?? {};
    const meta = [
      t('now.call.people', { n: s.listeners }),
      s.agentEnabled ? t('now.call.heard', { n: l.utterances ?? 0, s: l.speechSeconds ?? 0 }) : null,
      s.agentEnabled && s.wakeEnabled ? h('span', `${t('now.call.names')} `, h('b', s.agentNames)) : null,
      s.agent
        ? t('now.call.agent', { n: s.agent.answers, usd: s.agent.spentUsd.toFixed(2) }) +
          (s.agent.answering ? ` · ${t('now.call.answering')}` : '')
        : null,
      s.eager?.failures ? t('now.call.failures', { n: s.eager.failures }) : null,
      s.eager?.error ? t('now.call.stopped', { error: s.eager.error }) : null,
    ].filter(Boolean);

    const g = s.guildId;
    const buttons = h(
      'div.row',
      h(
        'button.btn',
        { type: 'button', onclick: () => act(() => post('/api/voice/listen', { guildId: g, listening: !s.agentEnabled }), s.agentEnabled ? t('now.call.deafened.toast') : t('now.call.listening.toast')) },
        s.agentEnabled ? t('now.call.deafen') : t('now.call.listen'),
      ),
      h(
        'button.btn',
        { type: 'button', onclick: () => act(() => post('/api/voice/quiet', { guildId: g, quiet: !s.quiet }), s.quiet ? t('now.call.musicOff.toast') : t('now.call.musicOn.toast')) },
        s.quiet ? t('now.call.musicOff') : t('now.call.musicOn'),
      ),
      s.speaking
        ? h('button.btn', { type: 'button', onclick: () => act(() => post('/api/voice/shush', { guildId: g }), t('now.call.shushed')) }, t('now.call.shush'))
        : null,
      h('button.btn', { type: 'button', onclick: () => showTranscript(g) }, t('now.call.transcript')),
      h('button.btn.quiet', { type: 'button', onclick: () => act(() => post('/api/voice/leave', { guildId: g }), t('now.call.left')) }, t('now.call.leave')),
    );

    const out = askOutputs.get(g) ?? h('pre.transcript', { hidden: true });
    askOutputs.set(g, out);
    const input = h('input.input', { type: 'text', placeholder: t('now.ask.placeholder'), autocomplete: 'off' });
    const ask = h(
      'form.input-row',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const question = input.value.trim();
          if (!question) return;
          input.value = '';
          askAgent(g, question);
        },
      },
      input,
      h('button.btn', { type: 'submit' }, t('now.ask.button')),
    );

    return h(
      'div.card',
      h('div.head', h('h2', `#${s.channelName} `, h('small', `· ${s.guildName}`)), h('div.row', pills)),
      h('div.meta', meta.map((m) => h('span', m))),
      buttons,
      musicCard(s),
      ask,
      out,
    );
  }

  function musicCard(s) {
    const m = s.music;
    if (!m || (!m.playing && !m.queued && !m.title)) return null;
    const g = s.guildId;
    const music = (action) => act(() => post(`/api/voice/music/${action}`, { guildId: g }), t('now.music.done'));
    return h(
      'div.subcard',
      h(
        'div.head',
        h('div', h('div.label', m.paused ? t('now.music.paused') : t('now.music.playing')), h('div.title', m.title ?? '—')),
        h(
          'div.row',
          h('button.btn.small', { type: 'button', onclick: () => music(m.paused ? 'resume' : 'pause') }, m.paused ? t('now.music.resume') : t('now.music.pause')),
          h('button.btn.small', { type: 'button', onclick: () => music('skip') }, t('now.music.skip')),
          h('button.btn.small.quiet', { type: 'button', onclick: () => music('stop') }, t('now.music.stop')),
        ),
      ),
      h(
        'div.meta',
        h('span', t('now.music.queued', { n: m.queued ?? 0 })),
        typeof m.volume === 'number' ? h('span', t('now.music.volume', { n: Math.round(m.volume * 100) })) : null,
        m.requestedBy ? h('span', t('now.music.askedBy', { who: m.requestedBy })) : null,
      ),
    );
  }

  async function showTranscript(guildId) {
    const out = askOutputs.get(guildId);
    if (!out) return;
    out.hidden = false;
    out.textContent = t('now.transcript.working');
    try {
      const result = await post('/api/voice/transcript', { guildId });
      out.textContent = result.transcript || t('now.transcript.empty');
    } catch (err) {
      out.textContent = t('now.transcript.failed', { error: err.message });
    }
  }

  async function askAgent(guildId, question) {
    const out = askOutputs.get(guildId);
    if (!out) return;
    out.hidden = false;
    out.textContent = t('now.ask.thinking');
    try {
      const result = await post('/api/voice/ask', { guildId, question });
      const tm = result.timings ?? {};
      out.textContent = `${question}\n\n${result.spoken || result.written}\n\n${t('now.ask.result', { first: ms(tm.firstAudioMs), total: ms(tm.totalMs) })}`;
    } catch (err) {
      out.textContent = t('now.ask.failed', { error: err.message });
    }
  }

  function renderCalls(sessions) {
    // Rebuilt every poll; the ask output survives because it is kept aside.
    if (calls.contains(document.activeElement)) return;
    calls.replaceChildren(...sessions.map(callCard));
    calls.hidden = sessions.length === 0;
  }

  // --- recent --------------------------------------------------------------------

  function renderRecent(sessions) {
    const items = sessions.flatMap((s) => (s.recent ?? []).map((r) => ({ ...r, channel: s.channelName })));
    recent.hidden = items.length === 0;
    if (!items.length) return;
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    recent.replaceChildren(
      h('div.head', h('h2', t('now.recent.title')), h('span.meta', t('now.recent.note'))),
      h(
        'div.exchanges',
        items.slice(0, 10).map((r) =>
          h(
            'div.exchange',
            h('div.q', h('b', r.askedBy ?? '—'), ` · ${r.question ?? ''}`),
            h('div.a', r.answer ?? ''),
            h(
              'div.t',
              [r.tools?.length ? r.tools.join(', ') : null, t('now.recent.timing', { first: ms(r.firstAudioMs), total: ms(r.totalMs) }), clock(r.at)]
                .filter(Boolean)
                .join(' · '),
            ),
          ),
        ),
      ),
    );
  }

  const clock = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // --- how it is set up -----------------------------------------------------------

  function renderStrip(cfg) {
    const hears = cfg.sttProvider === 'local' ? t('now.strip.local', { model: cfg.sttLocalModel }) : 'OpenAI Whisper';
    const agentModel = cfg.brainModel || 'claude-sonnet-5';
    const thinks =
      (cfg.brainKind === 'cascade'
        ? t('now.strip.cascade', { fast: cfg.fastModel || 'claude-haiku-4-5', agent: agentModel })
        : cfg.brainKind === 'agent'
          ? t('now.strip.agent', { agent: agentModel })
          : `${cfg.brainProvider} · ${cfg.brainModel || (cfg.brainProvider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-5')}`) +
      (cfg.webSearch ? t('now.strip.web') : '');
    const speaks = cfg.ttsProvider === 'local' ? t('now.strip.local', { model: cfg.ttsLocalVoice }) : `OpenAI · ${cfg.ttsVoice}`;
    const cell = (label, value, section) =>
      h('a', { href: `#${section}` }, h('span.label', label), h('span.value', value));
    strip.replaceChildren(
      cell(t('now.strip.hears'), hears, 'hearing'),
      cell(t('now.strip.thinks'), thinks, 'thinking'),
      cell(t('now.strip.speaks'), speaks, 'speaking'),
    );
  }

  function renderStats(a, cfg) {
    stats.hidden = !a?.count;
    if (!a?.count) return;
    const cell = (value, unit, label) =>
      h('div.stat', h('span.value', value, unit ? h('small', unit) : null), h('span.label', label));
    const sec = (v) => (typeof v === 'number' ? (v / 1000).toFixed(1) : '—');
    stats.replaceChildren(
      ...[
        cell(String(a.count), '', t('now.stats.count')),
        cell(sec(a.firstAudioWithoutToolsMs), 's', t('now.stats.noTool')),
        cell(sec(a.firstAudioWithToolsMs), 's', t('now.stats.tools')),
        cfg.brainKind === 'cascade' ? cell(String(Math.round((a.escalationRate ?? 0) * 100)), '%', t('now.stats.handed')) : null,
        typeof a.beforeAskMs === 'number' ? cell(sec(a.beforeAskMs), 's', t('now.stats.beforeAsk')) : null,
      ].filter(Boolean),
    );
  }

  // --- top bar actions --------------------------------------------------------------

  const botButton = h('button.btn.quiet', { type: 'button' });
  botButton.addEventListener('click', () => {
    const action = botButton.dataset.action;
    act(() => post(`/api/bot/${action}`), t(action === 'start' ? 'bot.started.toast' : 'bot.stopped.toast'));
  });
  ctx.topbarActions.append(botButton);

  function renderBotButton(bot) {
    const running = bot.state === 'ready' || bot.state === 'starting';
    botButton.dataset.action = running ? 'stop' : 'start';
    botButton.textContent = running ? t('bot.stop') : t('bot.start');
    botButton.className = running ? 'btn quiet' : 'btn primary';
  }

  return {
    update(state) {
      renderBotButton(state.bot);
      renderSetup(state.config);
      renderJoin(state.guilds ?? [], state.sessions ?? []);
      renderCalls(state.sessions ?? []);
      renderRecent(state.sessions ?? []);
      renderStrip(state.config);
      renderStats(state.answers, state.config);
    },
    describeSeconds,
  };
}
