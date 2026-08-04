import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { parseMcpServers, allowedToolsFor, McpConfigError } from '../src/agent/mcp.js';

describe('parseMcpServers', () => {
  test('empty input means no servers, not an error', () => {
    assert.deepEqual(parseMcpServers(''), {});
    assert.deepEqual(parseMcpServers('   '), {});
    assert.deepEqual(parseMcpServers(null), {});
  });

  test('accepts a local server with command, args and env', () => {
    const out = parseMcpServers(JSON.stringify({
      github: { command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 'x' } },
    }));
    assert.deepEqual(out.github, {
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { TOKEN: 'x' },
    });
  });

  test('accepts a remote server, defaulting type to http', () => {
    const out = parseMcpServers(JSON.stringify({
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    }));
    assert.equal(out.remote.type, 'http');
    assert.equal(out.remote.url, 'https://example.com/mcp');
  });

  test('unwraps a pasted Claude Desktop config file', () => {
    // People copy the whole file, not the inner object. Both must work,
    // because telling them apart is our job, not theirs.
    const out = parseMcpServers(JSON.stringify({
      mcpServers: { fs: { command: 'npx', args: ['server-filesystem'] } },
    }));
    assert.ok(out.fs);
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
