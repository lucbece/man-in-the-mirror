/**
 * Asking a game server, over UDP, whether it is there.
 *
 * This is the cheap probe a mode needs before it reaches for anything
 * expensive (see docs/plans/personalities.md). It costs one datagram, needs no
 * credentials from anybody, and answers the question the room actually asks —
 * "¿está arriba el server?" — with what the game itself reports rather than
 * with what our configuration believes: the name, the map, how many are
 * playing and which version they are on.
 *
 * It is deliberately not a way to *do* anything. Starting and stopping the
 * machine belongs to the bot that owns that switch; this only looks.
 *
 * The protocol is Valve's A2S_INFO, which Project Zomboid answers on its game
 * port:
 *
 *     ->  ff ff ff ff  'T'  "Source Engine Query\0"
 *     <-  ff ff ff ff  'A'  <4 bytes of challenge>      (almost always)
 *     ->  ff ff ff ff  'T'  "Source Engine Query\0" <the same 4 bytes>
 *     <-  ff ff ff ff  'I'  <payload>
 *
 * The challenge round trip is not optional in practice: modern servers answer
 * the bare request with one, and a client that does not resend gets nothing.
 * Ported from the Python in the zomboid repo, which is verified against a real
 * Build 42 response — the same bytes are in test/fixtures/a2s_info.bin, so
 * both implementations are checked against the same evidence.
 */
import dgram from 'node:dgram';

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const REQUEST = Buffer.concat([HEADER, Buffer.from('TSource Engine Query\0', 'latin1')]);

const INFO = 0x49; // 'I'
const CHALLENGE = 0x41; // 'A'

/**
 * How long to wait, and how many times — tuned for a room, not for a poller.
 *
 * The zomboid bot that watches a boot uses three seconds and three attempts,
 * which is right when nobody is waiting: it is following a machine that takes
 * three minutes to come up. Here somebody has just asked a question out loud,
 * and the answer is usually "it is off" — measured against the real address
 * with the machine stopped, those settings took **nine seconds** to say so.
 *
 * A datagram to the game and back is tens of milliseconds; a second is already
 * generous, and two attempts still cover one lost packet. Worst case two
 * seconds, which the "dame un segundo" line covers. The cost of being wrong is
 * small in the one direction it can be wrong: saying "no está respondiendo"
 * about a server that was merely slow sends someone to `/pz start`, which
 * answers "ya está prendida, hay tres jugando".
 */
export const A2S_TIMEOUT_MS = 1000;
export const A2S_ATTEMPTS = 2;

export class A2sError extends Error {}

/** Nothing came back: the machine is off, the game is still loading, or UDP ate it. */
export class NoAnswer extends A2sError {}

/** Walks the payload, which is a sequence of NUL-terminated strings and bytes. */
class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.at = 0;
  }

  byte() {
    if (this.at >= this.buffer.length) throw new A2sError('the response ended early');
    return this.buffer[this.at++];
  }

  short() {
    if (this.at + 2 > this.buffer.length) throw new A2sError('the response ended early');
    const value = this.buffer.readUInt16LE(this.at);
    this.at += 2;
    return value;
  }

  /**
   * UTF-8, replacing what does not decode rather than throwing: a server name
   * is typed by a person and can contain anything at all, and a probe that
   * fails on somebody's emoji tells the room nothing about the server.
   */
  string() {
    const end = this.buffer.indexOf(0, this.at);
    if (end === -1) throw new A2sError('a string in the response was never terminated');
    const value = this.buffer.toString('utf8', this.at, end);
    this.at = end + 1;
    return value;
  }

  skip(n) {
    this.at += n;
  }

  get left() {
    return this.at < this.buffer.length;
  }
}

/** The four challenge bytes, if this is a challenge rather than an answer. */
export function challengeIn(data) {
  if (data.length >= 9 && data.subarray(0, 4).equals(HEADER) && data[4] === CHALLENGE) {
    return data.subarray(5, 9);
  }
  return null;
}

/**
 * Parse a complete A2S_INFO response.
 *
 * The trailing "extra data field" is a bitmask whose fields appear in a fixed
 * order, which is the part everyone gets wrong: the order is the protocol's,
 * not the order of the bits you happen to test.
 */
export function parseInfo(data) {
  if (!data.subarray(0, 4).equals(HEADER)) {
    throw new A2sError('the response is not a simple packet');
  }
  const read = new Reader(data.subarray(4));
  const kind = read.byte();
  if (kind !== INFO) {
    throw new A2sError(`unexpected response type 0x${kind.toString(16)} (wanted 'I')`);
  }

  read.byte(); // protocol version
  const name = read.string();
  const map = read.string();
  read.string(); // game folder
  const game = read.string();
  read.short(); // app id, truncated to 16 bits
  const players = read.byte();
  const maxPlayers = read.byte();
  read.byte(); // bots
  read.byte(); // server type: 'd' dedicated
  read.byte(); // environment: 'l' linux
  const locked = read.byte() === 1; // needs a password
  read.byte(); // VAC
  const version = read.string();

  let port = null;
  let tags = '';
  if (read.left) {
    const edf = read.byte();
    if (edf & 0x80) port = read.short();
    if (edf & 0x10) read.skip(8); // the server's SteamID
    if (edf & 0x40) {
      read.short();
      read.string(); // SourceTV
    }
    if (edf & 0x20) tags = read.string();
    // 0x01 (GameID, 8 bytes) is last and nothing here needs it.
  }

  return {
    name,
    map,
    game,
    players,
    maxPlayers,
    version: gameVersion(version, tags),
    port,
    tags,
    locked,
  };
}

/**
 * The version people mean.
 *
 * Project Zomboid fills the protocol's own version field with "1.0.0.0" and
 * always has; the build everybody talks about — 42.20 — is a keyword in the
 * tags. Reporting the protocol field would be technically a version and
 * practically a lie.
 */
export function gameVersion(version, tags) {
  for (const part of String(tags ?? '').split(';')) {
    if (part.startsWith('VERSION:')) return part.slice('VERSION:'.length);
  }
  return version;
}

/**
 * One request/response over UDP, with its own socket.
 *
 * A socket per exchange rather than one kept open: this runs a few times an
 * hour at most, and a socket that outlives the call it was made for is a
 * handle to leak and an error to catch in a place with no caller to tell.
 */
function exchange(payload, { host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new NoAnswer(`no answer from ${host}:${port}`)), timeoutMs);

    socket.on('message', (message) => finish(null, message));
    socket.on('error', (err) => finish(new A2sError(err.message)));
    socket.send(payload, port, host, (err) => {
      // A send that fails outright — no route, name not resolved — is not a
      // silent server; it is a broken query, and it should not wait out the
      // whole timeout before saying so.
      if (err) finish(new A2sError(err.message));
    });
  });
}

/**
 * What the game says about itself, or `NoAnswer` if it says nothing.
 *
 * `send` is injectable so the parsing and the retry logic can be exercised
 * without a socket; everything else here is the retry loop.
 */
export async function query({
  host,
  port = 16261,
  timeoutMs = A2S_TIMEOUT_MS,
  attempts = A2S_ATTEMPTS,
  send = (payload) => exchange(payload, { host, port, timeoutMs }),
} = {}) {
  if (!host) throw new A2sError('no host to ask');

  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      let response = await send(REQUEST);
      const challenge = challengeIn(response);
      if (challenge) {
        response = await send(Buffer.concat([REQUEST, challenge]));
        // A second challenge in a row means the datagram was lost rather than
        // the challenge being wrong: retry the whole exchange rather than
        // reading a challenge as if it were an answer.
        if (challengeIn(response)) throw new NoAnswer('the server kept asking for a challenge');
      }
      return parseInfo(response);
    } catch (err) {
      last = err;
      // A malformed answer is an answer: the server is up and something is
      // wrong with our reading of it, and trying again will not fix that.
      if (!(err instanceof NoAnswer)) throw err;
    }
  }
  throw last ?? new NoAnswer('no answer');
}
