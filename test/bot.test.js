import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';

import { BotRunner } from '../src/bot/index.js';

/**
 * `status()` against a plain object standing in for the discord.js client —
 * a real one needs a gateway connection, and all that's being checked here is
 * what gets read off it once it exists.
 */
describe('bot status', () => {
  test('no application id, and no invite, before anything has logged in', () => {
    const runner = new BotRunner();
    const status = runner.status();

    assert.equal(status.applicationId, null);
    assert.equal(status.inviteUrl, null);
  });

  test('the invite is built from the application id, once there is one', () => {
    const runner = new BotRunner();
    runner.client = { application: { id: '123456789012345678' } };

    const status = runner.status();

    assert.equal(status.applicationId, '123456789012345678');
    assert.ok(status.inviteUrl.startsWith('https://discord.com/oauth2/authorize?'));
    assert.match(status.inviteUrl, /client_id=123456789012345678/);
    assert.match(status.inviteUrl, /scope=bot%20applications\.commands/);
  });

  test('the permissions are the sum of what the voice tools actually use, not a hardcoded number', () => {
    const runner = new BotRunner();
    runner.client = { application: { id: '1' } };

    const expected = new PermissionsBitField([
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
      PermissionFlagsBits.MoveMembers,
      PermissionFlagsBits.MuteMembers,
    ]).bitfield.toString();

    assert.match(runner.status().inviteUrl, new RegExp(`permissions=${expected}(&|$)`));
  });
});
