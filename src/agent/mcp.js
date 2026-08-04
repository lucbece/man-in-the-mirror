/**
 * The MCP servers the user pastes into the panel.
 *
 * The input format is deliberately the one people already have lying around:
 * the `mcpServers` object from a Claude Desktop or Claude Code config. Paste
 * the same JSON here and the agent gets the same tools. Accepting a novel
 * format would mean every user translating their config by hand, and getting
 * it wrong.
 *
 * Validation is strict because this JSON describes *processes to spawn* and
 * *URLs to send conversation content to*. A typo shouldn't produce a server
 * that half-works; it should produce an error message naming the field.
 */

export class McpConfigError extends Error {}

/**
 * Pull out our own `allow` field, which is not part of the MCP config shape.
 *
 * Without it the only choice is all-or-nothing per server, and plenty of
 * useful servers mix reading with writing — the standard filesystem server
 * has four tools that modify things among fourteen. Granting `write_file` to
 * something driven by imperfect speech recognition in a room full of people
 * is not a risk anyone needs to take to ask what's in a folder.
 */
function takeAllowList(name, entry) {
  if (entry.allow === undefined) return null;
  if (
    !Array.isArray(entry.allow) ||
    entry.allow.length === 0 ||
    entry.allow.some((t) => typeof t !== 'string' || !/^[\w-]+$/.test(t))
  ) {
    throw new McpConfigError(
      `"${name}".allow must be a non-empty array of tool names, e.g. ["list_directory", "read_text_file"].`,
    );
  }
  return [...entry.allow];
}

/** A server entry is either something to run, or somewhere to connect. */
function validateServer(name, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new McpConfigError(`"${name}" must be an object.`);
  }

  if (typeof entry.command === 'string' && entry.command.trim()) {
    const out = { command: entry.command.trim() };
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== 'string')) {
        throw new McpConfigError(`"${name}".args must be an array of strings.`);
      }
      out.args = entry.args;
    }
    if (entry.env !== undefined) {
      if (
        !entry.env ||
        typeof entry.env !== 'object' ||
        Array.isArray(entry.env) ||
        Object.values(entry.env).some((v) => typeof v !== 'string')
      ) {
        throw new McpConfigError(`"${name}".env must be an object of strings.`);
      }
      out.env = entry.env;
    }
    return out;
  }

  if (typeof entry.url === 'string' && entry.url.trim()) {
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch {
      throw new McpConfigError(`"${name}".url is not a valid URL.`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new McpConfigError(`"${name}".url must be http or https.`);
    }
    const type = entry.type ?? 'http';
    if (!['http', 'sse'].includes(type)) {
      throw new McpConfigError(`"${name}".type must be "http" or "sse".`);
    }
    const out = { type, url: entry.url.trim() };
    if (entry.headers !== undefined) {
      if (
        !entry.headers ||
        typeof entry.headers !== 'object' ||
        Array.isArray(entry.headers) ||
        Object.values(entry.headers).some((v) => typeof v !== 'string')
      ) {
        throw new McpConfigError(`"${name}".headers must be an object of strings.`);
      }
      out.headers = entry.headers;
    }
    return out;
  }

  throw new McpConfigError(
    `"${name}" needs either a "command" (local server) or a "url" (remote server).`,
  );
}

/**
 * Parse the panel's JSON into the SDK's mcpServers shape.
 *
 * Accepts both the bare object and a pasted config that still has the
 * `{"mcpServers": {...}}` wrapper around it — people copy whole files.
 * Empty input is valid and means "no tools beyond web search".
 *
 * Returns `{ servers, allow }`: the SDK-shaped config, and the per-server
 * tool allow-lists kept separate because `allow` is ours, not MCP's, and
 * must not be handed to the SDK.
 */
export function parseMcpServers(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { servers: {}, allow: {} };

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new McpConfigError(`Not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpConfigError('Expected a JSON object of servers.');
  }

  // Unwrap a pasted Claude Desktop / Claude Code config file.
  if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
    parsed = parsed.mcpServers;
  }

  const servers = {};
  const allow = {};
  for (const [name, entry] of Object.entries(parsed)) {
    if (!/^[\w-]+$/.test(name)) {
      throw new McpConfigError(
        `Server name "${name}" — use letters, numbers, - and _ only (it becomes part of tool names).`,
      );
    }
    if (name === 'bot') {
      throw new McpConfigError(
        '"bot" is reserved — it\'s the server carrying the bot\'s own tools (reminders etc).',
      );
    }
    servers[name] = validateServer(name, entry);
    const list = entry && typeof entry === 'object' ? takeAllowList(name, entry) : null;
    if (list) allow[name] = list;
  }
  return { servers, allow };
}

/**
 * The allow-list handed to the SDK: every tool of every configured server.
 *
 * The agent runs with permission prompts off — there is nobody at a terminal
 * to answer them — so this list is the entire fence. Everything not on it,
 * including the SDK's built-in file and shell tools, is denied outright: the
 * bot's machine is not the agent's workspace.
 */
/**
 * Directories the agent may reach, one per line.
 *
 * This exists because of a trap worth stating plainly: the SDK advertises its
 * working directories to MCP servers as *roots*, and a root-aware server —
 * the standard filesystem one included — honours those over its own
 * command-line arguments. So pointing a filesystem server at a folder in the
 * `args` does nothing; whatever the SDK advertises is what it gets.
 *
 * Measured, not assumed: with args pointing at one folder and the SDK's cwd
 * at another, `list_allowed_directories` returned the cwd, every time.
 *
 * So the directories live here instead, where they can be validated and
 * shown, rather than buried in a string the user has no reason to think is
 * being ignored.
 */
export function parseDirectories(text, { exists } = {}) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const dir of lines) {
    if (!dir.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(dir)) {
      throw new McpConfigError(
        `"${dir}" must be a full path — the agent has no working directory to be relative to.`,
      );
    }
    if (exists && !exists(dir)) {
      throw new McpConfigError(`"${dir}" does not exist or is not a folder.`);
    }
  }
  return lines;
}

export function allowedToolsFor(servers, { webSearch, allow = {} } = {}) {
  const tools = Object.keys(servers).flatMap((name) =>
    // Named tools when the config asked for them, the whole server otherwise.
    // Defaulting to the wildcard keeps a config that says nothing working as
    // it reads: "connect this server", not "connect nothing".
    allow[name]?.length
      ? allow[name].map((toolName) => `mcp__${name}__${toolName}`)
      : [`mcp__${name}__*`],
  );
  if (webSearch) tools.push('WebSearch');
  return tools;
}
