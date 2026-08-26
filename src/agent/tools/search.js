import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';

import { config } from '../../config.js';

/**
 * Web search as a fast side-call, rather than the runtime's own search tool.
 *
 * The SDK's WebSearch is a research tool: it reads pages, and it sits behind
 * tool search, so a weather question cost a round trip to *find* the tool plus
 * another twenty seconds to use it. Measured against the server-side
 * `web_search` on the plain Messages API, asked the same thing:
 *
 *     agent WebSearch      ~20s, via a ToolSearch round trip first
 *     Haiku 4.5 + search    3.5s, with better numbers in the answer
 *     Sonnet 5 + search     8.7s, and it found nothing specific
 *
 * Haiku is the right size here precisely because this call does no reasoning —
 * it retrieves facts and hands them back for the agent to think about.
 */
const SEARCH_MODEL = 'claude-haiku-4-5';

export async function searchWeb(query) {
  const apiKey = config.get('anthropicApiKey');
  if (!apiKey) throw new Error('No Anthropic API key.');

  const client = new Anthropic({ apiKey });
  const res = await client.beta.messages.create({
    model: SEARCH_MODEL,
    max_tokens: 1024,
    system:
      'Search the web and report the facts you find, compactly and in plain text. ' +
      'No opinions, no greetings, no preamble — just what you found, with dates and ' +
      'numbers where they matter. Say plainly if you found nothing.\n\n' +
      'Include the exact URL when the answer *is* a link — a playlist, a video, a page ' +
      'someone was asked to find. Copy it character for character from the result; a ' +
      'link you complete from memory is worse than no link, because it looks right and ' +
      'goes nowhere. Otherwise leave URLs out: the caller usually wants the fact, not ' +
      'where it came from.',
    // Haiku rejects the tool without this: it has no programmatic tool calling,
    // so the search has to be marked as one the model itself invokes.
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 1, allowed_callers: ['direct'] },
    ],
    messages: [{ role: 'user', content: query }],
  });

  const text = res.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim();
  return text || 'Nothing useful found.';
}

/**
 * The search tool, or nothing when the user has web search switched off.
 *
 * Marks the turn when it runs. That flag is what lets `play_music` tell a URL
 * copied out of real search results from one the model wrote from memory —
 * see the note there for why the difference matters more than it looks.
 */
export function searchTools(turn) {
  if (!config.get('webSearch')) return [];
  return [
    tool(
      'search_web',
      'Look something up on the web: current events, weather, prices, scores, anything that could have changed recently. Returns the facts found, for you to say in your own words.',
      { query: z.string().describe('What to look up, as a search query.') },
      async ({ query: q }) => {
        const started = Date.now();
        try {
          const text = await searchWeb(q);
          if (turn) turn.searched = true;
          console.log(`[search] "${q}" in ${((Date.now() - started) / 1000).toFixed(1)}s`);
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Search failed: ${err.message}` }] };
        }
      },
    ),
  ];
}
