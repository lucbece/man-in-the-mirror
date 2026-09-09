/**
 * Looking at the Project Zomboid server, and only looking.
 *
 * The one thing the zomboid mode can do entirely on its own: ask the game
 * whether it is there. It is a UDP query with no credentials behind it (see
 * agent/a2s.js), so nothing here needs a key, a role or anybody's permission —
 * which is why it is the first tool the mode gets and the one it can use in
 * front of the whole room.
 *
 * What it deliberately cannot do is start or stop the machine. That switch
 * belongs to `pz-bot`, a separate bot with an Oracle policy pinned to that one
 * instance; this bot asking for those credentials would undo that design. So
 * when the server is not there, the answer is the state and the command a
 * person can type — never an action taken on their behalf.
 *
 * The other half of why that matters: **the machine being off is the normal
 * state**, not a fault. It powers itself down after half an hour with nobody
 * playing, which is where the hosting bill goes from real to nearly nothing.
 * A tool that reported that as an error would have the mode announcing a
 * disaster every evening before anyone starts playing.
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';

import { NoAnswer, query } from '../a2s.js';
import { config } from '../../config.js';
import { speakableTool } from './wrappers.js';

/** Split "host" or "host:port" into what the query needs. */
export function splitAddress(address) {
  const trimmed = String(address ?? '').trim();
  if (!trimmed) return null;
  const [host, port] = trimmed.split(':');
  if (!host) return null;
  const parsed = Number(port);
  return { host, port: Number.isInteger(parsed) && parsed > 0 ? parsed : 16261 };
}

/**
 * What to tell the agent, from what the game said.
 *
 * Pulled out of the tool so the wording — which is most of the value here —
 * can be read and changed without a Discord connection anywhere near it.
 */
export function describeServer(info) {
  const players =
    info.players === 0
      ? 'nobody playing'
      : `${info.players} of ${info.maxPlayers} playing`;
  return (
    `The server is up: "${info.name}", map ${info.map}, ${players}, build ${info.version}. ` +
    'Say this in one short sentence. The player count is the part they care about.'
  );
}

/** What to tell the agent when nothing answered. */
export function describeSilence() {
  return (
    'The server did not answer. This is usually not a fault: the machine powers itself off ' +
    'after half an hour with nobody playing, and it is off most of the time. ' +
    'Say that it is not up, in one sentence, and that whoever wants to play can type /pz start ' +
    'in Discord — it takes about three minutes. Never say that you started it or that you will: ' +
    'you cannot, that switch belongs to another bot.'
  );
}

export function zomboidTools() {
  return [
    tool(
      'zomboid_status',
      'Ask the Project Zomboid server how it is: whether it is up, who is playing, which map and which build.\n\n' +
        'Use this for anything about the state of that server — "¿está arriba?", "¿cuántos hay jugando?", "¿anda el server?", "is the server up". ' +
        'Always use it rather than answering from memory: you have no way of knowing any of this without asking.\n\n' +
        'It only looks. It cannot start or stop the machine, and neither can you.',
      {},
      speakableTool(async () => {
        const address = splitAddress(config.get('zomboidAddress'));
        if (!address) {
          return (
            'No Project Zomboid server is configured, so there is nothing to ask. ' +
            'Say that you do not have the server address, in one sentence.'
          );
        }
        try {
          return describeServer(await query(address));
        } catch (err) {
          if (err instanceof NoAnswer) return describeSilence();
          // Something else went wrong — a name that does not resolve, a
          // malformed answer. Say what happened rather than reporting it as
          // the server being down, which is a different thing.
          return (
            `Could not ask the server: ${err.message}. Say in one sentence that you could not reach it, ` +
            'and do not guess whether it is up.'
          );
        }
      }),
    ),
  ];
}
