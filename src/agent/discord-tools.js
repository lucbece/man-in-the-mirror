/**
 * Letting the agent act on the voice channel: move people, disconnect them,
 * mute them, leave.
 *
 * Two things make this different from every other tool the agent has, and both
 * are about the fact that anyone in the call can talk to it.
 *
 * **The bot must not become a way around Discord's permissions.** It holds
 * Move Members and Mute Members so it can do this at all, which means that
 * without a check, any person in the channel could say "espejo, desconectá a
 * fulano" and have it happen — the bot's permissions, borrowed by someone who
 * doesn't have them. So every action checks *the person who asked*, not the
 * bot. Discord identifies them by which audio stream the request arrived on,
 * so that identity is not something a speaker can claim or spoof by saying a
 * name.
 *
 * **A misheard name must not disconnect the wrong person.** Names come out of
 * speech recognition, and it mangles them. So resolution refuses whenever it
 * is unsure, and refuses again when two people match equally well. Saying "no
 * sé a quién te referís" costs a repeat; kicking the wrong person out of the
 * call costs an apology.
 */
import { PermissionFlagsBits } from 'discord.js';

import { normalise, similarity } from './wake.js';

/** Below this, a spoken name is not confidently anyone. */
const NAME_THRESHOLD = 0.7;

export class DiscordToolError extends Error {}

/**
 * Everyone currently in a voice channel in this guild.
 *
 * The candidate set is deliberately not "every member of the server": these
 * actions only make sense on someone who is in voice, and the bot doesn't
 * carry the privileged Guild Members intent, so this is also the only set it
 * can see reliably.
 */
export function voiceMembers(guild) {
  const seen = new Map();
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isVoiceBased?.()) continue;
    for (const member of channel.members.values()) seen.set(member.id, member);
  }
  return [...seen.values()];
}

/** Every name a person might be called by, normalised. */
function namesOf(member) {
  return [member.displayName, member.nickname, member.user?.username, member.user?.globalName]
    .filter(Boolean)
    .map(normalise);
}

/**
 * Work out who was meant, or refuse.
 *
 * Tiers, best first: an exact match on one of their names; the spoken name
 * being one of the words in their name ("fulanito" in "Fulanito Pérez"); then
 * fuzzy similarity. A tie inside the winning tier is an ambiguity, not a
 * coin flip.
 */
export function resolveMember(spoken, members) {
  const needle = normalise(spoken ?? '');
  if (!needle) throw new DiscordToolError('No name given.');

  const scored = members.map((member) => {
    let best = 0;
    for (const name of namesOf(member)) {
      if (name === needle) best = Math.max(best, 3);
      else if (name.split(' ').includes(needle)) best = Math.max(best, 2);
      else best = Math.max(best, similarity(name, needle));
    }
    return { member, score: best };
  });

  const top = Math.max(0, ...scored.map((s) => s.score));
  if (top < NAME_THRESHOLD) {
    const who = members.map((m) => m.displayName).join(', ') || 'nobody';
    throw new DiscordToolError(
      `No one here matches "${spoken}". In voice right now: ${who}.`,
    );
  }

  const winners = scored.filter((s) => s.score === top);
  if (winners.length > 1) {
    throw new DiscordToolError(
      `"${spoken}" could be ${winners.map((w) => w.member.displayName).join(' or ')} — ask which.`,
    );
  }
  return winners[0].member;
}

/**
 * Refuse unless the person who asked could have done it themselves.
 *
 * This is the whole security model. The bot is not a shortcut around a
 * permission someone doesn't have.
 */
export function requirePermission(guild, askerId, flag, what) {
  if (!askerId) {
    throw new DiscordToolError(`I can't tell who's asking, so I won't ${what}.`);
  }
  const asker = guild.members.cache.get(askerId);
  if (!asker) {
    throw new DiscordToolError(`I can't tell who's asking, so I won't ${what}.`);
  }
  if (!asker.permissions.has(flag)) {
    throw new DiscordToolError(`${asker.displayName} doesn't have permission to ${what}.`);
  }
  const me = guild.members.me;
  if (!me?.permissions.has(flag)) {
    throw new DiscordToolError(`I don't have permission to ${what} — check my role.`);
  }
  return asker;
}

/** A voice channel by spoken name, or the one the asker is in. */
function resolveChannel(guild, spoken, asker) {
  if (!spoken) {
    const channel = asker.voice?.channel;
    if (!channel) throw new DiscordToolError('You are not in a voice channel.');
    return channel;
  }

  const needle = normalise(spoken);
  const channels = guild.channels.cache.filter((c) => c.isVoiceBased?.());
  let best = null;
  for (const channel of channels.values()) {
    const score = normalise(channel.name) === needle ? 1 : similarity(normalise(channel.name), needle);
    if (!best || score > best.score) best = { channel, score };
  }
  if (!best || best.score < NAME_THRESHOLD) {
    throw new DiscordToolError(`No voice channel called "${spoken}".`);
  }
  return best.channel;
}

/** Human-readable summary of who is where, for the agent to reason over. */
export function describeVoice(guild) {
  const lines = [];
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isVoiceBased?.()) continue;
    const members = [...channel.members.values()];
    if (!members.length) continue;
    lines.push(
      `${channel.name}: ${members
        .map((m) => `${m.displayName}${m.voice.serverMute ? ' (muted)' : ''}`)
        .join(', ')}`,
    );
  }
  return lines.length ? lines.join('\n') : 'Nobody is in a voice channel.';
}

export async function moveMember(guild, askerId, { name, channel: channelName }) {
  const asker = requirePermission(guild, askerId, PermissionFlagsBits.MoveMembers, 'move people');
  const member = resolveMember(name, voiceMembers(guild));
  const channel = resolveChannel(guild, channelName, asker);

  if (!member.voice?.channelId) {
    throw new DiscordToolError(`${member.displayName} isn't in a voice channel.`);
  }
  if (member.voice.channelId === channel.id) {
    return `${member.displayName} is already in ${channel.name}.`;
  }

  await member.voice.setChannel(channel, `Asked by ${asker.displayName} through the voice agent`);
  return `Moved ${member.displayName} to ${channel.name}.`;
}

export async function disconnectMember(guild, askerId, { name }) {
  const asker = requirePermission(
    guild, askerId, PermissionFlagsBits.MoveMembers, 'disconnect people',
  );
  const member = resolveMember(name, voiceMembers(guild));
  if (!member.voice?.channelId) {
    return `${member.displayName} isn't connected.`;
  }
  await member.voice.disconnect(`Asked by ${asker.displayName} through the voice agent`);
  return `Disconnected ${member.displayName}.`;
}

export async function setMemberMute(guild, askerId, { name, muted }) {
  const asker = requirePermission(
    guild, askerId, PermissionFlagsBits.MuteMembers, muted ? 'mute people' : 'unmute people',
  );
  const member = resolveMember(name, voiceMembers(guild));
  if (!member.voice?.channelId) {
    throw new DiscordToolError(`${member.displayName} isn't in a voice channel.`);
  }
  if (member.voice.serverMute === muted) {
    return `${member.displayName} is already ${muted ? 'muted' : 'unmuted'}.`;
  }
  await member.voice.setMute(muted, `Asked by ${asker.displayName} through the voice agent`);
  return `${muted ? 'Muted' : 'Unmuted'} ${member.displayName}.`;
}
