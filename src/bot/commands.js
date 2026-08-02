import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { config } from '../config.js';
import { sounds } from '../sounds.js';
import { sessionManager } from '../voice/manager.js';

export const commandData = [
  new SlashCommandBuilder()
    .setName('mj')
    .setDescription('Man in the Mirror — Michael Jackson soundboard')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('join')
        .setDescription('Join a voice channel and start dropping sounds')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Channel to join (defaults to yours)')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        ),
    )
    .addSubcommand((sub) => sub.setName('leave').setDescription('Leave the voice channel'))
    .addSubcommand((sub) =>
      sub.setName('start').setDescription('Resume the random sound scheduler'),
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Pause the scheduler (stays in the channel)'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Play a sound right now')
        .addStringOption((opt) =>
          opt
            .setName('sound')
            .setDescription('Specific sound (defaults to random)')
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show what the bot is up to'),
    )
    .addSubcommand((sub) => sub.setName('sounds').setDescription('List available sounds'))
    .addSubcommand((sub) =>
      sub
        .setName('interval')
        .setDescription('Set the random gap between sounds')
        .addIntegerOption((opt) =>
          opt
            .setName('min')
            .setDescription('Minimum seconds')
            .setMinValue(1)
            .setMaxValue(3600)
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max')
            .setDescription('Maximum seconds')
            .setMinValue(1)
            .setMaxValue(3600)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('volume')
        .setDescription('Set playback volume (0-200%)')
        .addIntegerOption((opt) =>
          opt
            .setName('percent')
            .setDescription('Volume percentage')
            .setMinValue(0)
            .setMaxValue(200)
            .setRequired(true),
        ),
    )
    .toJSON(),
];

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export async function handleInteraction(interaction) {
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'mj') return;

  const sub = interaction.options.getSubcommand();

  try {
    switch (sub) {
      case 'join':
        return await cmdJoin(interaction);
      case 'leave':
        return await cmdLeave(interaction);
      case 'start':
        return await cmdStart(interaction);
      case 'stop':
        return await cmdStop(interaction);
      case 'play':
        return await cmdPlay(interaction);
      case 'status':
        return await cmdStatus(interaction);
      case 'sounds':
        return await cmdSounds(interaction);
      case 'interval':
        return await cmdInterval(interaction);
      case 'volume':
        return await cmdVolume(interaction);
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

async function handleAutocomplete(interaction) {
  const typed = (interaction.options.getFocused() ?? '').toLowerCase();
  const choices = sounds
    .refresh()
    .filter((name) => name.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((name) => ({ name: name.slice(0, 100), value: name.slice(0, 100) }));
  await interaction.respond(choices).catch(() => {});
}

// --- subcommands ------------------------------------------------------------

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
  const session = await sessionManager.join(channel);
  sounds.refresh();

  const note =
    sounds.size === 0
      ? '\n⚠️ No sound files found in `sounds/` yet — add some and I will start using them.'
      : '';

  return interaction.editReply(
    `🕺 In ${channel}. ${describeSchedule(session)}${note}`,
  );
}

async function cmdLeave(interaction) {
  const left = sessionManager.leave(interaction.guildId);
  return interaction.reply(
    ephemeral(left ? '👋 Left the channel.' : "I'm not in a voice channel here."),
  );
}

async function cmdStart(interaction) {
  const session = requireSession(interaction);
  if (!session) return;
  session.start({ immediate: false });
  return interaction.reply(`▶️ ${describeSchedule(session)}`);
}

async function cmdStop(interaction) {
  const session = requireSession(interaction);
  if (!session) return;
  session.stop();
  return interaction.reply('⏸️ Scheduler paused. Still in the channel.');
}

async function cmdPlay(interaction) {
  const session = requireSession(interaction);
  if (!session) return;

  const requested = interaction.options.getString('sound');
  let file = null;
  if (requested) {
    file = sounds.resolve(requested);
    if (!file) return interaction.reply(ephemeral(`No sound named \`${requested}\`.`));
  }

  const played = session.playRandom(file);
  if (!played) {
    return interaction.reply(
      ephemeral(
        sounds.size === 0
          ? 'No sounds available — drop files into the `sounds/` folder.'
          : 'Skipped: nobody is in the channel.',
      ),
    );
  }
  return interaction.reply(`🔊 ${session.lastPlayed}`);
}

async function cmdStatus(interaction) {
  const session = sessionManager.get(interaction.guildId);
  const cfg = config.all();

  const lines = [
    `**Sounds loaded:** ${sounds.refresh().length}`,
    `**Interval:** ${cfg.minIntervalSeconds}–${cfg.maxIntervalSeconds}s`,
    `**Volume:** ${Math.round(cfg.volume * 100)}%`,
  ];

  if (!session) {
    lines.unshift('**Voice:** not connected');
  } else {
    const s = session.status();
    lines.unshift(`**Voice:** <#${s.channelId}> (${s.listeners} listening)`);
    lines.push(`**Scheduler:** ${s.running ? 'running' : 'paused'}`);
    if (s.secondsUntilNext !== null) lines.push(`**Next sound in:** ~${s.secondsUntilNext}s`);
    if (s.lastPlayed) lines.push(`**Last played:** ${s.lastPlayed} (${s.playCount} total)`);
  }

  return interaction.reply(ephemeral(lines.join('\n')));
}

async function cmdSounds(interaction) {
  const files = sounds.refresh();
  if (files.length === 0) {
    return interaction.reply(
      ephemeral('No sounds yet. Drop audio files into the `sounds/` folder.'),
    );
  }
  const shown = files.slice(0, 40).map((f) => `• ${f}`);
  const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more` : '';
  return interaction.reply(ephemeral(`**${files.length} sounds:**\n${shown.join('\n')}${more}`));
}

async function cmdInterval(interaction) {
  const min = interaction.options.getInteger('min');
  const max = interaction.options.getInteger('max');
  const next = config.update({ minIntervalSeconds: min, maxIntervalSeconds: max });

  const session = sessionManager.get(interaction.guildId);
  if (session?.running) session.scheduleNext();

  return interaction.reply(
    `⏱️ Sounds now every ${next.minIntervalSeconds}–${next.maxIntervalSeconds}s.`,
  );
}

async function cmdVolume(interaction) {
  const percent = interaction.options.getInteger('percent');
  const next = config.update({ volume: percent / 100 });
  return interaction.reply(`🔉 Volume set to ${Math.round(next.volume * 100)}%.`);
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

function describeSchedule(session) {
  const cfg = config.all();
  if (!session.running) return 'Scheduler is paused.';
  return `Sounds every ${cfg.minIntervalSeconds}–${cfg.maxIntervalSeconds}s.`;
}
