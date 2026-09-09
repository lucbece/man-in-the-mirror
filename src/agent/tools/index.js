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
import { modeTools } from './modes.js';
import { musicTools } from './music.js';
import { notebookTools } from './notebook.js';
import { quietTools } from './quiet.js';
import { reminderTools } from './reminders.js';
import { searchTools } from './search.js';
import { zomboidTools } from './zomboid.js';

/**
 * `turn` is how a tool learns who is asking: the same object every turn, with
 * `askerId` and `askerName` rewritten before each answer. The definitions are
 * built once per session; the identity behind them is not.
 */
/**
 * The families, by the name a mode uses to keep one.
 *
 * A mode narrows this list to the job it is for: an agent looking after a game
 * server has no business reaching for the notebook or the settings, and every
 * tool it cannot use is one it cannot pick by mistake and one less thing in
 * the prompt.
 */
const FAMILIES = {
  search: (guildId, turn) => searchTools(turn),
  call: (guildId, turn) => callTools(turn),
  config: (guildId, turn) => configTools(turn),
  notebook: (guildId, turn) => notebookTools(turn),
  music: (guildId, turn) => musicTools(turn),
  quiet: (guildId, turn) => quietTools(turn),
  reminders: (guildId) => reminderTools(guildId),
  zomboid: (guildId, turn, mode) => zomboidTools(turn, {}, mode),
};

/**
 * Always served, whatever mode it is in: the way out.
 *
 * A mode whose tool list left `modes` off would be one nobody could leave by
 * asking, which is the one failure this switch must not have.
 */
const ALWAYS = ['modes'];

/**
 * The tools a mode leaves standing, in the order they are served.
 *
 * Separate from the server it goes into so that what a mode can and cannot
 * reach is something a test can read, rather than something buried in an
 * object only the SDK knows how to open.
 */
export function botTools(guildId, turn, mode = null) {
  const wanted = mode?.tools ? [...mode.tools, ...ALWAYS] : [...Object.keys(FAMILIES), ...ALWAYS];
  const tools = [...modeTools(turn)];
  for (const [name, build] of Object.entries(FAMILIES)) {
    if (wanted.includes(name)) tools.push(...build(guildId, turn, mode));
  }
  return tools;
}

export function botToolsServer(guildId, turn, mode = null) {
  const tools = botTools(guildId, turn, mode);
  return createSdkMcpServer({
    name: 'bot',
    version: '1.0.0',
    // In the prompt from the start rather than discovered on demand. Tool
    // search costs a whole model round trip before the first real tool call,
    // which in a voice call is seconds of silence for nothing.
    alwaysLoad: true,
    tools,
  });
}

export { takePendingLeave } from './call.js';
