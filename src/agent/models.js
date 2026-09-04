/**
 * The known model ids, for the panel's model selects.
 *
 * `brainModel` and `fastModel` have always been free text — a box with a
 * placeholder, a typo discovered by the bot going silent. This list is what
 * turns that into a known set with a Custom option beside it, without taking
 * the free-text path away: `config.js` never validates against this list, so
 * a model id typed in that isn't here still works exactly as it does today.
 *
 * `role` says where an id makes sense: `agent` (the persistent Claude session
 * with tools), `fast` (the small model cascade mode puts in front of it),
 * `chat` (one API call, no memory, no tools but web search). A note is a few
 * words that fit beside the id in a select; the numbers in them were measured
 * (see docs/design/cascade.md), not invented.
 */
export const MODELS = [
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    label: 'Claude Opus 5',
    role: ['agent', 'chat'],
    note: 'slower, deeper',
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    role: ['agent', 'fast', 'chat'],
    note: '4.9s to first word as the agent',
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    role: ['fast', 'chat'],
    note: '2.4s to first word',
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    label: 'GPT-4.1',
    role: ['chat'],
    note: 'direct answers',
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    label: 'GPT-4.1 mini',
    role: ['chat'],
    note: 'smaller and cheaper',
  },
];
