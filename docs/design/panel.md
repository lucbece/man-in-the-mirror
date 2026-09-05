# The control panel

The design behind `src/web/public/`, and the contract every section is built
against. The plan and its packages are in
[plans/panel.md](../plans/panel.md); this file is what the packages
implement.

## Two layers

**Now** is the first screen: what the bot is doing, and the actions of the
moment. **Settings** is eight sections, each one question, reached from a
sidebar. Nothing is configured on Now and nothing is operated from Settings,
with one deliberate exception: the Listen switch on Now, because deafening is
both an action and a setting and people reach for it as an action.

The sidebar is 15 rem, sticky, with the brand, Now, a "Settings" group of
eight items, and a foot with the version and the language toggle. Under
900 px it becomes a sticky bar of icons under which the page scrolls, and the
language toggle moves into the top bar.

## The vocabulary

Every visible thing on the panel is one of these, styled once in
`panel/components.css` from the tokens in `panel/tokens.css`. A section that
needs something not listed here asks for the component to be added here
first.

| Component | Class | Used for |
| --- | --- | --- |
| Frame | `.shell`, `.nav`, `.main`, `.topbar`, `.section`, `.card`, `.subcard` | The page, the sidebar, one section, a group of related settings, a card inside a card |
| Advanced | `details.advanced` with a `summary` | The settings nobody needs on day one, as a disclosure row at the end of a card; its contents are ordinary rows |
| Field | `.field` with `.label`, the control, `.help`, optional `.more` | One setting: a label, a control, at most one sentence under it, and a disclosure for anything longer |
| Free value | `.input`, `.input.mono`, `.select`, `.textarea`, `.input-row` | Text, an id, a choice from a list, JSON; an input with a button glued on |
| Segmented | `.seg` | Two or three choices. The sentence under it describes the selected one |
| Switch | `.switch` | On or off, label on the left, optional one-line help under the label |
| Chips | `.chips`, `.chip`, `.chip.person` | A short list of words; a person token |
| List | `.list` with `.item`, `.text`, `.remove`, `.add`, `.empty` | Lines that are added, edited in place and removed |
| Callout | `.callout`, `.callout.warn`, `.callout.danger` | A note or a warning, at most one per section |
| Pill | `.pill[data-state=ok/busy/warn/error]`, `.pill.accent` | A state |
| Stat | `.stats`, `.stat` with `.value` and `.label`; `.strip` | A number that matters; the hears/thinks/speaks strip |
| Actions | `.btn`, `.btn.primary`, `.btn.quiet`, `.btn.danger`, `.btn.small`, `.savebar`, `.toast` | Buttons, the one save bar per section, feedback |
| First run | `.steps`, `.step`, `.step.done` | The checklist on Now until the keys exist |
| Recent | `.exchanges`, `.exchange` with `.q`, `.a`, `.t` | The last exchanges of a call |

Rules that follow from the vocabulary:

- **No inline styles and no new CSS in a section.** The mock pages under
  `mock/` are the reference renderings; `scripts/panel-shots.sh` screenshots
  them and the real sections alike.
- **Help is one sentence**, under the control, in `.help`. A second sentence
  goes into `.more` with a summary of two or three words ("Why it matters",
  "Where to get it"). A warning is a `.callout`, once per section.
- **A control that does not apply is not rendered.** The sentence under the
  choice that hid it says so when it helps ("Local model is not used with
  the API").
- **The accent is for the primary action, the selected segment and focus.**
  State uses ok, warn and danger. Nothing else is coloured.
- **Sentence case everywhere.** No uppercase tracked labels.

## Type and space

Three text sizes with a job each: 20 px semibold for the section title,
14 px medium in the full text colour for labels and body, 13 px in the dim
colour for help and meta. 28 px semibold for a stat value. Cards have 24 px
padding and 24 px between fields; the measure for prose is 60 characters.

The content column is 80 rem at most and centred in the space beside the
sidebar, so a wide screen shows margins on both sides rather than a column
pinned left. From 900 px up a setting is a row: label and help in a 16 rem
column on the left, the control on the right, a rule between rows; on a
phone the same markup stacks. Now is two columns from 1100 px up: the call,
the join picker and the setup strip on the left, the recent exchanges and
the numbers on the right.

## Strings

Every visible string is a key in `panel/strings/en.js` and `panel/strings/es.js`
and is rendered through `t(key, vars)`. Markup carries `data-t="key"` for
static text; scripts call `t()` for dynamic text. A test asserts the two
files have the same keys. The toggle in the sidebar foot (and the top bar
under 900 px) stores the choice in `localStorage` under `mitm.lang`; the
default is the browser's language when it is Spanish, English otherwise.

## Now

| Block | Content | Source |
| --- | --- | --- |
| Top bar | "Now"; pill `Online · <tag>` / `Starting` / `Stopped` / `Error · <message>`; Start or Stop bot | `bot` |
| First run | Steps 1 to 3 for the token, the OpenAI key and the Anthropic key, each with an input and a Save, marked done when set; step 4, server ID, optional. Rendered only while a key is missing | `config.hasToken`, `hasOpenaiApiKey`, `hasAnthropicApiKey`, `guildId` |
| Join | Server and channel selects and a Join button, rendered only when there is no session | `guilds` |
| The call | One card per session: `#channel · server`; pills Listening or Deafened, Speaking, Music mode; meta line with people, things heard, names, answers and cost; buttons Deafen/Listen, Music mode/Talk again, Shush (only while speaking), Leave; the ask row | `sessions[]` |
| Music | Subcard inside the call, only when something is playing or queued: title, Pause/Resume, Skip, Stop; meta with queued count, volume, who asked | `sessions[].music` |
| Recent | Card with the last exchanges: who and what was asked, the answer, tools used, first words and total time, clock time. Rendered only when there is at least one | `sessions[].recent` |
| Strip | Hears · Thinks · Speaks, each naming provider and model, each a link to its section | `config` |
| Stats | Answers measured, first words without and with tools, handed to the agent (cascade only), heard to asked | `answers` |

## Settings, section by section

Each table is the contract for that section: the control, the configuration
key it reads and writes, the label, the one line of help, and when it is
rendered. Keys are those of `config.publicView()`; `/api/config` accepts the
same names.

### Discord

| Control | Key | Label | Help | Shown |
| --- | --- | --- | --- | --- |
| Status row + input + Replace | `token` (`hasToken`, `tokenPreview`) | Bot token | Developer Portal → Bot → Reset Token | always |
| `.input.mono` | `guildId` | Server ID | Right-click the server in Discord and copy its ID. More: with it slash commands appear at once | always |
| Read-only `.input-row` with Copy | `bot.inviteUrl` | Invite link | Opens Discord with the scopes and permissions it needs | when the bot is online |
| `.callout` | — | — | It needs Connect and Speak; Move Members and Mute Members to manage the call. No privileged intents | always |

### Keys

| Control | Key | Label | Help | Shown |
| --- | --- | --- | --- | --- |
| Status row + input + Replace | `token` | Discord bot token | Developer Portal → Bot → Reset Token | always |
| Status row + input + Replace | `openaiApiKey` | OpenAI API key | Hearing and speaking. platform.openai.com | always |
| Status row + input + Replace | `anthropicApiKey` | Anthropic API key | Thinking. Scoped to a workspace. Console | always |
| `.callout` | — | — | Saved to `data/config.json`, owner-only. A blank field keeps what is stored | always |

A status row is a pill (`Set · sk-…7f2a` or `Missing`) beside the label;
the input and its Replace button are the control.

### Hearing

| Control | Key | Label | Help | Shown |
| --- | --- | --- | --- | --- |
| `.seg` | `sttProvider` (`openai`, `local`) | Transcription | API: Works anywhere. About 2 to 4 cents per question. Local: Free and private; fast with a GPU, slow without | always |
| `.select` | `sttLocalModel` from `sttModels` | Local model | Downloaded on first use into `runtime/`. More: GPU and size notes | `sttProvider = local` |

### Listening

| Control | Key | Label | Help | Shown |
| --- | --- | --- | --- | --- |
| `.chips` | `agentNames` (comma-joined) | Names it answers to | Matched anywhere in a sentence. Use a word from the language you speak. More: the "Amy" and "mirar" notes | always |
| `.switch` | `wakeEnabled` | Answer when called by name | Off, it keeps listening but answers only /mj ask and the Ask box on Now | always |
| `.select` | `bufferSeconds` (30, 60, 90, 120, 300, 600) | How much conversation it keeps | Held in memory only. 90 s covers the thread of a conversation | always |
| `.switch` | `eagerTranscription` | Transcribe as people speak | Needed to notice its name. Pays for everything said in the channel | always, inside `details.advanced` |

### Thinking

| Control | Key | Label | Help | Shown |
| --- | --- | --- | --- | --- |
| `.seg` | `brainKind` (`agent`, `cascade`, `chat`) | Mode | Agent: Remembers the call and can use tools. Fast model in front: A fast model answers what needs no tool and hands the rest to the agent. Chat: One call per answer, fastest, no tools or memory | always |
| `.select` + Custom | `brainModel` from `models` with role `agent` (`chat` in chat mode) | Agent model / Model | Blank uses the default. The note from `models` | always |
| `.select` + Custom, grouped by provider | `fastModel` from `models` with role `fast`, Anthropic and OpenAI | Fast model | Answers first. No tools, no memory of its own | `brainKind = cascade` |
| `.seg` | `brainProvider` (`anthropic`, `openai`) | Provider | Claude: Needs the Anthropic key. OpenAI: Reuses the transcription key | `brainKind = chat` |
| `.switch` | `webSearch` | Look things up on the web | Adds a few seconds to the answers that use it | always |

"Custom" in a model select reveals an `.input.mono` for the id; a value not
in the list renders as Custom with the input filled.

### Instructions

| Control | Key | Label | Help | Shown |
| --- | --- | --- | --- | --- |
| `.list` | `customInstructions` (newline-joined) | — | `n of 20`. Names in a chip follow the person across display-name changes. The built-in rules stay above these | always |

Person tokens `<@id|Name>` render as `.chip.person` inside the item text and
survive editing; the add input takes plain text. An item over 300
characters shows `.help.error` and is not saved.

### Tools

| Control | Key | Label | Help | Shown |
| --- | --- | --- | --- | --- |
| `.list` of servers, from the JSON | `mcpServers` | MCP servers | One row per server: name, then command or URL; a remove button; an empty row when none | always |
| Add from file (`input type=file`) and Edit as JSON (a `.more` holding the `.textarea`) | `mcpServers` | — | A whole Claude Desktop config is accepted; its `mcpServers` object is merged in. JSON errors shown in place; More: the example and the `allow` note | always |
| `.textarea` | `agentDirectories` | Folders the agent may reach | Only a filesystem-style server uses this: the agent has no file access of its own. Full paths, one per line | when at least one server is configured |
| `.callout.warn` | — | — | Anyone in the call can use what you connect here | always |
| `.input` number, inside `details.advanced` | `agentMaxTurns` | Steps per answer | How many times it may call a tool before it has to answer. Each step is a model round trip; eight covers most requests | always |

The section header says the agent runs on the Claude Agent SDK and these are
the MCP servers connected to it; in Chat mode it adds that they are idle.

### Speaking

| Control | Key | Label | Help | Shown |
| --- | --- | --- | --- | --- |
| `.seg` | `ttsProvider` (`openai`, `local`) | Voice | OpenAI: More natural; first audio about 0.9 s. Local: About 0.3 s, free, more synthetic; 65 MB on first use | always |
| `.select` + Hear it | `ttsVoice` from `voices` | OpenAI voice | — | `ttsProvider = openai` |
| `.select` + Hear it | `ttsLocalVoice` from `localVoices` | Local voice | — | `ttsProvider = local` |
| `.callout` | — | — | Loudness is per listener: right-click the bot in Discord | always |

"Hear it" fetches `/api/tts/preview?provider=&voice=` and plays it in the
page.

## Saving

A section's form keeps the unsaved-edit guard from the old panel: once
edited, the poll stops overwriting it until Save or Discard. The `.savebar`
appears at the bottom of the section only while there are unsaved edits, with
one sentence about what saving does when it matters ("the agent starts a
fresh session"). Now-page switches and buttons act at once and show a toast.
