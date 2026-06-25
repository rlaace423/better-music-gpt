# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — runs `node index.mjs` (listens on `process.env.PORT`, falling back to `config.port = 3000`, bound to `0.0.0.0`).
- `npm run smoke` — boots the server on `SMOKE_PORT` (default 5599) and asserts shapes from the public routes. Set `SKIP_LLM_TESTS=1` to skip the Gemini-hitting tests (find-persona, generate-prompt) and only verify routes are alive.
- `npm run format` — Prettier over `**/*.{mjs,html}`. `public/*.js` (jQuery) and `venv/` are ignored.
- `node examples/run-graph.mjs` — interactive CLI that runs the full **LangGraph** pipeline (personaMatch → promptAugment → confirmGate(HITL) → musicGptCall → pollStatus). Pass `--dry` (or `GRAPH_DRY_RUN=1`) to mock the MusicGPT calls.
- `python test/evaluation.py` — standalone CLAP similarity evaluator. Requires a Python venv with `torch`, `librosa`, `transformers`; expects `test/ori.mp3` and `test/aug.mp3`.

Required env vars (loaded via `dotenv` in `config.mjs`):
- `GEMINI_API_KEY` (required at server boot — `ChatGoogleGenerativeAI` throws in its constructor if missing; this is a behavioral difference from the old `@google/genai` SDK which lazy-initialized)
- `MUSIC_GPT_API_KEY`
- `PORT` (optional)

## Architecture

Express server that chains **Gemini (prompt augmentation) → MusicGPT (song generation)**, with a static jQuery frontend in `public/`. The LLM and external-API plumbing is built on **LangChain.js (LCEL)**, and the end-to-end pipeline is additionally expressed as a **LangGraph** `StateGraph`. Everything is ES modules (`.mjs`) even though `package.json` declares `"type": "commonjs"` — don't "fix" that; the extensions make it work.

### Two surfaces for the same pipeline

There are intentionally **two ways** to drive the pipeline:

1. **Express routes** (`index.mjs`, the original product surface). Each route invokes a single LCEL chain directly. Fast, stateless, no HITL.
2. **LangGraph graph** (`graph.mjs`, demo'd via `examples/run-graph.mjs`). The full multi-step flow with HITL `interrupt()` and a self-looping poll node. Not wired into Express yet — see `docs/MIGRATION.md` for the TODO.

If you change a chain in `gemini.mjs`, both surfaces are affected because the graph reuses the same LCEL chains as nodes.

### End-to-end request flow (Express surface)

1. Client loads `public/index.html` → hits `GET /api/personas` to populate the persona selector.
2. (Optional) User opens the "페르소나 찾기" modal → `POST /api/find-persona`. Calls `findPersonaChain` = `ChatPromptTemplate | model.withStructuredOutput(zodSchema)`. The Korean recommendation message wraps the chosen name in `*asterisks*` — the frontend replaces those with `<span class="highlight-persona">` via regex (`public/index.html` ~line 1053), so don't change the asterisk convention without updating both sides.
3. User types a prompt → `POST /api/generate-prompt`. Calls `augmentPromptChain` = `ChatPromptTemplate | model | JsonOutputParser | RunnableLambda(enforce 200-char cap)`. Returns `{ answer, prompt, genre }`. The system instruction tells Gemini the `prompt` must be 180–200 chars; MusicGPT quality depends on staying in that window, and the `RunnableLambda` truncates anything over 200 as a safety net.
4. Client calls `POST /api/generate-song` with `{ prompt, music_style }` → wraps `generateSongRunnable` (a `RunnableLambda` over the MusicGPT POST), returning `{ task_id, eta }`.
5. Client polls `GET /api/get-song-status?task_id=…` every 5s → wraps `getSongStatusRunnable`. Completion requires **all** of: `status` ∈ {`COMPLETED`, `GENERATION_COMPLETED`}, `title_1`, `conversion_path_1`, `album_cover_path`, `lyrics_timestamped_1` (JSON-encoded array of `{text, start}` ms timestamps used for karaoke highlight).

### LangGraph surface

`graph.mjs` defines a `StateGraph` with these nodes:

- **`personaMatch`** — **Multi-Agent**. Calls `personaPickerChain` (Zod `{ personaIndex }`) then `recommendMessageChain` (Zod `{ recommendationMessage }`) in sequence. This intentionally splits the single LLM call that the Express route uses into two specialized agents.
- **`promptAugment`** — reuses `augmentPromptChain` from `gemini.mjs`.
- **`confirmGate`** — **HITL**. Calls `interrupt({ augmentedPrompt, persona })`. The graph pauses; `MemorySaver` checkpoints the state. Resume with `graph.invoke(new Command({ resume: bool }), threadConfig)`.
- **`musicGptCall`** — invokes `generateSongRunnable`. Honors `userConfirmed === false` as an early fail.
- **`pollStatus`** — sleeps 5s, then invokes `getSongStatusRunnable`. `addConditionalEdges` with `pollDoneRouter` makes it self-loop until `status === 'done'`/`'failed'` or `pollAttempts ≥ 60` (5 minute ceiling).

State is `Annotation.Root({...})` with reducers (notably `pollAttempts` is reducer-based so node returns are merged correctly).

### Module layout

- `index.mjs` — only route definitions + middleware. Calls into `gemini.mjs` exports.
- `gemini.mjs` — **LangChain.js LCEL chains and Multi-Agent splits**:
  - `findPersonaChain` / `findPersona()` — single-call structured output (used by Express).
  - `augmentPromptChain` / `generateAugmentedPrompt()` — `ChatPromptTemplate | model | JsonOutputParser | RunnableLambda`.
  - `personaPickerChain`, `recommendMessageChain` — the two split agents used by the LangGraph `personaMatch` node.
  - Single shared `ChatGoogleGenerativeAI({ model: 'gemini-2.5-flash' })` instance.
- `graph.mjs` — `StateGraph`, `Annotation.Root` state, all 5 nodes, `pollDoneRouter`, `buildPipelineGraph()`. Uses `MemorySaver` because `interrupt()` requires a checkpointer.
- `examples/run-graph.mjs` — CLI demo. Reads description + userMessage from stdin, runs `graph.invoke(...)`, handles the `interrupt()` resume via `Command({ resume: ... })`, prints final state.
- `music-gpt.mjs` — axios calls to `https://api.musicgpt.com/api/public/v1`, plus `generateSongRunnable` / `getSongStatusRunnable` (RunnableLambda wrappers). `getSongStatus` swallows errors with `console.error` and returns `undefined` on failure; `generateSong` lets errors propagate to the Express error handler.
- `personas.mjs` — static array of 5 personas. Each has `persona` (lifestyle/personality) and `arts_persona` (art/music taste) strings. Client fetches via `/api/personas` so edits propagate without a frontend rebuild.
- `error-handler.mjs` — final Express middleware. All thrown errors become `{status: 'error', message}` with HTTP status from `err.status ?? 500`.
- `test/smoke.mjs` — spawns the server and exercises every public route's shape.
- `public/index.html` — single file containing 3 full-screen "scenes" (input → loading → player) managed by fade transitions and a single `AppState` object. Persona avatars are Gravatar identicons keyed by lowercased/trimmed name + md5 (see `getGravatarUrl`). Progress percent during generation is computed client-side from `eta` and `startTime`, not from the MusicGPT API.
- `docs/MIGRATION.md` — narrative on the LangChain/LangGraph migration: before/after mapping, graph diagram, the "why" behind each abstraction. Read this before making non-trivial changes to chains or graph nodes.

### Conventions to respect

- UI copy, persona recommendations, and user-facing error messages are **Korean**. Music-generation prompts passed to MusicGPT are **English**. Don't mix these up — the Gemini system instruction in `augmentPromptChain` explicitly separates `answer` (Korean, conversational) from `prompt` (English, for music AI).
- `ChatPromptTemplate` uses single-brace `{var}` for placeholders and **doubled `{{` / `}}` for literal braces**. The augment prompt embeds a JSON example via `{{ ... }}`; keep that escaping if you edit it.
- When passing the persona list into the prompt, stringify with `JSON.stringify(personas, null, 2)`. Template-variable substitution does not re-parse the value, so embedded `{` characters in the JSON are safe.
- Prettier: `printWidth: 120`, `singleQuote: true`, `trailingComma: "all"`.
