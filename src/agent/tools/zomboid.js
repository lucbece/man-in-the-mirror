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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { NoAnswer, query } from '../a2s.js';
import { config } from '../../config.js';
import { DiscordToolError, requireRole } from '../discord-tools.js';
import { modeByName } from '../modes.js';
import { writeToChannel } from './music.js';
import { discordTool, speakableTool } from './wrappers.js';

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

/**
 * Where the key that opens the door lives.
 *
 * In the data volume beside the other secret the bot keeps on disk, the
 * YouTube cookies, and for the same reason: it survives a redeploy and it
 * never goes near the repository. Mode 0600, put there by hand.
 */
export const KEY_PATH = process.env.MIRROR_ZOMBOID_KEY ?? path.join('data', 'zomboid-key');

/** Long enough for a real diagnosis, short enough that a room is still listening. */
export const ASK_TIMEOUT_MS = 150_000;

/**
 * Send a question through the door and bring back what came out.
 *
 * One ssh connection to a key whose `authorized_keys` entry pins it to a
 * single script with `command=`: it cannot open a shell, cannot forward a
 * port, cannot run anything else. The question goes on stdin — the same
 * reason the script reads it there, since with a forced command the client's
 * command line is not the channel.
 *
 * The far side always answers with one line of JSON, including when it
 * refuses, so anything that is not JSON is this side's problem: the machine
 * is off, the key is wrong, the network went away.
 */
export function askOverSsh({ destination, keyPath, question, act, timeoutMs = ASK_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh',
      [
        '-i', keyPath,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10',
        destination,
        // Passed for the day the far side stops forcing the command; with a
        // forced command it is ignored, which is the point of forcing it.
        act ? '--completo' : '--read',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new DiscordToolError('the server took too long to answer'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new DiscordToolError(`could not reach the server: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop();
      if (!line) {
        reject(new DiscordToolError(`the server said nothing (exit ${code})${err ? `: ${err.trim().slice(0, 120)}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new DiscordToolError(`the server answered something I could not read: ${line.slice(0, 120)}`));
      }
    });

    child.stdin.end(String(question ?? ''));
  });
}

export function zomboidTools(turn, deps = {}) {
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
    tool(
      'zomboid_ask',
      'Ask the operator that lives on the server itself — it can read the logs, the configuration and the state of the machine, and answer with what it found.\n\n' +
        'Use this for anything that needs looking at something rather than knowing it: "¿por qué se cayó?", "fijate si hay errores de un mod", "¿cuánto disco queda?", "revisá el log de hace una hora". Not for the state of the server, which zomboid_status answers in a second and for free.\n\n' +
        'It takes up to a couple of minutes. Say one short line first — "dame un segundo que me fijo" — before calling it.\n\n' +
        'Set `act` to true ONLY when they asked you to change something: restart it, fix a configuration file, disable a mod. Anything that only looks stays false, and false is the default. Acting needs a role, and you will be refused if the person asking does not have it — say the refusal out loud.\n\n' +
        'Pass their request as they made it, in their own words. Do not add what the room was talking about.',
      {
        question: z.string().describe("What to ask, in the asker's words, one or two sentences."),
        act: z
          .boolean()
          .optional()
          .describe('True only if carrying this out changes something on the server.'),
      },
      discordTool(turn, async (guild, askerId, { question, act = false }) => {
        const mode = modeByName('zomboid');
        const destination = config.get('zomboidSsh');
        if (!destination) {
          throw new DiscordToolError(
            'There is no way in to the server configured, so I cannot ask it anything.',
          );
        }
        const keyPath = deps.keyPath ?? KEY_PATH;
        if (!deps.ask && !fs.existsSync(keyPath)) {
          throw new DiscordToolError('The key to the server is not on this machine.');
        }
        // The second tier of the gate. Entering the character is already gated;
        // this is the line between looking and changing, checked against the
        // person who spoke this turn rather than whoever turned the mode on.
        if (act) requireRole(guild, askerId, mode.actRole, 'change anything on the server');

        const send = deps.ask ?? askOverSsh;
        const answer = await send({ destination, keyPath, question, act });
        const spoken = String(answer?.spoken ?? '').trim();
        const detail = String(answer?.detail ?? '').trim();

        // The long half never gets spoken. It goes where the room already
        // reads about this server, and the voice says one line about it.
        let wrote = false;
        if (detail && detail !== spoken) {
          wrote = await writeToChannel(
            guild,
            mode.detailChannel,
            `🧟  **${act ? 'Hice' : 'Miré'}, a pedido de ${turn.askerName ?? 'alguien'}**\n${detail}`.slice(0, 1900),
          );
        }
        console.log(`[zomboid] asked (${act ? 'act' : 'read'}): "${String(question).slice(0, 80)}" → ${answer?.ok ? 'ok' : 'not ok'}`);

        if (!spoken) {
          return 'The server answered, but with nothing sayable. Say you could not get a clear answer.';
        }
        return (
          `Say this, or something very close to it: "${spoken}"` +
          (wrote ? ' Then add, in a few words, that the rest is written in the channel.' : '')
        );
      }),
    ),
  ];
}
