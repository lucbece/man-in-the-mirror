import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  parseMcpServers,
  allowedToolsFor,
  parseDirectories,
  McpConfigError,
} from '../src/agent/mcp.js';

describe('parseMcpServers', () => {
  test('empty input means no servers, not an error', () => {
    assert.deepEqual(parseMcpServers(''), { servers: {}, allow: {} });
    assert.deepEqual(parseMcpServers('   '), { servers: {}, allow: {} });
    assert.deepEqual(parseMcpServers(null), { servers: {}, allow: {} });
  });

  test('accepts a local server with command, args and env', () => {
    const { servers } = parseMcpServers(JSON.stringify({
      github: { command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 'x' } },
    }));
    assert.deepEqual(servers.github, {
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { TOKEN: 'x' },
    });
  });

  test('accepts a remote server, defaulting type to http', () => {
    const { servers } = parseMcpServers(JSON.stringify({
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    }));
    assert.equal(servers.remote.type, 'http');
    assert.equal(servers.remote.url, 'https://example.com/mcp');
  });

  test('unwraps a pasted Claude Desktop config file', () => {
    // People copy the whole file, not the inner object. Both must work,
    // because telling them apart is our job, not theirs.
    const { servers } = parseMcpServers(JSON.stringify({
      mcpServers: { fs: { command: 'npx', args: ['server-filesystem'] } },
    }));
    assert.ok(servers.fs);
  });

  test('names errors by field instead of failing vaguely', () => {
    const bad = [
      ['{not json', /Not valid JSON/],
      ['[]', /object/],
      ['{"a b": {"command": "x"}}', /Server name/],
      ['{"a": {}}', /needs either/],
      ['{"a": {"command": "x", "args": "no"}}', /args/],
      ['{"a": {"url": "ftp://x"}}', /http or https/],
      ['{"a": {"url": "not a url"}}', /not a valid URL/],
      ['{"a": {"url": "https://x.com", "type": "ws"}}', /type/],
      // "bot" carries the bot's own tools (reminders); letting a user server
      // shadow it would silently replace them.
      ['{"bot": {"command": "x"}}', /reserved/],
      ['{"a": {"command": "x", "allow": []}}', /allow/],
      ['{"a": {"command": "x", "allow": "read_file"}}', /allow/],
      ['{"a": {"command": "x", "allow": ["read file"]}}', /allow/],
    ];
    for (const [input, pattern] of bad) {
      assert.throws(() => parseMcpServers(input), McpConfigError, input);
      assert.throws(() => parseMcpServers(input), pattern, input);
    }
  });
});

describe('allowedToolsFor', () => {
  test('grants exactly the configured servers, wildcarded per server', () => {
    const tools = allowedToolsFor({ github: {}, jira: {} }, { webSearch: false });
    assert.deepEqual(tools.sort(), ['mcp__github__*', 'mcp__jira__*']);
  });

  test('web search rides on the same switch as the chat brain', () => {
    assert.ok(allowedToolsFor({}, { webSearch: true }).includes('WebSearch'));
    assert.ok(!allowedToolsFor({}, { webSearch: false }).includes('WebSearch'));
  });
});

describe('per-tool allow lists', () => {
  test('grants only the named tools when a server asks for it', () => {
    // The case this exists for: the stock filesystem server ships write_file,
    // edit_file, create_directory and move_file alongside the readers. A
    // voice agent driven by imperfect transcription should be able to answer
    // "what's in that folder" without being able to rewrite it.
    const { servers, allow } = parseMcpServers(JSON.stringify({
      files: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        allow: ['list_directory', 'read_text_file'],
      },
    }));
    assert.deepEqual(allow.files, ['list_directory', 'read_text_file']);
    assert.deepEqual(allowedToolsFor(servers, { allow }), [
      'mcp__files__list_directory',
      'mcp__files__read_text_file',
    ]);
  });

  test('allow never reaches the SDK, which has no such field', () => {
    const { servers } = parseMcpServers('{"a": {"command": "x", "allow": ["t"]}}');
    assert.equal('allow' in servers.a, false);
  });

  test('a server that says nothing still gets everything', () => {
    // Silence must mean "connect this server", not "connect nothing" — the
    // opposite reading would break every config written before allow existed.
    const { servers, allow } = parseMcpServers('{"a": {"command": "x"}}');
    assert.deepEqual(allowedToolsFor(servers, { allow }), ['mcp__a__*']);
  });
});

describe('parseDirectories', () => {
  test('one full path per line, blanks ignored', () => {
    assert.deepEqual(parseDirectories('/a/b\n\n  /c/d  \n'), ['/a/b', '/c/d']);
    assert.deepEqual(parseDirectories(''), []);
    assert.deepEqual(parseDirectories(null), []);
  });

  test('relative paths are rejected, since there is nothing to be relative to', () => {
    // The agent has no workspace the user can see, so "./notes" would resolve
    // somewhere they never chose.
    assert.throws(() => parseDirectories('notes'), /full path/);
    assert.throws(() => parseDirectories('./notes'), /full path/);
    assert.throws(() => parseDirectories('~/notes'), /full path/);
  });

  test('accepts Windows paths', () => {
    assert.deepEqual(parseDirectories('C:\\Users\\me\\notes'), ['C:\\Users\\me\\notes']);
  });

  test('checks existence when asked, naming the folder that is wrong', () => {
    const exists = (d) => d === '/real';
    assert.deepEqual(parseDirectories('/real', { exists }), ['/real']);
    assert.throws(() => parseDirectories('/real\n/typo', { exists }), /"\/typo" does not exist/);
  });
});
