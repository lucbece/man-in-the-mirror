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
 * `chat` (one API call, no memory, no tools but web search). The notes carry
 * only numbers actually measured elsewhere in this codebase — see the hints
 * in `src/web/public/index.html` for the first-spoken-word timings — rather
 * than invented ones.
 */
export const MODELS = [
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    label: 'Claude Opus 5',
    role: ['agent', 'chat'],
    note: "Anthropic's most capable model — slower and pricier than Sonnet, worth it when depth matters more than a quick reply.",
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    role: ['agent', 'fast', 'chat'],
    note: 'The agent\'s default: measured at 4.9s to first spoken word in agent mode, and the steadiest choice for every role.',
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    role: ['fast', 'chat'],
    note: 'Fast and cheap: measured at 2.4s to first spoken word, which is why cascade mode puts it in front of the agent.',
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    label: 'GPT-4.1',
    role: ['chat'],
    note: "OpenAI's general-purpose model — a direct-answer choice for a room already using an OpenAI key.",
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    label: 'GPT-4.1 mini',
    role: ['chat'],
    note: 'Smaller and cheaper than 4.1, for direct answers where cost matters more than depth.',
  },
];
