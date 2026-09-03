import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { sessionManager } from '../voice/manager.js';
import { formatTranscript, transcribeBuffer } from '../agent/stt.js';
import { ask, AgentBusyError } from '../agent/index.js';
import { mmss, noteInMusicChannel } from '../agent/tools/music.js';

export const commandData = [
  new SlashCommandBuilder()
    .setName('mj')
    .setDescription('Man in the Mirror — a voice agent that listens and answers')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('join')
        .setDescription('Join a voice channel')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel to join (defaults to yours)')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        ),
    )
    .addSubcommand((sub) => sub.setName('leave').setDescription('Leave the voice channel'))
    .addSubcommand((sub) =>
      sub.setName('transcript').setDescription('Transcribe what was said recently'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('ask')
        .setDescription('Ask the agent something — it answers out loud')
        .addStringOption((opt) =>
          opt
            .setName('question')
            .setDescription('What do you want to ask?')
            .setRequired(true)
            .setMaxLength(500),
        ),
    )
    .addSubcommand((sub) => sub.setName('shush').setDescription('Stop the agent mid-sentence'))
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Play a song, artist, album or URL, or queue it behind what is on')
        .addStringOption((opt) =>
          opt.setName('query').setDescription('What to play').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('skip').setDescription('Skip to the next song'))
    .addSubcommand((sub) => sub.setName('pause').setDescription('Pause the music'))
    .addSubcommand((sub) => sub.setName('resume').setDescription('Resume the music'))
    .addSubcommand((sub) => sub.setName('stop').setDescription('Stop the music and clear the queue'))
    .addSubcommand((sub) => sub.setName('queue').setDescription('What is playing and what is next'))
    .toJSON(),
];

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'mj') return;

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case 'join':
        return await cmdJoin(interaction);
      case 'leave':
        return await cmdLeave(interaction);
      case 'transcript':
        return await cmdTranscript(interaction);
      case 'ask':
        return await cmdAsk(interaction);
      case 'shush':
        return await cmdShush(interaction);
      case 'play':
        return await cmdPlay(interaction);
      case 'skip':
        return await cmdSkip(interaction);
      case 'pause':
        return await cmdPause(interaction);
      case 'resume':
        return await cmdResume(interaction);
      case 'stop':
        return await cmdStop(interaction);
      case 'queue':
        return await cmdQueue(interaction);
      default:
        return await interaction.reply(ephemeral('Unknown subcommand.'));
    }
  } catch (err) {
    console.error(`[bot] /mj ${sub} failed:`, err);
    const message = ephemeral(`Something broke: ${err.message}`);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(message).catch(() => {});
    } else {
      await interaction.reply(message).catch(() => {});
    }
  }
}

// --- connection -------------------------------------------------------------

async function cmdJoin(interaction) {
  const requested = interaction.options.getChannel('channel');
  const channel = requested ?? interaction.member?.voice?.channel;

  if (!channel) {
    return interaction.reply(
      ephemeral('Join a voice channel first, or pass one with `channel:`.'),
    );
  }

  const perms = channel.permissionsFor(interaction.guild.members.me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    return interaction.reply(
      ephemeral(`I need **Connect** and **Speak** permissions in ${channel}.`),
    );
  }

  await interaction.deferReply();
  await sessionManager.join(channel);

  return interaction.editReply(
    `🪞 In ${channel}, deafened. Run \`/mj listen\` when you want me hearing.`,
  );
}

async function cmdLeave(interaction) {
  const left = sessionManager.leave(interaction.guildId);
  return interaction.reply(
    ephemeral(left ? '👋 Left the channel.' : "I'm not in a voice channel here."),
  );
}

// --- listening --------------------------------------------------------------

async function cmdTranscript(interaction) {
  const session = requireSession(interaction);
  if (!session) return;

  if (!session.agentEnabled) {
    return interaction.reply(ephemeral('Not listening. Run `/mj listen` first.'));
  }

  const stats = session.receiver.buffer.stats();
  if (stats.utterances === 0) {
    return interaction.reply(ephemeral('Nothing buffered yet — nobody has spoken.'));
  }

  // Transcription takes seconds, well past Discord's 3s reply deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let result;
  try {
    result = await transcribeBuffer(session.receiver.buffer);
  } catch (err) {
    return interaction.editReply(`Transcription unavailable: ${err.message}`);
  }

  const text = formatTranscript(session.receiver.buffer.recent());
  if (!text) {
    // Distinguish "nothing was said" from "every request failed" — they look
    // identical in the output and have completely different fixes.
    return interaction.editReply(
      result.failed > 0
        ? `All ${result.failed} chunk(s) failed to transcribe. Check the server log for why.`
        : 'Got audio but no words out of it — likely too quiet or too short.',
    );
  }

  const header =
    `**Last ${stats.speechSeconds}s of speech, ${stats.speakers} speaker(s)** · ` +
    `${result.transcribed} new chunk(s) in ${(result.elapsedMs / 1000).toFixed(1)}s` +
    (result.failed ? ` · ${result.failed} failed` : '');

  // Discord caps messages at 2000 characters.
  const budget = 2000 - header.length - 20;
  const body = text.length > budget ? `…${text.slice(-budget)}` : text;

  return interaction.editReply(`${header}\n\`\`\`\n${body}\n\`\`\``);
}

async function cmdAsk(interaction) {
  const session = requireSession(interaction);
  if (!session) return;

  const question = interaction.options.getString('question');

  // The whole round trip is several seconds — past Discord's 3s deadline.
  await interaction.deferReply();

  let result;
  try {
    result = await ask(session, {
      question,
      askedBy: interaction.member?.displayName ?? interaction.user.username,
      // Without this, anything the agent does to the call is refused from a
      // slash command — the Discord tools check the asker's permissions, and
      // an ask with no id can't be trusted with anyone's. The interaction
      // carries the id already; it just wasn't being passed on.
      askedById: interaction.user.id,
    });
  } catch (err) {
    if (err instanceof AgentBusyError) {
      return interaction.editReply(`⏳ ${err.message}`);
    }
    return interaction.editReply(`Couldn't answer: ${err.message}`);
  }

  const t = result.timings;
  const detail =
    `heard ${(t.transcribeMs / 1000).toFixed(1)}s · ` +
    `thought ${(t.thinkMs / 1000).toFixed(1)}s · ` +
    `voiced ${(t.speakMs / 1000).toFixed(1)}s · ` +
    `${(t.totalMs / 1000).toFixed(1)}s total`;

  return interaction.editReply(
    `🗣️ ${result.spoken}${result.truncated ? ' *(trimmed)*' : ''}\n-# ${detail}`,
  );
}

// --- speaking ---------------------------------------------------------------

async function cmdShush(interaction) {
  const session = requireSession(interaction);
  if (!session) return;

  if (!session.speaking) {
    return interaction.reply(ephemeral("I'm not saying anything."));
  }
  session.shush();
  return interaction.reply('🤐 Stopped.');
}

// --- status -----------------------------------------------------------------

// --- helpers ----------------------------------------------------------------

// --- music ------------------------------------------------------------------
//
// The same player the agent drives by voice, reached without a model in the
// way: typing a title is the one case where nothing needs correcting, so the
// query goes to the search as written. What happened is written into the
// music channel exactly as it is for a spoken request, so the room learns
// about it the same way whichever path it came in by.

const requester = (interaction) =>
  interaction.member?.displayName ?? interaction.user?.username ?? 'someone';

const noteFrom = (interaction) => ({ guild: () => interaction.guild });

async function cmdPlay(interaction) {
  const query = interaction.options.getString('query')?.trim();
  if (!query) return interaction.reply(ephemeral('Tell me what to play.'));
  // Not in a channel yet: the one the caller is in is the obvious place, and
  // asking them to run /mj join first is a second command for no reason.
  let session = sessionManager.get(interaction.guildId);
  if (!session) {
    const channel = interaction.member?.voice?.channel;
    if (!channel) return interaction.reply(ephemeral('Join a voice channel first, so I know where to play it.'));
    const perms = channel.permissionsFor(interaction.guild.members.me);
    if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
      return interaction.reply(ephemeral(`I need **Connect** and **Speak** permissions in ${channel}.`));
    }
    await interaction.deferReply();
    session = await sessionManager.join(channel);
  } else {
    // Resolving a search takes seconds — past Discord's 3s reply deadline.
    await interaction.deferReply();
  }
  const who = requester(interaction);
  let result;
  try {
    result = await session.music.add(query, who);
  } catch (err) {
    return interaction.editReply(`Couldn't play that: ${err.message}`);
  }
  const { track, startedNow, position } = result;
  const line = startedNow
    ? `▶️  **${track.title}**  ·  ${mmss(track.seconds)}  ·  pedido por ${who}`
    : `➕  **${track.title}**  ·  en cola (${position})  ·  pedido por ${who}`;
  await noteInMusicChannel(noteFrom(interaction), line);
  return interaction.editReply(line);
}

async function cmdSkip(interaction) {
  const session = requireSession(interaction);
  if (!session) return;
  const skipped = session.music.skip();
  if (!skipped) return interaction.reply(ephemeral('Nothing is playing.'));
  const next = session.music.queue[0];
  const line = `⏭️  saltado: ${skipped.title}${next ? `  →  **${next.title}**` : ''}`;
  await noteInMusicChannel(noteFrom(interaction), line);
  return interaction.reply(ephemeral(line));
}

async function cmdPause(interaction) {
  const session = requireSession(interaction);
  if (!session) return;
  const paused = session.music.pause();
  return interaction.reply(ephemeral(paused ? '⏸️  Paused.' : 'Nothing to pause.'));
}

async function cmdResume(interaction) {
  const session = requireSession(interaction);
  if (!session) return;
  const resumed = session.music.resume();
  return interaction.reply(ephemeral(resumed ? '▶️  Resumed.' : 'Nothing to resume.'));
}

async function cmdStop(interaction) {
  const session = requireSession(interaction);
  if (!session) return;
  if (!session.music.current && session.music.queue.length === 0) {
    return interaction.reply(ephemeral('Nothing is playing.'));
  }
  session.music.stop();
  await noteInMusicChannel(noteFrom(interaction), '⏹️  detenido, cola vacía');
  return interaction.reply(ephemeral('⏹️  Stopped, queue cleared.'));
}

async function cmdQueue(interaction) {
  const session = requireSession(interaction);
  if (!session) return;
  const { current, queue, paused, volume } = session.musicStatus();
  if (!current && queue.length === 0) return interaction.reply(ephemeral('Nothing is playing.'));
  const lines = [];
  if (current) {
    lines.push(
      `${paused ? '⏸️' : '▶️'}  **${current.title}**` +
        (current.seconds ? `  ·  ${mmss(current.seconds)}` : '') +
        `  ·  pedido por ${current.requestedBy}  ·  volumen ${volume}`,
    );
  }
  queue.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title}  ·  ${t.requestedBy}`));
  if (queue.length > 10) lines.push(`… y ${queue.length - 10} más`);
  return interaction.reply(ephemeral(lines.join('\n')));
}

function requireSession(interaction) {
  const session = sessionManager.get(interaction.guildId);
  if (!session) {
    interaction.reply(ephemeral('Not in a voice channel — use `/mj join` first.'));
    return null;
  }
  return session;
}
