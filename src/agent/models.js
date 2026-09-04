/**
 * The known model ids, for the panel's model selects.
 *
 * `brainModel` and `fastModel` have always been free text — a box with a
 * placeholder, a typo discovered by the bot going silent. This list is what
 * turns that into a known set with a Custom option beside it, without taking
 * the free-text path away: `config.js` never validates against this list, so
 * a model id typed in that isn't here still works exactly as it does today.
 *
 * `role` says where an id makes sense: `agent` (the persistent session with
 * tools, on either provider since the OpenAI agent), `fast` (the small model
 * cascade mode puts in front of it), `chat` (one API call, no memory, no
 * tools but web search). A note is a few words that fit beside the id in a
 * select; the numbers in them were measured (see docs/design/cascade.md), not
 * invented.
 *
 * `pricePerMillion` is list price in US dollars per million tokens, and it is
 * here for one reason: the Claude agent is billed by the SDK, which reports
 * what a session has spent, and the OpenAI agent is not — it gets token
 * counts and has to do the arithmetic itself so the panel's "spent this
 * session" figure means the same thing on both. List prices change; an id
 * with no entry costs nothing, which reads as $0.00 rather than a wrong
 * number.
 */
export const MODELS = [
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    label: 'Claude Opus 5',
    role: ['agent', 'chat'],
    note: 'slower, deeper',
    pricePerMillion: { input: 5, output: 25 },
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    role: ['agent', 'fast', 'chat'],
    note: '4.9s to first word as the agent',
    pricePerMillion: { input: 2, output: 10 },
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    role: ['fast', 'chat'],
    note: '2.4s to first word',
    pricePerMillion: { input: 1, output: 5 },
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    label: 'GPT-4.1',
    role: ['agent', 'fast', 'chat'],
    note: 'direct answers',
    pricePerMillion: { input: 2, output: 8 },
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    label: 'GPT-4.1 mini',
    role: ['agent', 'fast', 'chat'],
    note: 'smaller and cheaper',
    pricePerMillion: { input: 0.4, output: 1.6 },
  },
];

/**
 * Which provider a model id belongs to, for dispatching the fast leg (or
 * anything else providers differ on): an exact match in `MODELS` first, since
 * that is the ground truth; otherwise a prefix guess for an id typed by hand,
 * same as `brainProvider` already lets people do. `null` means neither —
 * callers decide what an unknown model id is worth.
 */
export function providerFor(modelId) {
  const known = MODELS.find((m) => m.id === modelId);
  if (known) return known.provider;

  const id = String(modelId ?? '');
  if (id.startsWith('claude')) return 'anthropic';
  if (/^(gpt-|o1|o3|o4|chatgpt)/.test(id)) return 'openai';
  return null;
}

/**
 * What one turn cost, in dollars, from the token counts the API reported.
 *
 * Unknown model → zero rather than a guess: a made-up rate presented as a
 * spend figure is worse than an obvious zero, and the id in the panel is free
 * text, so unknown ids are normal rather than exceptional.
 */
export function costOf(modelId, { input = 0, output = 0 } = {}) {
  const price = MODELS.find((m) => m.id === modelId)?.pricePerMillion;
  if (!price) return 0;
  return (input * price.input + output * price.output) / 1_000_000;
}
