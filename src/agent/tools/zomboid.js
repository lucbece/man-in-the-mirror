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

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { z } from 'zod';

import { NoAnswer, query } from '../a2s.js';
import { config } from '../../config.js';
import { dataPath } from '../../data-dir.js';
import { DiscordToolError, requireRole } from '../discord-tools.js';
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
 * Two keys, because one key is one mode.
 *
 * The far side pins each key to a fixed command in `authorized_keys`, and a
 * forced command ignores whatever the client asks for. So the difference
 * between looking and changing cannot be an argument this side sends: it has
 * to be *which key* is used. That is better than a flag — the decision is
 * materialised in a file that exists or does not, rather than in a model
 * reasoning correctly about a boolean.
 *
 * They live in the data volume beside the other secret the bot keeps on disk,
 * the YouTube cookies, and for the same reason: they survive a redeploy and
 * they never go near the repository. Mode 0600, put there by hand. Without the
 * second one the character can only look, which is the right thing to be true
 * by default.
 */
/**
 * The key works, the machine is up, and the script it points at is not there.
 *
 * Its own error because it is its own state and its own sentence: nothing is
 * broken and nothing is refusing, the far side is simply not finished being
 * set up. Told apart from a refusal, which answers in JSON, and from an
 * asleep machine, which does not answer at all.
 */
export class DoorMissing extends DiscordToolError {}

/**
 * The key was offered and the server would not take it.
 *
 * The expected state for a while, and by design: the act key exists on this
 * side long before anybody authorises it on that side, because "without the
 * second key it can only look" is the default worth having. Its own error so
 * the room hears what is true — that it may look and not touch — rather than
 * an ssh exit code, which is what it sounded like the first time.
 */
export class KeyRefused extends DiscordToolError {}

export const KEYS = {
  read: process.env.MIRROR_ZOMBOID_KEY ?? dataPath('zomboid-key'),
  act: process.env.MIRROR_ZOMBOID_ACT_KEY ?? dataPath('zomboid-key-act'),
};

/** Long enough for a real diagnosis, short enough that a room is still listening. */
export const ASK_TIMEOUT_MS = 150_000;

/**
 * How long `zomboid_ask` waits inside the turn before it stops waiting and
 * tells the room the answer is coming later.
 *
 * Measured on the real door: a status question takes 12 turns and 85 s end to
 * end, a refusal 13 s. The agent's own turn is cut at `TURN_TIMEOUT_MS =
 * 120_000` (agent-brain.js) — past that the answer is not late, it is gone.
 * Waiting anywhere near the full 85 s risks losing the slow ones to that
 * ceiling, and the room hears nothing for most of a minute and a half either
 * way, which reads as the bot being broken well before either number is
 * reached. Twenty seconds still lets the common case — a refusal, an answer
 * the door already had cached — come back directly, and is short enough that
 * "still working, te aviso" never feels like a stall.
 *
 * Read through `deps.quickAnswerMs` rather than compared against directly, so
 * a test can shrink the wait without the run itself taking twenty seconds.
 */
export const QUICK_ANSWER_MS = 20_000;

/**
 * Where a late answer surfaces once the ssh call it belongs to finally
 * settles, after the turn has already ended.
 *
 * `zomboid_ask` keeps listening after telling the model to say "te aviso" and
 * stop; when the door answers, it writes the detail channel itself — that
 * needs `guild` and `mode`, which only the tool has — and emits here with
 * just what a listener needs to speak it. `manager.js` is that listener, the
 * same way it already is for `reminders`: `speakUnprompted(guildId, spoken, …)`.
 */
export const lateAnswers = new EventEmitter();

/**
 * Which of the named failure states an ssh rejection is.
 *
 * Pulled out of the on-time path so a late failure is told apart the same
 * way an on-time one would have been. Three named states — KeyRefused,
 * DoorMissing, and the machine being asleep, which is the normal state most
 * of the day by design and the reason "I could not reach the server" would
 * be a lie most evenings — told apart from a fault by the cheap A2S probe
 * rather than by the failure of the expensive call. `'other'` is everything
 * else, which the two callers below handle differently: the on-time path
 * still has a model to hand the original error to, the late path does not.
 */
async function classifyAskFailure(err) {
  if (err instanceof KeyRefused) return 'keyRefused';
  if (err instanceof DoorMissing) return 'doorMissing';
  const at = splitAddress(config.get('zomboidAddress'));
  const asleep = at ? await query(at).then(() => false, () => true) : true;
  return asleep ? 'asleep' : 'other';
}

/**
 * The instruction the on-time path hands the model for a named state.
 *
 * `null` for `'other'` on purpose: that case is not a sentence to say, it is
 * the original error, rethrown as before so `discordTool`'s own handling of
 * a non-`DiscordToolError` (see wrappers.js) applies exactly as it always
 * did — this function has nothing useful to add there.
 */
function askFailureInstruction(state, { act } = {}) {
  switch (state) {
    case 'keyRefused':
      return act
        ? 'the server lets me look but has not been told to let me change anything — say that in one sentence, and that somebody with access has to allow it'
        : 'the server did not accept my key — say that in one sentence';
    case 'doorMissing':
      return 'I can reach the server but the part of it that answers questions is not installed yet — say that in one sentence';
    case 'asleep':
      return 'the machine is not up, which is normal — say so and that whoever wants it can type /pz start';
    default:
      return null;
  }
}

/**
 * The sentence the late path speaks directly for a failure.
 *
 * `askFailureInstruction`'s strings are not it — those are written to be
 * rewritten by the model ("say that in one sentence"), and the late path has
 * no model in the loop to do the rewriting; said verbatim they would come out
 * of the bot's mouth as stage directions. This is the room-facing sentence
 * itself, in the room's language.
 */
function askFailureSpoken(state, { act } = {}) {
  switch (state) {
    case 'keyRefused':
      return act
        ? 'El servidor me deja mirar, pero no le dijeron que me deje cambiar nada.'
        : 'El servidor no aceptó mi llave.';
    case 'doorMissing':
      return 'Llego al servidor, pero la parte que responde preguntas no está instalada.';
    case 'asleep':
      return 'La máquina está apagada, que es lo normal; cualquiera la prende con /pz start.';
    default:
      return 'No pude conseguir la respuesta del servidor.';
  }
}

/**
 * Write the long half to the detail channel and hand back what to say.
 *
 * Shared by the on-time and late paths so a question answered after the turn
 * ended is written up exactly like one answered inside it.
 */
async function deliverAnswer(guild, mode, turn, answer, act) {
  const spoken = String(answer?.spoken ?? '').trim();
  const detail = String(answer?.detail ?? '').trim();
  // The long half never gets spoken. It goes where the room already
  // reads about this server, and the voice says one line about it.
  let wrote = false;
  if (detail && detail !== spoken) {
    wrote = await writeToChannel(
      guild,
      mode?.detailChannel,
      `🧟  **${act ? 'Hice' : 'Miré'}, a pedido de ${turn.askerName ?? 'alguien'}**\n${detail}`.slice(0, 1900),
    );
  }
  return { spoken, detail, wrote };
}

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
export function sshArgs({ destination, keyPath, act }) {
  return [
    '-i', keyPath,
    // Without this, `-i` is a suggestion. ssh offers every identity it can
    // find — the ones in the agent, the default names in ~/.ssh — and the
    // server accepts the first that matches, so a question meant to be
    // read-only could authenticate with the key that is allowed to change
    // things, with nobody deciding it. The whole premise of two keys is that
    // which one is used *is* the permission, and this is what makes that true
    // rather than likely. `IdentityAgent=none` is the same point for an agent
    // that might exist in the container's environment.
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    destination,
    // ssh keeps reading options after the destination, so a remote command
    // that begins with a dash is taken as one of its own and it exits with a
    // usage error before it opens a socket. Found by knocking on the real
    // door: `ssh host --read` is "unknown option -- -".
    '--',
    // Ignored while the far side forces its command, which is the point of
    // forcing it. Sent anyway so the day somebody unpins a key, the two ends
    // still agree about which mode was asked for.
    act ? '--completo' : '--read',
  ];
}

/**
 * What travels with every question, after the asker's own words.
 *
 * Measured on the real door (2026-09-11): an investigation question — "some
 * players lost their explored map a few days ago, find out why" — burned
 * eleven turns and 351 thousand tokens of input without reaching an answer,
 * because each read the operator made came back as a mountain: hours of
 * container log, unbounded journal. The turn cap was not the limit; the
 * volume per call was. The far side's own rules say the same, but a rule
 * that also arrives with the question is one the operator cannot miss, and
 * it costs nothing. Labelled as the bot's note so it is never mistaken for
 * something the person said.
 */
export const DOOR_BRIEF_FOOTER =
  '\n\n(Nota del bot, no de quien pregunta: lecturas acotadas siempre — docker compose logs --tail 200, ' +
  'journalctl --no-pager -n 200, y --since solo en minutos u horas, nunca días sin --tail. ' +
  'Si es una investigación, primero nombres y tamaños — ls -l, find -size 0, stat sobre data/ — ' +
  'y recién después el log del minuto que esos archivos señalen. Contestá en una o dos frases.)';

export function doorBrief(question) {
  return String(question ?? '').trim() + DOOR_BRIEF_FOOTER;
}

export function askOverSsh({ destination, keyPath, question, act, timeoutMs = ASK_TIMEOUT_MS, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', sshArgs({ destination, keyPath, act }), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
      let parsed = null;
      if (line) {
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = null;
        }
      }
      if (parsed) {
        resolve(parsed);
        return;
      }
      // 127 is a shell saying the command does not exist, which here means one
      // exact thing: the key is installed and pinned to a script the machine
      // has not got yet. That is a different state from the door refusing and
      // from there being no machine, and it is the one to expect first — the
      // copy of the repo on the VM is synced by hand, so the key can be in
      // place hours before the script is.
      if (code === 127) {
        reject(new DoorMissing('the door is not installed on the server yet'));
        return;
      }
      if (/permission denied \(publickey\)/i.test(err)) {
        reject(new KeyRefused('the server did not accept this key'));
        return;
      }
      reject(
        new DiscordToolError(
          line
            ? `the server answered something I could not read: ${line.slice(0, 120)}`
            : `the server said nothing (exit ${code})${err ? `: ${err.trim().slice(0, 120)}` : ''}`,
        ),
      );
    });

    child.stdin.end(doorBrief(question));
  });
}

/**
 * `mode` is the character these tools are serving, whichever one it is.
 *
 * They used to look it up by name, which meant this file knew there was a
 * character called "zomboid" and what role gated it. Both of those are facts
 * about one group of friends; the tools only need to know which role to check
 * and where to write, and the active character carries both.
 */
export function zomboidTools(turn, deps = {}, mode = null) {
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
        'It can take up to two minutes. Say one short line first — "dame un segundo que me fijo" — before calling it. ' +
        'If it answers within about twenty seconds you get the real answer directly, same as always. If it comes back ' +
        'sooner than that saying the server is still working on it, that IS the whole answer for this turn: say one ' +
        'short line telling the room you will say it when it arrives, then stop. Do not call this tool again for the ' +
        'same question — the answer will be spoken on its own once the door replies.\n\n' +
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
        const destination = config.get('zomboidSsh');
        if (!destination) {
          throw new DiscordToolError(
            'There is no way in to the server configured, so I cannot ask it anything.',
          );
        }
        // The second tier of the gate. Entering the character is already gated;
        // this is the line between looking and changing, checked against the
        // person who spoke this turn rather than whoever turned the mode on.
        // A character with no role named is one nobody has restricted, and that is
        // a decision its author made rather than one to second-guess here.
        if (act && mode?.actRole) {
          requireRole(guild, askerId, mode.actRole, 'change anything on the server');
        }

        const keys = deps.keys ?? KEYS;
        const keyPath = act ? keys.act : keys.read;
        if (!deps.ask && !fs.existsSync(keyPath)) {
          throw new DiscordToolError(
            act
              ? 'I only have the key that lets me look, not the one that lets me change anything.'
              : 'The key to the server is not on this machine.',
          );
        }

        const send = deps.ask ?? askOverSsh;
        const quickAnswerMs = deps.quickAnswerMs ?? QUICK_ANSWER_MS;
        // Settled once, either way, so both the quick branch below and the
        // late one that may follow it can read the same outcome without
        // asking the door twice.
        const outcome = send({ destination, keyPath, question, act }).then(
          (answer) => ({ ok: true, answer }),
          (err) => ({ ok: false, err }),
        );

        // The handle is kept and cleared the moment the race is decided
        // either way — otherwise a question the door answers quickly still
        // leaves a stray quickAnswerMs timer running for nothing.
        let raceTimer;
        const quick = await Promise.race([
          outcome,
          new Promise((resolve) => {
            raceTimer = setTimeout(() => resolve(null), quickAnswerMs);
          }),
        ]);
        clearTimeout(raceTimer);

        if (quick === null) {
          // Not back in time. The turn ends now — see QUICK_ANSWER_MS for
          // why — and the ssh call keeps running on its own; the far side
          // holds the connection open for up to ASK_TIMEOUT_MS regardless of
          // whether anything here is still listening for it.
          outcome
            .then(async (result) => {
              if (result.ok) {
                const { spoken, detail } = await deliverAnswer(guild, mode, turn, result.answer, act);
                console.log(
                  `[zomboid] late answer (${act ? 'act' : 'read'}): "${String(question).slice(0, 80)}" → ${result.answer?.ok ? 'ok' : 'not ok'}`,
                );
                lateAnswers.emit('late', {
                  guildId: turn.guildId,
                  spoken: spoken || 'La respuesta llegó, pero no hay nada para decir.',
                  detail,
                  question,
                });
                return;
              }
              lateAnswers.emit('late', {
                guildId: turn.guildId,
                spoken: askFailureSpoken(await classifyAskFailure(result.err), { act }),
                detail: '',
                question,
              });
            })
            .catch((err) => {
              // Delivering the late answer failed on this side — writing to
              // the channel, most likely. A late answer that throws into
              // nowhere is worse than one that is merely logged.
              console.warn(`[zomboid] could not deliver the late answer: ${err.message}`);
            });

          return (
            'The server is still working on this — it can take up to two minutes. Say one short line ' +
            'telling the room you will say the answer as soon as it arrives, then stop there. Do not call ' +
            'this tool again for the same question: the answer will be spoken on its own when the door replies.'
          );
        }

        if (!quick.ok) {
          const instruction = askFailureInstruction(await classifyAskFailure(quick.err), { act });
          // 'other': nothing named here applies, so the original error goes
          // up exactly as it did before this tool learned to wait — through
          // `discordTool`'s own handling of a non-DiscordToolError.
          if (!instruction) throw quick.err;
          throw new DiscordToolError(instruction);
        }

        const { spoken, wrote } = await deliverAnswer(guild, mode, turn, quick.answer, act);
        console.log(`[zomboid] asked (${act ? 'act' : 'read'}): "${String(question).slice(0, 80)}" → ${quick.answer?.ok ? 'ok' : 'not ok'}`);

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
