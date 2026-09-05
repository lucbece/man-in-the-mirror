import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { connectMcpServers, exposedName } from '../src/agent/mcp-client.js';

/**
 * The tool surface, against real MCP servers held in this process.
 *
 * Nothing here spawns anything or opens a socket: an `sdk` server entry is
 * connected over a linked pair of in-memory transports, which is exactly what
 * the bot's own tool server is in production. So this exercises the real
 * client, the real protocol and the real handshake — what it does not
 * exercise is a subprocess or a URL, which is the SDK's business, not ours.
 */

/** An MCP server with the given tools, in the `{type:'sdk'}` shape. */
function sdkServer(name, tools) {
  const instance = new McpServer({ name, version: '1.0.0' });
  for (const [toolName, run] of Object.entries(tools)) {
    instance.registerTool(
      toolName,
      { description: `does ${toolName}`, inputSchema: { what: z.string().optional() } },
      async ({ what }) => ({ content: [{ type: 'text', text: run(what) }] }),
    );
  }
  return { type: 'sdk', name, instance };
}

describe('listing what the servers offer', () => {
  test('every tool of every server, named server__tool', async (t) => {
    const mcp = await connectMcpServers({
      servers: {
        bot: sdkServer('bot', { set_reminder: () => 'set', who_is_in_voice: () => 'nobody' }),
        files: sdkServer('files', { read_text_file: () => 'contents' }),
      },
    });
    t.after(() => mcp.close());

    assert.deepEqual(
      mcp.listTools().map((tool) => tool.toolName).sort(),
      ['bot__set_reminder', 'bot__who_is_in_voice', 'files__read_text_file'],
    );
    assert.deepEqual(mcp.serverNames.sort(), ['bot', 'files']);

    const one = mcp.listTools().find((tool) => tool.toolName === 'files__read_text_file');
    assert.equal(one.server, 'files');
    assert.equal(one.name, 'read_text_file');
    assert.equal(one.description, 'does read_text_file');
    assert.equal(one.inputSchema.type, 'object');
  });

  test('an allow-list keeps only the tools it names', async (t) => {
    // The whole point of the allow-list: a server that mixes reading with
    // writing must be connectable without granting the writing half.
    const mcp = await connectMcpServers({
      servers: {
        files: sdkServer('files', { read_text_file: () => 'contents', write_file: () => 'written' }),
      },
      allow: { files: ['read_text_file'] },
    });
    t.after(() => mcp.close());

    assert.deepEqual(mcp.listTools().map((tool) => tool.toolName), ['files__read_text_file']);
    assert.equal(mcp.resolve('files__write_file'), null);
  });

  test('resolve maps the exposed name back to the real pair', async (t) => {
    const mcp = await connectMcpServers({ servers: { bot: sdkServer('bot', { quiet: () => 'shh' }) } });
    t.after(() => mcp.close());

    assert.deepEqual(mcp.resolve('bot__quiet'), { server: 'bot', name: 'quiet' });
    assert.equal(mcp.resolve('bot__nothing'), null);
  });
});

describe('names a model can actually be given', () => {
  test('a plain pair is left alone', () => {
    assert.equal(exposedName('files', 'read_text_file'), 'files__read_text_file');
  });

  test('anything outside OpenAI\'s alphabet is replaced, not passed on', () => {
    assert.equal(exposedName('files', 'read.text file'), 'files__read_text_file');
    assert.match(exposedName('files', 'ñandú'), /^[a-zA-Z0-9_-]{1,64}$/);
  });

  test('an over-long name is cut to 64 characters', () => {
    const name = exposedName('server', 'x'.repeat(200));
    assert.equal(name.length, 64);
    assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(name.startsWith('server__'), 'which server it is has to survive the cut');
  });
});

describe('calling one', () => {
  test('returns the text the tool produced', async (t) => {
    const mcp = await connectMcpServers({
      servers: { bot: sdkServer('bot', { echo: (what) => `you said ${what}` }) },
    });
    t.after(() => mcp.close());

    assert.equal(await mcp.callTool('bot', 'echo', { what: 'hola' }), 'you said hola');
  });

  test('a server that is not there is an error the caller can turn into a sentence', async (t) => {
    const mcp = await connectMcpServers({ servers: {} });
    t.after(() => mcp.close());

    await assert.rejects(() => mcp.callTool('gone', 'anything', {}), /no MCP server called "gone"/);
  });
});

describe('a server that will not connect', () => {
  test('is skipped with a warning, and the others still work', async (t) => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (line) => warnings.push(line);
    t.after(() => { console.warn = warn; });

    const mcp = await connectMcpServers({
      servers: {
        broken: { type: 'sdk', name: 'broken', instance: { connect: () => Promise.reject(new Error('nope')) } },
        bot: sdkServer('bot', { fine: () => 'fine' }),
      },
    });
    t.after(() => mcp.close());

    // One bad entry in the panel must not take the agent down with it.
    assert.deepEqual(mcp.serverNames, ['bot']);
    assert.deepEqual(mcp.listTools().map((tool) => tool.toolName), ['bot__fine']);
    assert.ok(warnings.some((line) => /could not connect "broken"/.test(line)));
  });
});

describe('closing', () => {
  test('leaves nothing connected', async () => {
    const mcp = await connectMcpServers({ servers: { bot: sdkServer('bot', { fine: () => 'fine' }) } });
    await mcp.close();

    assert.deepEqual(mcp.serverNames, []);
    await assert.rejects(() => mcp.callTool('bot', 'fine', {}));
  });
});
