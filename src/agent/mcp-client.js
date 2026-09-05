/**
 * One tool surface, spoken MCP, for a brain that is not the Agent SDK.
 *
 * The Claude agent gets its tools by handing `mcpServers` to the SDK and
 * letting it do the connecting. Nothing else can: an OpenAI model needs a
 * flat list of function definitions and something to call when it picks one.
 * So this connects to the very same servers directly — the bot's own
 * in-process server over a linked pair of in-memory transports, the user's
 * over stdio or HTTP — and presents what they expose as one list.
 *
 * It is deliberately the same *input*: the `servers` map and `allow` lists
 * `parseMcpServers` produces, plus the bot's server under the reserved name
 * `bot`. Whichever provider the agent runs on, the tools are the same tools,
 * filtered by the same allow-lists, or the two modes would quietly disagree
 * about what the bot can do.
 *
 * Two things are ours rather than MCP's:
 *
 * The name a model sees is `server__tool`, double underscore, because OpenAI
 * accepts only `[a-zA-Z0-9_-]{1,64}` in a function name — no `mcp__` prefix
 * to spare characters, and a map back to the real pair for anything that has
 * to be sanitised or truncated to fit.
 *
 * And `MIRROR_AGENT_DIRECTORIES`. The Agent SDK advertises the configured
 * folders to its servers as MCP *roots*; a plain client could do the same,
 * but a root-aware server reads them at connect time and there is no argument
 * to pass them as. Rather than invent one, the directories are handed to
 * stdio servers in the environment, colon-separated, and documented — a
 * server that wants them can read them, and one that does not is unaffected.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** OpenAI's rule for a function name, which is the tightest of the two ends. */
const NAME_OK = /^[a-zA-Z0-9_-]{1,64}$/;

/** Colon-separated, the same shape as PATH, on stdio servers only. */
export const DIRECTORIES_ENV = 'MIRROR_AGENT_DIRECTORIES';

/**
 * `server__tool`, made safe for a function name without losing which tool it
 * is. Anything outside the allowed set becomes `_`, and an over-long name is
 * cut from the middle of the *tool* half — the server half is short and is
 * what makes the name unambiguous.
 */
/** Longest tool result handed to the model. About two thousand words. */
export const MAX_TOOL_OUTPUT_CHARS = 8000;

export function clampToolOutput(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_TOOL_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[…${s.length - MAX_TOOL_OUTPUT_CHARS} more characters cut; ask for a narrower result]`;
}

export function exposedName(server, name) {
  const raw = `${server}__${name}`;
  if (NAME_OK.test(raw)) return raw;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe.length <= 64 ? safe : safe.slice(0, 64);
}

/** The transport for one server entry, or null if the entry says nothing. */
function transportFor(entry, directories) {
  if (entry.type === 'sdk') return null; // handled by the caller: it needs the pair

  if (entry.command) {
    // `env` is merged over this process's, not replacing it: a server that
    // needs PATH or HOME — which is most of them — would otherwise fail to
    // spawn with an error about a missing binary rather than a missing key.
    // cwd is deliberately unset: there is no workspace here.
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    Object.assign(env, entry.env ?? {});
    if (directories.length) env[DIRECTORIES_ENV] = directories.join(':');
    return new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      env,
    });
  }

  if (entry.url) {
    const url = new URL(entry.url);
    const init = entry.headers ? { requestInit: { headers: entry.headers } } : {};
    // `type` is validated by parseMcpServers to be "http" or "sse". The
    // streamable transport is the current protocol; the older SSE one is
    // still what a server declaring `"type": "sse"` speaks.
    return entry.type === 'sse'
      ? new SSEClientTransport(url, init)
      : new StreamableHTTPClientTransport(url, init);
  }

  return null;
}

/**
 * Connect every server and return one tool surface over all of them.
 *
 * A server that will not connect is a warning and nothing more, the same
 * tolerance `warmAgentSession` shows: one broken entry in the panel must not
 * take the whole agent down with it, and the ones that did connect are still
 * worth having.
 */
export async function connectMcpServers({ servers, allow = {}, directories = [], name = 'mirror' } = {}) {
  const clients = new Map(); // server name → Client
  const tools = []; // { server, name, description, inputSchema, toolName }
  const byExposed = new Map(); // toolName → { server, name }

  for (const [server, entry] of Object.entries(servers ?? {})) {
    let client;
    try {
      client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
      if (entry.type === 'sdk') {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await entry.instance.connect(serverSide);
        await client.connect(clientSide);
      } else {
        const transport = transportFor(entry, directories);
        if (!transport) throw new Error('neither a command nor a url');
        await client.connect(transport);
      }
    } catch (err) {
      console.warn(`[mcp] could not connect "${server}": ${err.message} — skipping it`);
      await client?.close().catch(() => {});
      continue;
    }

    let listed;
    try {
      listed = (await client.listTools()).tools ?? [];
    } catch (err) {
      console.warn(`[mcp] "${server}" would not list its tools: ${err.message} — skipping it`);
      await client.close().catch(() => {});
      continue;
    }

    clients.set(server, client);
    // Named tools when the config asked for them, the whole server otherwise
    // — the same reading `allowedToolsFor` gives an absent allow-list, so a
    // config that says nothing connects everything rather than nothing.
    const permitted = allow[server]?.length ? new Set(allow[server]) : null;
    for (const t of listed) {
      if (permitted && !permitted.has(t.name)) continue;
      const toolName = exposedName(server, t.name);
      if (byExposed.has(toolName)) {
        console.warn(`[mcp] two tools both named "${toolName}" — keeping the first`);
        continue;
      }
      byExposed.set(toolName, { server, name: t.name });
      tools.push({
        server,
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        toolName,
      });
    }
  }

  return {
    /** The names of the servers that actually connected. */
    get serverNames() {
      return [...clients.keys()];
    },

    listTools() {
      return tools;
    },

    /** `server__tool` back to the pair it stands for, or null. */
    resolve(toolName) {
      return byExposed.get(toolName) ?? null;
    },

    /**
     * Call a tool and return what it said, as text.
     *
     * MCP results are a list of content parts. Text is the only kind a model
     * reading this out loud can use; anything else is stringified rather than
     * dropped, so an image or a resource at least shows up as something the
     * model can reason about instead of silence.
     */
    async callTool(server, toolName, args) {
      const client = clients.get(server);
      if (!client) throw new Error(`no MCP server called "${server}"`);
      const result = await client.callTool({ name: toolName, arguments: args ?? {} });
      const parts = (result?.content ?? []).map((part) =>
        part?.type === 'text' ? part.text : JSON.stringify(part),
      );
      // Capped: the OpenAI agent keeps every tool result in the conversation
      // through previous_response_id, so a file read in full is paid for on
      // every later turn of the session, and a big one ends the session at
      // the context limit.
      const text = clampToolOutput(parts.join('\n').trim());
      if (result?.isError) return text || 'The tool reported an error.';
      return text;
    },

    async close() {
      for (const client of clients.values()) await client.close().catch(() => {});
      clients.clear();
    },
  };
}
