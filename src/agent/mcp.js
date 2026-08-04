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
 */
export function parseMcpServers(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return {};

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
  }
  return servers;
}

/**
 * The allow-list handed to the SDK: every tool of every configured server.
 *
 * The agent runs with permission prompts off — there is nobody at a terminal
 * to answer them — so this list is the entire fence. Everything not on it,
 * including the SDK's built-in file and shell tools, is denied outright: the
 * bot's machine is not the agent's workspace.
 */
export function allowedToolsFor(servers, { webSearch } = {}) {
  const tools = Object.keys(servers).map((name) => `mcp__${name}__*`);
  if (webSearch) tools.push('WebSearch');
  return tools;
}
