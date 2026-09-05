/**
 * The bot's notebook, from inside the call.
 *
 * Three tools, the same shape as the instruction tools: remember a fact,
 * list them, forget one by number. A fact is linked to the people it names
 * at the moment it is written down, when they are demonstrably in the room.
 */
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';

import { config } from '../../config.js';
import { displayNameLookup } from '../discord-tools.js';
import { linkPeople, renderInstructions } from '../instructions.js';
import { NotebookError, addNote, removeNote, serialiseNotes } from '../notebook.js';
import { peopleToLink } from './config.js';

export function notebookTools(turn) {
  return [
    tool(
      'remember_fact',
      'Write down something worth knowing next time — what somebody likes or hates, a running joke, a plan, who plays what, how something went. Facts about the group and its people, in the speaker\'s language, one short line. Use it when you learn such a thing, and when somebody says "acordate que…" about themselves or the group. Not for how to behave: that is remember_instruction. Not for one-off requests. Do not announce that you noted it unless they asked you to remember.',
      {
        fact: z.string().describe('The fact, one short line, in the speaker\'s language.'),
        people: z
          .array(
            z.object({
              name: z.string().describe('The name exactly as it is written in the fact.'),
              userId: z.string().describe('That person\'s Discord user id, digits only.'),
            }),
          )
          .optional()
          .describe('Who the fact is about, only when the name alone would be ambiguous. Ids come from who_is_in_voice.'),
      },
      async ({ fact, people }) => {
        try {
          const guild = turn.guild();
          const linked = linkPeople(fact, peopleToLink(guild, people));
          const resolve = displayNameLookup(guild);
          const list = addNote(config.get('notebook'), linked, resolve);
          config.update({ notebook: serialiseNotes(list) });
          console.log(`[notebook] noted #${list.length}: "${linked}"`);
          return { content: [{ type: 'text', text: `Noted as ${list.length}. It will be there next call.` }] };
        } catch (err) {
          const text = err instanceof NotebookError ? err.message : `Could not note that: ${err.message}`;
          return { content: [{ type: 'text', text }] };
        }
      },
    ),
    tool(
      'list_facts',
      'What is in the notebook, with numbers.',
      {},
      async () => {
        const list = renderInstructions(config.get('notebook'), displayNameLookup(turn.guild()));
        return {
          content: [
            {
              type: 'text',
              text: list.length ? list.map((line, i) => `${i + 1}. ${line}`).join('\n') : 'The notebook is empty.',
            },
          ],
        };
      },
    ),
    tool(
      'forget_fact',
      'Remove a note from the notebook by its number, as given by list_facts.',
      { number: z.number().describe('Which one to forget, counting from 1.') },
      async ({ number }) => {
        try {
          const { list, removed } = removeNote(config.get('notebook'), number, displayNameLookup(turn.guild()));
          config.update({ notebook: serialiseNotes(list) });
          console.log(`[notebook] forgot: "${removed}"`);
          return { content: [{ type: 'text', text: `Forgotten: ${removed}` }] };
        } catch (err) {
          const text = err instanceof NotebookError ? err.message : `Could not forget that: ${err.message}`;
          return { content: [{ type: 'text', text }] };
        }
      },
    ),
  ];
}
