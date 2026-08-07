/**
 * Reminders: the one thing that makes the bot speak without being spoken to.
 *
 * The model has no clock and a turn lives two minutes at most, so "I'll tell
 * you in ten minutes" is a promise it cannot keep by itself. It hands the
 * promise to the machine instead: the tool registers it, and reminders.js
 * owns the clock and the persistence.
 */
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';

import { reminders } from '../reminders.js';
import { speakableTool } from './wrappers.js';

export function reminderTools(guildId) {
  return [
      tool(
        'set_reminder',
        'Speak a message aloud in the voice channel after a delay. The message must be the finished sentence to say at that moment, in the language the person spoke, addressed to them by name.',
        {
          delay_minutes: z.number().describe('How long to wait, in minutes. May be fractional.'),
          message: z.string().describe('The exact sentence to speak when the time comes.'),
        },
        // Wrapped, because `reminders.set` refuses an unreasonable ask — too
        // soon, past a day, too many pending — with a sentence written to be
        // spoken. Unwrapped, that sentence escaped into the runtime as an
        // exception and the room heard nothing about it.
        speakableTool(async ({ delay_minutes, message }) => {
          const { id } = reminders.set({
            guildId,
            delayMs: delay_minutes * 60_000,
            message,
          });
          console.log(`[reminders] #${id} in ${delay_minutes}min: "${message}"`);
          return `Reminder ${id} set — it will be spoken in ${delay_minutes} minutes.`;
        }),
      ),
      tool(
        'list_reminders',
        'List the reminders currently pending in this voice channel.',
        {},
        async () => {
          const pending = reminders.list(guildId);
          const text = pending.length
            ? pending
                .map((r) => `${r.id}: in ${Math.round(r.remainingMs / 60_000)}min — "${r.message}"`)
                .join('\n')
            : 'No reminders pending.';
          return { content: [{ type: 'text', text }] };
        },
      ),
      tool(
        'cancel_reminder',
        'Cancel a pending reminder by its id.',
        { id: z.number().describe('The reminder id, as returned by set_reminder or list_reminders.') },
        async ({ id }) => ({
          content: [
            {
              type: 'text',
              text: reminders.cancel(guildId, id)
                ? `Reminder ${id} cancelled.`
                : `No pending reminder with id ${id}.`,
            },
          ],
        }),
      ),
  ];
}
