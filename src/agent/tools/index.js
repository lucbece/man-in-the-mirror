/**
 * The bot's own tools, served to the agent in-process.
 *
 * Split by what a tool acts on rather than by how it is implemented, because
 * that is the axis along which the rules differ: `call` tools check the
 * permissions of whoever asked, `config` tools decide what the bot itself
 * becomes, `reminders` hands a promise to the machine's clock, and `search`
 * is a side-call to a smaller model.
 *
 * They lived in agent-brain.js until that file was a thousand lines doing four
 * unrelated jobs, and the tools were both most of it and the part that changed
 * every week. What is left there is the session; this is what the session can
 * do.
 */
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

import { callTools } from './call.js';
import { configTools } from './config.js';
import { reminderTools } from './reminders.js';
import { searchTools } from './search.js';

/**
 * `turn` is how a tool learns who is asking: the same object every turn, with
 * `askerId` and `askerName` rewritten before each answer. The definitions are
 * built once per session; the identity behind them is not.
 */
export function botToolsServer(guildId, turn) {
  return createSdkMcpServer({
    name: 'bot',
    version: '1.0.0',
    // In the prompt from the start rather than discovered on demand. Tool
    // search costs a whole model round trip before the first real tool call,
    // which in a voice call is seconds of silence for nothing.
    alwaysLoad: true,
    tools: [
      ...searchTools(),
      ...callTools(turn),
      ...configTools(turn),
      ...reminderTools(guildId),
    ],
  });
}

export { takePendingLeave } from './call.js';
