# mimo-agent-tools

DSH (DeepSeek Harness) Cordis plugin that turns the **Xiaomi MiMo API** into
model tools for an agent: web search, image/audio/video understanding,
speech-to-text, and text-to-speech.

Backed by the OpenAI-compatible endpoint `https://api.xiaomimimo.com/v1`.

**MiMo-V2.6 edition.** The plugin targets the current V2.6 generation
(`mimo-v2.6-pro` / `mimo-v2.6-flash` / `mimo-v2.6-pro-ultraspeed`, released
2026-09-22) and the current DSH 0.2.x plugin contract. `mimo-v2.5` and
`mimo-v2.5-pro` are deprecated on **2026-10-21** with no automatic replacement
([official notice](https://mimo.mi.com/static/docs/updates/deprecate.md)) and
are no longer referenced by any tool.

## Models

In V2.6 **every tier is full-modal** (text, image, video and audio input), so
the old v2.5 split — `mimo-v2.5-pro` for text/thinking/search, `mimo-v2.5` for
media — collapses into one model id per tier. Each chat-side tool takes an
optional `model` parameter accepting a tier alias or a full model id:

| Alias | Model id | Use it for |
|---|---|---|
| `pro` (default for search/think/json) | `mimo-v2.6-pro` | flagship reasoning, best answers |
| `flash` (default for vision/audio/video) | `mimo-v2.6-flash` | cheap full-modal understanding |
| `ultraspeed` | `mimo-v2.6-pro-ultraspeed` | ~20x output speed, 10x price |

Speech stays on the **v2.5 voice models** — Xiaomi ships no v2.6 ASR/TTS
models: `mimo-v2.5-asr`, `mimo-v2.5-tts`, `mimo-v2.5-tts-voicedesign`,
`mimo-v2.5-tts-voiceclone`.

## Tools

| Tool | Model | Purpose |
|---|---|---|
| `mimo_search` | v2.6 pro (configurable) | Web search via the native `web_search` tool, returns answer + cited sources (incl. site_name/logo_url); optional `force_search`, `user_location` |
| `mimo_think` | v2.6 pro (configurable) | Deep thinking — full reasoning chain (`reasoning_content`) + final answer |
| `mimo_json` | v2.6 pro (configurable) | Structured JSON output via `response_format: json_object` |
| `mimo_vision` | v2.6 flash (configurable) | Image understanding — local files (auto base64) or public URLs, multi-image |
| `mimo_audio` | v2.6 flash (configurable) | Audio understanding / transcription (wav/mp3/flac/ogg/m4a) — local file or public URL |
| `mimo_video` | v2.6 flash (configurable) | Video understanding (mp4/webm/mov) — local file or public URL; optional `fps` (0.1–10.0) / `media_resolution` (`default`\|`max`) |
| `mimo_asr` | mimo-v2.5-asr | Speech-to-text with optional language hint (`auto`/`zh`/`en`) — local file or public URL |
| `mimo_tts` | mimo-v2.5-tts / -voicedesign | Text-to-speech to a `.wav`/`.mp3` file — preset voices or free-form voice design; optional `style` (speaking tone) and `format` (wav/mp3) |
| `mimo_voiceclone` | mimo-v2.5-tts-voiceclone | Voice cloning — reference clip + text → speech in that voice; optional `format` (wav/mp3) |

## audio-tools skill

The plugin registers an `audio-tools` skill that guides when to use the four
audio tools (`mimo_asr`, `mimo_tts`, `mimo_voiceclone`, `mimo_audio`). The
tools themselves are always registered — they are lightweight pure-API calls —
so the skill only teaches usage, it does not gate the tools.

## Requirements

- A [MiMo API key](https://mimo.mi.com) (`sk-…`) — the `web_search` tool
  requires the connected-search plugin enabled in the MiMo console.
- `python3` on the host (used by `driver/mimo_driver.py`). On Windows it must
  resolve to a real Python 3 install — the Microsoft Store `python3` stub
  fails.
- DSH 0.2.x with the `tools`, `shell`, `sandboxPolicy`, `credentials` and
  `skills` services (the `web` profile has them all).

## Configuration

The API key is resolved at tool-call time from the **DSH credentials
service** (key name `XIAOMI_API_KEY` — the web Models page writes keys
there). The plugin runs in a sandbox without `process.env`, so nothing is
read from the environment and **nothing is hardcoded**:

| Source | Key | Priority |
|---|---|---|
| DSH credentials service (`~/.dsh/.credentials.yaml`, web Models page) | `XIAOMI_API_KEY` | 1 (only) |

| Env var | Purpose | Default |
|---|---|---|
| `MIMO_DRIVER` | path to `driver/mimo_driver.py` | `~/.local/lib/mimo-agent-tools/driver/mimo_driver.py` |

Install the driver at the default path (or point `MIMO_DRIVER` at it):

```bash
mkdir -p ~/.local/lib/mimo-agent-tools/driver
cp driver/mimo_driver.py ~/.local/lib/mimo-agent-tools/driver/
```

## Why a python driver?

Multimodal payloads are multi-megabyte base64 strings. Agent shells commonly
cap captured stdout (DSH's default capture budget is 64KB, raised here only
for the small JSON reads), which silently truncates large payloads. The
driver therefore does ALL file reading, body assembly and HTTP POSTing inside
one python3 process, using spec/response files on disk — nothing large ever
crosses the shell.

## Install (DSH bundle)

Standard DSH bundle — install with the official plugin command (auto-inits
the profile, pnpm-installs, and appends the bundle layer per
`dsh.bundle.patch`):

```bash
# From a local checkout, or via git:
dsh plugin --profile web add /path/to/dsh-mimo-agent-tools
# or: dsh plugin --profile web add github:ch1bug/dsh-mimo-agent-tools

# Install the python driver to the default path (MIMO_DRIVER points at it):
mkdir -p ~/.local/lib/mimo-agent-tools/driver
cp driver/mimo_driver.py ~/.local/lib/mimo-agent-tools/driver/

# Restart dsh web; the tools mount automatically.
```

`dsh plugin --profile <name> …` forwards its arguments to pnpm in the
profile, so `add`/`remove`/`why`/`up` are pnpm's; `dsh plugin` then records
every installed package that declares `dsh.bundle` as a profile layer. From
inside a session the `plugin_manager` tool's `install_bundle` action performs
the same installation.

Dependencies are declared as `peerDependencies` (ecosystem convention —
`@deepseek-ai/dsh-tools` is already loaded in the DSH process, so nothing is
duplicated, and DSH's peer resolution maps the declared name to the running
runtime's copy). The `*` range satisfies DSH's plugin compatibility gate on
any runtime version.

## Notes on the MiMo API (from the official docs)

- **Thinking is ON by default** for every V2.6 model. This plugin sends
  `thinking: {type: "disabled"}` for plain calls and `{type: "enabled"}` only
  for `mimo_think`; `max_completion_tokens` covers reasoning tokens too, so
  the driver gives deep thinking a 16384 budget (API range `[1, 131072]`).
- In thinking mode with multi-turn tool calls, `reasoning_content` from
  earlier assistant turns must be echoed back or the API returns 400. These
  tools are single-shot, but anything you build on the raw API must obey it.
- TTS target text goes in the **assistant** message; the voice description
  (voicedesign model) goes in the **user** message; a `style` instruction rides
  the user message for preset voices and becomes an inline `(风格)` tag prefix
  for voicedesign voices.
- `mimo-v2.5-tts-voicedesign` does **not** accept an `audio.voice` field — it
  uses `optimize_text_preview` instead (and answers with
  `message.final_text_preview`, surfaced by `mimo_tts`). `audio.format`
  accepts `wav`, `mp3`, `pcm`, `pcm16`; this plugin writes wav/mp3 files.
- ASR (`mimo-v2.5-asr`) must **not** receive a `thinking` field;
  `asr_options.language` is `auto` | `zh` | `en`.
- `input_audio.data` / `video_url.url` accept either a public URL or a
  `data:<mime>;base64,...` data URL (video base64 capped at 50MB per the docs).
- Video parts take `fps` (float, 0.1–10.0, default 2) and `media_resolution`
  (`default` | `max`) as siblings of `video_url`.
- Web search costs per keyword round — `max_keyword` (default 3 here, API
  range [1, 50]) and `limit` (default 5) both bill per call. `force_search`
  (default true here; the API default is false = the model decides) trades
  freshness against cost; `user_location` biases results, e.g.
  `{"type":"approximate","country":"China","region":"Hubei","city":"Wuhan"}`.
  A failed search round is reported as `search_error`
  (`message.error_message`) next to the citations.
- Structured output (`mimo_json`) is JSON **mode** only — MiMo accepts
  `response_format: json_object` and no `json_schema`, so the exact shape
  (fields, types, nesting) must be described in the prompt; keep
  `max_completion_tokens` generous so the JSON is not truncated mid-document.

## Tests

```bash
python3 tests/test_driver.py   # driver request-body assembly (15 cases)
node --test tests/tools.test.mjs  # tool registration surface (14 cases)
```

The Node suite runs the real `defineTool` from `@deepseek-ai/dsh-tools`, so it
also proves the parameter specs compile under the current DSH schema DSL. Get
it onto the resolution path with a link to a DSH checkout (or a plain
`npm install --no-save @deepseek-ai/dsh-tools`):

```bash
mkdir -p node_modules/@deepseek-ai
ln -s /path/to/deepseek-harness/packages/core/tools node_modules/@deepseek-ai/dsh-tools
```

## DSH 0.2.x compatibility notes

This branch targets DSH `0.2.0-rc.2`'s plugin contract:

- `execute` returns the canonical value declared by `output.schema` and
  **throws** on failure — the old `{ok:true}/{ok:false,error}` envelope is
  gone (a thrown error becomes the model-facing `isError` result).
- Shell commands run through `shell.execute(shell.resolve(req)).result()`
  (there is no `shell.run`); `stdoutMaxBytes` raises the capture budget for
  the reads that must be complete.
- `skills.register` requires a `source` field (`runtime` here).
- Parameter specs may use `enum`/`const`/`oneOf`/`items`/`additionalProperties`
  but only `required: true` (omit `required` for optional).

## License

MIT
