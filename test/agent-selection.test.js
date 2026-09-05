import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { config } from '../src/config.js';
import { AgentBrain, agentSessionStatus, endAgentSession } from '../src/agent/agent-brain.js';

/**
 * Which session `brainModel` gets you.
 *
 * The Claude branch is deliberately exercised only up to the point where it
 * asks for its key: building it for real starts an Agent SDK subprocess
 * holding about a gigabyte, which a test about a `switch` has no business
 * doing. Refusing for the *right* key is the whole assertion — an OpenAI id
 * that complained about a missing Anthropic key would be the bug.
 *
 * The OpenAI branch is built for real, because it costs nothing to: the MCP
 * client connects the bot's own tool server in this process and there are no
 * user servers, so nothing is spawned and nothing is dialled.
 */

/** Mutates config for the duration of `fn`, never touching disk, then reverts. */
function withConfig(seed, fn) {
  const snapshot = { ...config.values };
  const persist = config.persist;
  config.persist = () => {};
  try {
    Object.assign(config.values, {
      brainKind: 'agent',
      mcpServers: '',
      agentDirectories: '',
      customInstructions: '',
      webSearch: false,
      ...seed,
    });
    return fn();
  } finally {
    config.persist = persist;
    config.values = snapshot;
  }
}

describe('the provider comes from the model id', () => {
  test('a Claude id asks for the Anthropic key', async () => {
    await withConfig(
      { brainModel: 'claude-sonnet-5', anthropicApiKey: '', openaiApiKey: 'sk-openai' },
      () => {
        assert.throws(() => new AgentBrain({ guildId: 'g-claude' }), /Anthropic API key/);
      },
    );
  });

  test('an OpenAI id asks for the OpenAI key, not the Anthropic one', async () => {
    await withConfig(
      { brainModel: 'gpt-4.1', anthropicApiKey: 'sk-ant', openaiApiKey: '' },
      () => {
        assert.throws(() => new AgentBrain({ guildId: 'g-openai' }), /OpenAI API key/);
      },
    );
  });

  test('a blank model is still the Claude default', async () => {
    await withConfig({ brainModel: '', anthropicApiKey: '', openaiApiKey: 'sk-openai' }, () => {
      assert.throws(() => new AgentBrain({ guildId: 'g-default' }), /Anthropic API key/);
    });
  });

  test('an OpenAI id with a key builds the OpenAI session, and says so', async (t) => {
    t.after(() => endAgentSession('g-built'));

    await withConfig(
      { brainModel: 'gpt-4.1-mini', anthropicApiKey: '', openaiApiKey: 'sk-openai' },
      async () => {
        // No Anthropic key at all: this cannot have taken the Claude path.
        const brain = new AgentBrain({ guildId: 'g-built' });

        assert.equal(brain.label, 'OpenAI agent gpt-4.1-mini (MCP: bot)');
        assert.equal(brain.session.constructor.name, 'OpenAiAgentSession');

        const status = agentSessionStatus('g-built');
        assert.equal(status.model, 'gpt-4.1-mini');
        assert.equal(status.answers, 0);
        assert.equal(status.answering, false);
        assert.deepEqual(status.tools, ['bot'], 'the bot server, named from the configuration');
      },
    );
  });
});

describe('what the answers register is labelled with', () => {
  test('names the provider the model belongs to', async (t) => {
    t.after(() => endAgentSession('g-label'));

    await withConfig(
      {
        brainModel: 'gpt-4.1',
        openaiApiKey: 'sk-openai',
        anthropicApiKey: '',
        mcpServers: '{"files": {"command": "true"}}',
      },
      async () => {
        const brain = new AgentBrain({ guildId: 'g-label' });
        assert.equal(brain.label, 'OpenAI agent gpt-4.1 (MCP: bot, files)');
      },
    );
  });
});
