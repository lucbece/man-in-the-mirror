import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { config } from '../config.js';
import { sessionManager } from '../voice/manager.js';
import { formatTranscript, transcribeBuffer } from '../agent/stt.js';
import { ask, AgentBusyError } from '../agent/index.js';

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
      sub
        .setName('listen')
        .setDescription('Start listening (the bot un-deafens and buffers audio)'),
    )
    .addSubcommand((sub) =>
      sub.setName('deaf').setDescription('Stop listening and wipe the buffered audio'),
    )
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
      sub.setName('status').setDescription('Show what the bot is up to'),
    )
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
      case 'listen':
        return await cmdListen(interaction);
      case 'deaf':
        return await cmdDeaf(interaction);
      case 'transcript':
        return await cmdTranscript(interaction);
      case 'ask':
        return await cmdAsk(interaction);
      case 'shush':
        return await cmdShush(interaction);
      case 'status':
        return await cmdStatus(interaction);
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

async function cmdListen(interaction) {
  const session = requireSession(interaction);
  if (!session) return;

  if (session.agentEnabled) {
    return interaction.reply(ephemeral('Already listening. `/mj transcript` to read it back.'));
  }

  await interaction.deferReply();
  config.update({ agentEnabled: true });
  await session.setAgentEnabled(true);

  const minutes = Math.round(config.get('bufferSeconds') / 60);
  return interaction.editReply(
    [
      `👂 **Listening.** Keeping the last ${minutes} minute(s) of audio in memory.`,
      '',
      'Nothing is transcribed until someone runs `/mj transcript`, nothing is written to disk,',
      'and anything older than the window is dropped. `/mj deaf` stops this and wipes the buffer.',
    ].join('\n'),
  );
}

async function cmdDeaf(interaction) {
  const session = requireSession(interaction);
  if (!session) return;

  if (!session.agentEnabled) {
    return interaction.reply(ephemeral("I'm already deafened — not receiving any audio."));
  }

  await interaction.deferReply();
  config.update({ agentEnabled: false });
  await session.setAgentEnabled(false);

  return interaction.editReply('🙉 **Deafened.** Buffer wiped, no longer receiving audio.');
}

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

async function cmdStatus(interaction) {
  const session = sessionManager.get(interaction.guildId);
  const cfg = config.all();

  const lines = [];

  if (!session) {
    lines.unshift('**Voice:** not connected');
  } else {
    const s = session.status();
    lines.unshift(`**Voice:** <#${s.channelId}> (${s.listeners} in channel)`);

    if (s.agentEnabled) {
      const l = s.listening;
      lines.push(
        `**Listening:** yes — ${l.utterances} utterance(s), ` +
          `${l.speechSeconds}s of speech from ${l.speakers} speaker(s), ` +
          `${l.pendingUtterances} not yet transcribed`,
      );
    } else {
      lines.push('**Listening:** no (deafened)');
    }
  }

  lines.push(
    `**Transcription:** ${cfg.sttProvider}` +
      (cfg.sttProvider === 'openai' && !cfg.openaiApiKey ? ' ⚠️ no API key set' : ''),
  );

  return interaction.reply(ephemeral(lines.join('\n')));
}

// --- helpers ----------------------------------------------------------------

function requireSession(interaction) {
  const session = sessionManager.get(interaction.guildId);
  if (!session) {
    interaction.reply(ephemeral('Not in a voice channel — use `/mj join` first.'));
    return null;
  }
  return session;
}
