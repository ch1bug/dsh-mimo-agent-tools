// dsh-mimo-agent-tools — Xiaomi MiMo search + multimodal tools.
// Installed as a DSH bundle (`dsh plugin --profile <name> add .`).
// Registers mimo_search / mimo_think / mimo_json / mimo_vision / mimo_audio /
// mimo_video / mimo_asr / mimo_tts / mimo_voiceclone as model tools.
//
// Models: the MiMo-V2.6 generation (mimo-v2.6-pro / mimo-v2.6-flash /
// mimo-v2.6-pro-ultraspeed) for web search, deep thinking, structured output
// and full-modal media understanding — in V2.6 every tier is omni-modal, so
// the old v2.5 split (mimo-v2.5-pro for text, mimo-v2.5 for media) collapses
// into one model id. Speech stays on the v2.5 voice models (mimo-v2.5-asr,
// mimo-v2.5-tts, -voicedesign, -voiceclone): Xiaomi ships no v2.6 voice
// models. mimo-v2.5 / mimo-v2.5-pro are deprecated (2026-10-21) and are no
// longer referenced anywhere.
//
// The API key is resolved from the DSH credentials service (key
// XIAOMI_API_KEY, written by the web Models page). The python driver path is
// shell-expanded (${MIMO_DRIVER:-$HOME/.local/lib/...}) because the plugin
// sandbox has no process.env. Large base64 payloads are handled entirely
// inside the python driver to dodge the 64KB shell stdout capture; only the
// small JSON reads raise `stdoutMaxBytes`.
//
// DSH 0.2.x seams used here: `shell.execute(shell.resolve(req)).result()`
// (there is no `shell.run`), `sandboxPolicy.resolve({ session })`,
// `credentials.resolve(ref)`, `skills.register(...)`, and `defineTool` from
// `@deepseek-ai/dsh-tools`. Tool failures THROW — the registry turns a thrown
// error into the model-facing isError result.
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-mimo-agent-tools'
export const inject = ['tools', 'shell', 'sandboxPolicy', 'credentials', 'skills']

export function apply(ctx) {
  const BASE_URL = 'https://api.xiaomimimo.com/v1'
  const DRIVER_SPEC = '${MIMO_DRIVER:-$HOME/.local/lib/mimo-agent-tools/driver/mimo_driver.py}'
  const TMP_ROOT = '/tmp'
  const KEY_REF = 'XIAOMI_API_KEY'
  // Trusted-read capture budget for the JSON files this plugin parses in full
  // (API responses carry reasoning_content / citations and can exceed the
  // default 64KB capture). Media payloads still never cross stdout.
  const MAX_READ_BYTES = 8 * 1024 * 1024
  const PRESET_VOICES = new Set(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'])

  // MiMo-V2.6 tiers. Every one of them accepts text, image, audio and video
  // input (full-modal), so a `model` parameter is just a price/quality dial.
  const MODELS = {
    pro: 'mimo-v2.6-pro',
    flash: 'mimo-v2.6-flash',
    ultraspeed: 'mimo-v2.6-pro-ultraspeed',
  }
  /** Resolve a caller's tier alias ("pro"/"flash"/"ultraspeed") or pass a full model id through. */
  function resolveModel(value, fallback) {
    const raw = String(value ?? fallback).trim()
    return MODELS[raw.toLowerCase()] ?? raw
  }
  /** The shared `model` parameter, naming the per-tool default tier. */
  function modelParam(defaultTier) {
    return {
      type: 'string',
      description: `MiMo-V2.6 tier: "pro", "flash" (cheap full-modal), "ultraspeed" (~20x output speed, 10x price), or a full model id (default ${defaultTier}).`,
    }
  }

  // UTF-8-safe base64: Node's b64() rejects non-Latin-1 (Chinese TTS text
  // would throw "Invalid character"). Encode via TextEncoder + bytes first.
  function b64(s) {
    const bytes = new TextEncoder().encode(String(s))
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }

  function shq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'"
  }
  function wslPathOf(path) {
    return /^([A-Za-z]):[\\/]/.test(path) ? '/mnt/' + path[0].toLowerCase() + path.slice(2).replace(/\\/g, '/') : String(path).replace(/\\/g, '/')
  }
  function mimeOf(path) {
    // Strip query/fragment so a URL like https://x/a.mp3?token=1 resolves.
    const p = String(path).split(/[?#]/)[0].toLowerCase()
    const map = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
      '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
      '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4'
    }
    for (const [ext, mime] of Object.entries(map)) if (p.endsWith(ext)) return mime
    return 'application/octet-stream'
  }
  /** Clamp a caller-supplied integer into the API's documented range. */
  function clampInt(value, min, max, fallback) {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }

  // One shell command through the DSH shell seam. The current seam shape is
  // `execute(spec).result()` (there is no `shell.run`); a preparation/spawn
  // failure REJECTS, so fold it back into the same result shape callers branch
  // on instead of leaking a second error path.
  async function run(command, exec, opts = {}) {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const policy = sandboxPolicy === undefined ? undefined : sandboxPolicy.resolve(
      exec !== undefined && exec.agent !== undefined ? { session: exec.agent.session } : {}
    )
    const shell = ctx.get('shell')
    const request = {
      command,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.stdoutMaxBytes !== undefined ? { stdoutMaxBytes: opts.stdoutMaxBytes } : {}),
      ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
      ...(exec !== undefined && exec.signal !== undefined ? { signal: exec.signal } : {})
    }
    try {
      const execution = await shell.execute(shell.resolve(request))
      return await execution.result()
    } catch (error) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: exec !== undefined && exec.signal !== undefined && exec.signal.aborted === true,
        timeoutMs: opts.timeoutMs ?? 0,
        stdout: { text: '', truncated: false },
        stderr: { text: String(error instanceof Error ? error.message : error), truncated: false },
      }
    }
  }

  async function resolveKey() {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(KEY_REF)
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) return resolved.value
      } catch {}
    }
    throw new Error(`${KEY_REF} is not configured — store it in the DSH credentials service (web Models page)`)
  }

  // Drive the python relay: spec/response files on disk, so multi-megabyte
  // base64 never crosses the shell's stdout capture. Returns the parsed API
  // response and THROWS a plain Error on every failure — the tool registry
  // materializes a thrown error as the model-facing isError result.
  async function runDriver(spec, exec, timeoutMs = 120000) {
    const key = await resolveKey()
    const full = { url: BASE_URL + '/chat/completions', key, timeout: timeoutMs / 1000 | 0, ...spec }
    const specFile = `${TMP_ROOT}/mimo_spec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
    const respFile = `${TMP_ROOT}/mimo_resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
    const specJson = JSON.stringify(full)
    const cmd = `printf '%s' ${shq(b64(specJson))} | base64 -d > ${shq(specFile)} && python3 ${DRIVER_SPEC} ${shq(specFile)} ${shq(respFile)}`
    const r = await run(cmd, exec, { timeoutMs: timeoutMs + 20000 })
    const status = r.stdout.text.trim()
    let respText = null
    try {
      respText = (await run(`cat ${shq(respFile)}`, exec, { timeoutMs: 10000, stdoutMaxBytes: MAX_READ_BYTES })).stdout.text
    } catch {}
    await run(`rm -f ${shq(specFile)} ${shq(respFile)}`, exec, { timeoutMs: 5000 }).catch(() => {})
    if (status === 'OK') {
      let data = null
      try { data = JSON.parse((respText || '').trim()) } catch { throw new Error('unparseable API response') }
      // Normalize API-level errors (d.error) once here so every tool's
      // execute is just `const d = await runDriver(...)`.
      if (data?.error !== undefined) {
        throw new Error(typeof data.error === 'string' ? data.error : data.error.message ?? 'API error')
      }
      return data
    }
    const t = (respText || '').trim()
    let message
    if (t.startsWith('HTTP_ERR:')) {
      const rest = t.slice(9)
      try {
        const e = JSON.parse(rest).error
        message = (typeof e.message === 'string' ? e.message : '') + (e.param ? ` (${e.param})` : '')
      } catch { message = rest.slice(0, 400) }
    } else if (t.startsWith('NET_ERR:')) {
      message = t.slice(8)
    } else {
      message = (t || status || 'no response').slice(0, 400)
    }
    throw new Error(message)
  }

  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const renderText = (_a, v) => [{ type: 'text', text: typeof v.answer === 'string' ? v.answer : JSON.stringify(v, null, 2) }]
  const renderThink = (_a, v) => {
    const lines = []
    if (typeof v.reasoning === 'string' && v.reasoning.length > 0) {
      lines.push('<details><summary>Reasoning</summary>\n\n' + v.reasoning + '\n\n</details>')
    }
    lines.push(typeof v.answer === 'string' ? v.answer : JSON.stringify(v, null, 2))
    return [{ type: 'text', text: lines.join('\n\n') }]
  }

  const tools = [
    {
      name: 'mimo_search',
      description: 'Search the web through the Xiaomi MiMo native web_search tool (MiMo-V2.6). Returns a model-written answer plus cited sources (url/title/snippet/publishedAt/site_name/logo_url). Use for current events, news, prices, facts, and any query needing fresh web information.',
      parameters: {
        query: { type: 'string', required: true, description: 'The search query' },
        model: modelParam('pro'),
        max_keyword: { type: 'integer', description: 'Max keywords per search round, 1-50 (default 3, cost control)' },
        limit: { type: 'integer', description: 'Max citations returned, 1-50 (default 5)' },
        force_search: { type: 'boolean', description: 'Force a fresh web search instead of letting the model decide (default true)' },
        user_location: { type: 'object', additionalProperties: true, description: 'Approximate user location to bias results, e.g. {"type":"approximate","country":"China","region":"Hubei","city":"Wuhan"}' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const key = await resolveKey()
        const tool = {
          type: 'web_search',
          max_keyword: clampInt(args.max_keyword, 1, 50, 3),
          force_search: args.force_search !== undefined ? args.force_search : true,
          limit: clampInt(args.limit, 1, 50, 5),
        }
        if (args.user_location !== undefined && args.user_location !== null) tool.user_location = args.user_location
        const body = {
          model: resolveModel(args.model, 'pro'),
          messages: [{ role: 'user', content: `Perform a web search for the query: ${args.query}` }],
          max_completion_tokens: 1024,
          stream: false,
          // Thinking defaults to ENABLED since V2.6 — a search answer must not
          // silently spend its completion budget on reasoning tokens.
          thinking: { type: 'disabled' },
          tools: [tool]
        }
        const json = JSON.stringify(body)
        const cmd = `curl -s --max-time 60 --location '${BASE_URL}/chat/completions' -H 'api-key: ${key}' -H 'Content-Type: application/json' -d ${shq(json)}`
        const r = await run(cmd, exec, { timeoutMs: 70000, stdoutMaxBytes: MAX_READ_BYTES })
        let data = null
        let parseError = null
        const out = r.stdout.text.trim()
        if (out) { try { data = JSON.parse(out) } catch { parseError = out.slice(0, 400) } }
        if (data === null) throw new Error(`${parseError || 'no response'}${r.stderr.text.trim() ? ` — ${r.stderr.text.trim().slice(0, 200)}` : ''}`)
        if (data.error !== undefined) throw new Error(typeof data.error === 'string' ? data.error : data.error.message)
        const msg = data.choices?.[0]?.message
        const content = typeof msg?.content === 'string' && msg.content.length > 0 ? msg.content : null
        const seen = new Set()
        const sources = []
        for (const ann of msg?.annotations ?? []) {
          if (ann?.type !== 'url_citation' || typeof ann.url !== 'string' || ann.url.length === 0) continue
          if (seen.has(ann.url)) continue
          seen.add(ann.url)
          sources.push({
            url: ann.url,
            ...(typeof ann.title === 'string' && ann.title.length > 0 ? { title: ann.title } : {}),
            ...(typeof ann.summary === 'string' && ann.summary.length > 0 ? { snippet: ann.summary } : {}),
            ...(typeof ann.publish_time === 'string' && ann.publish_time.length > 0 ? { publishedAt: ann.publish_time } : {}),
            ...(typeof ann.site_name === 'string' && ann.site_name.length > 0 ? { site_name: ann.site_name } : {}),
            ...(typeof ann.logo_url === 'string' && ann.logo_url.length > 0 ? { logo_url: ann.logo_url } : {})
          })
        }
        return {
          query: args.query,
          answer: content,
          // V2.6 reports a failed web-search round here instead of erroring out.
          ...(typeof msg?.error_message === 'string' && msg.error_message.length > 0 ? { search_error: msg.error_message } : {}),
          sources,
          usage: data.usage ?? null
        }
      }
    },
    {
      name: 'mimo_think',
      description: 'Deep reasoning with the Xiaomi MiMo deep-thinking mode (MiMo-V2.6). The model works through the problem step by step before answering; the response carries both the full reasoning chain (reasoning_content) and the final answer. Use for complex reasoning, code generation, math, multi-step analysis, and any task where a plain answer risks missing a step.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'The question or problem to reason about' },
        model: modelParam('pro')
      },
      output: { schema: { type: 'json' }, render: renderThink },
      async execute(args, exec) {
        const d = await runDriver({ model: resolveModel(args.model, 'pro'), kind: 'think', prompt: args.prompt }, exec)
        const msg = d.choices?.[0]?.message
        return {
          reasoning: typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0 ? msg.reasoning_content : null,
          answer: typeof msg?.content === 'string' && msg.content.length > 0 ? msg.content : null,
          usage: d.usage ?? null
        }
      }
    },
    {
      name: 'mimo_json',
      description: 'Structured JSON output from the Xiaomi MiMo model (MiMo-V2.6) via response_format json_object. Describe the exact JSON structure you need (fields, types, nesting, an example) in the prompt; the model returns only valid JSON. Use when you need machine-parseable structured data, not prose.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'What to compute, plus the exact JSON structure required (fields, types, nesting; an example helps)' },
        model: modelParam('pro')
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const d = await runDriver({ model: resolveModel(args.model, 'pro'), kind: 'json', prompt: args.prompt }, exec)
        const content = d.choices?.[0]?.message?.content ?? null
        let data = null
        if (typeof content === 'string' && content.length > 0) {
          try { data = JSON.parse(content) } catch { data = content }
        }
        return { data, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_vision',
      description: 'Analyze one or more images with the Xiaomi MiMo full-modal model (MiMo-V2.6, default flash). Accepts local file paths (Windows C:\\... or WSL /mnt/...) which are base64-encoded automatically, or public image URLs. Supports JPEG/PNG/GIF/WebP/BMP.',
      parameters: {
        images: { type: 'array', required: true, items: { type: 'string' }, description: 'Local file paths or public URLs of images to analyze' },
        prompt: { type: 'string', required: true, description: 'What to ask about the image(s)' },
        model: modelParam('flash')
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const locals = []
        const urls = []
        for (const img of args.images) {
          if (/^https?:\/\//.test(img) || /^data:/.test(img)) urls.push(img)
          else locals.push({ kind: 'image', mime: mimeOf(img), path: wslPathOf(img) })
        }
        const d = await runDriver({ model: resolveModel(args.model, 'flash'), kind: 'vision', files: locals, urls, prompt: args.prompt }, exec)
        return { answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_audio',
      description: 'Analyze audio content with the Xiaomi MiMo full-modal model (MiMo-V2.6, default flash). Accepts a local file path (Windows or WSL path; auto base64) or a public URL. Supports wav/mp3/flac/ogg/m4a.',
      parameters: {
        audio: { type: 'string', required: true, description: 'Local audio file path or public URL' },
        prompt: { type: 'string', description: 'What to do with the audio (default: transcribe)' },
        model: modelParam('flash')
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const isUrl = /^https?:\/\//.test(args.audio) || /^data:/.test(args.audio)
        const d = await runDriver({
          model: resolveModel(args.model, 'flash'), kind: 'audio',
          files: isUrl ? [] : [{ kind: 'audio', mime: mimeOf(args.audio), path: wslPathOf(args.audio) }],
          urls: isUrl ? [args.audio] : [],
          prompt: args.prompt || 'Please transcribe the audio content.'
        }, exec)
        return { answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_video',
      description: 'Analyze video content with the Xiaomi MiMo full-modal model (MiMo-V2.6, default flash). Accepts a local video file path (Windows or WSL path; auto base64) or a public URL. Supports mp4/webm/mov.',
      parameters: {
        url: { type: 'string', required: true, description: 'Local video file path or public URL (mp4/webm/mov)' },
        prompt: { type: 'string', description: 'What to ask about the video (default: describe)' },
        fps: { type: 'number', description: 'Frames sampled per second for analysis, 0.1-10.0 (API default 2). Lower = cheaper/faster, higher = more detail.' },
        media_resolution: { type: 'string', enum: ['default', 'max'], description: 'Resolution level sent to the model: "default" or "max" (API default "default").' },
        model: modelParam('flash')
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const isUrl = /^https?:\/\//.test(args.url) || /^data:/.test(args.url)
        const d = await runDriver({
          model: resolveModel(args.model, 'flash'), kind: 'video',
          files: isUrl ? [] : [{ kind: 'video', mime: mimeOf(args.url), path: wslPathOf(args.url) }],
          urls: isUrl ? [args.url] : [],
          prompt: args.prompt || 'Please describe the video content.',
          fps: args.fps,
          media_resolution: args.media_resolution
        }, exec)
        return { answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_asr',
      description: 'Speech-to-text with the Xiaomi MiMo ASR model (mimo-v2.5-asr — Xiaomi ships no v2.6 voice models). Accepts a local audio file path (Windows or WSL path; auto base64) or public URL. Supports wav/mp3.',
      parameters: {
        audio: { type: 'string', required: true, description: 'Local audio file path or public URL' },
        language: { type: 'string', description: 'Optional language hint: auto (default), zh or en' }
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const isUrl = /^https?:\/\//.test(args.audio) || /^data:/.test(args.audio)
        const d = await runDriver({
          model: 'mimo-v2.5-asr', kind: 'asr',
          files: isUrl ? [] : [{ kind: 'audio', mime: mimeOf(args.audio), path: wslPathOf(args.audio) }],
          urls: isUrl ? [args.audio] : [],
          prompt: '',
          language: args.language
        }, exec)
        return { answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_tts',
      description: 'Text-to-speech with the Xiaomi MiMo TTS models (mimo-v2.5-tts / -voicedesign — Xiaomi ships no v2.6 voice models). Writes the synthesized audio to a Windows-side file (default C:\\Windows\\Temp\\mimo_tts_<ts>.wav). Voice: preset ID (mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean) or a free-form Chinese voice description (voicedesign).',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to synthesize' },
        voice: { type: 'string', description: 'Preset voice ID or custom voice description (default mimo_default)' },
        output: { type: 'string', description: 'Output path on the Windows side (default C:\\Windows\\Temp\\mimo_tts_<ts>.wav)' },
        format: { type: 'string', description: 'Output audio format: wav (default) or mp3' },
        style: { type: 'string', description: 'Optional speaking style (语气): a natural-language instruction such as 温柔/沉稳/轻快, or a full director-style paragraph (角色/场景/指导). With preset voices the style becomes the user instruction; with voicedesign voices it becomes an inline (风格) tag prefix.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const key = await resolveKey()
        const fmt = args.format === 'mp3' ? 'mp3' : 'wav'
        const outPath = args.output || `C:\\Windows\\Temp\\mimo_tts_${Date.now()}.${fmt}`
        const outWsl = '/mnt/c/Windows/Temp/' + outPath.split(/[\\/]/).pop()
        const voice = args.voice || 'mimo_default'
        const isPreset = PRESET_VOICES.has(voice)
        const model = isPreset ? 'mimo-v2.5-tts' : 'mimo-v2.5-tts-voicedesign'
        const style = typeof args.style === 'string' ? args.style.trim() : ''
        let userContent = isPreset ? (style || 'Speak the following text naturally.') : voice
        let text = args.text
        if (!isPreset && style) {
          // voicedesign owns the user message (the voice description), so the
          // style rides as an inline (风格) tag prefix — matches voice-mimo.
          text = `(${style})${text}`
        }
        const messages = []
        messages.push({ role: 'user', content: userContent })
        messages.push({ role: 'assistant', content: text })
        // optimize_text_preview is voicedesign-only (official TTS docs).
        const audio = isPreset
          ? { format: fmt, voice }
          : { format: fmt, optimize_text_preview: true }
        const body = JSON.stringify({ model, messages, audio })
        const tmp = `${TMP_ROOT}/mimo_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const py = b64([
          'import json,sys,base64,urllib.request,urllib.error',
          'b=open(sys.argv[1],"rb").read()',
          'req=urllib.request.Request(sys.argv[2],data=b,headers={"api-key":sys.argv[3],"Content-Type":"application/json"})',
          'try:',
          '  r=urllib.request.urlopen(req,timeout=150)',
          '  open(sys.argv[4],"wb").write(r.read())',
          '  print("OK")',
          'except urllib.error.HTTPError as e:',
          '  print("HTTP_ERR:"+e.read().decode("utf-8","replace")[:500])',
          'except Exception as ex:',
          '  print("NET_ERR:"+str(ex)[:300])',
        ].join('\n'))
        const pyCmd = `python3 -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode(sys.stdin.read()))' ${shq(tmp + '.json')} <<'DSH_EOF'\n${b64(body)}\nDSH_EOF\nprintf '%s' ${py} | base64 -d | python3 - ${shq(tmp + '.json')} ${shq(BASE_URL + '/chat/completions')} ${shq(key)} ${shq(tmp + '.resp')}`
        const r = await run(pyCmd, exec, { timeoutMs: 200000 })
        const out = r.stdout.text.trim()
        if (!out.startsWith('OK')) {
          await run(`rm -f ${shq(tmp + '.json')} ${shq(tmp + '.resp')}`, exec, { timeoutMs: 5000 }).catch(() => {})
          throw new Error(out.replace(/^(HTTP_ERR|NET_ERR):/, '') || 'TTS failed')
        }
        // Decode the base64 audio inside python (it is ~150KB+, far beyond the
        // shell capture budget) and grab the optional final_text_preview the
        // voicedesign model returns next to it.
        const dec = b64([
          'import json,base64,sys',
          'd=json.load(open(sys.argv[1]))',
          'm=d["choices"][0]["message"]',
          'b=m["audio"]["data"]',
          'open(sys.argv[2],"wb").write(base64.b64decode(b))',
          'p=m.get("final_text_preview")',
          'open(sys.argv[3],"w",encoding="utf-8").write(p if isinstance(p,str) else "")',
        ].join('\n'))
        const decRun = await run(`printf '%s' ${dec} | base64 -d | python3 - ${shq(tmp + '.resp')} ${shq(outWsl)} ${shq(tmp + '.preview')}`, exec, { timeoutMs: 30000 })
        let preview = ''
        try { preview = (await run(`cat ${shq(tmp + '.preview')}`, exec, { timeoutMs: 5000 })).stdout.text.trim() } catch {}
        await run(`rm -f ${shq(tmp + '.json')} ${shq(tmp + '.resp')} ${shq(tmp + '.preview')}`, exec, { timeoutMs: 5000 }).catch(() => {})
        if (decRun.exitCode !== 0) throw new Error(decRun.stderr.text.trim().slice(0, 300) || 'failed to decode synthesized audio')
        let bytes = 0
        try { bytes = Number((await run(`wc -c < ${shq(outWsl)}`, exec, { timeoutMs: 5000 })).stdout.text.trim()) || 0 } catch {}
        return { output: outWsl, bytes, format: fmt, ...preview ? { final_text_preview: preview } : {} }
      }
    },
    {
      name: 'mimo_voiceclone',
      description: 'Voice cloning with the Xiaomi MiMo voice-clone model (mimo-v2.5-tts-voiceclone — Xiaomi ships no v2.6 voice models). Given a reference audio file (wav/mp3, local path or public URL) and target text, synthesizes speech in the reference speaker\'s voice. The reference audio is sent as a data URL; keep it short (a few seconds is enough).',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to synthesize in the cloned voice' },
        reference: { type: 'string', required: true, description: 'Reference audio path (local WSL/Windows path) or public URL — a short clip of the voice to clone' },
        output: { type: 'string', description: 'Output path on the Windows side (default C:\\Windows\\Temp\\mimo_voiceclone_<ts>.wav)' },
        format: { type: 'string', description: 'Output audio format: wav (default) or mp3' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const key = await resolveKey()
        const fmt = args.format === 'mp3' ? 'mp3' : 'wav'
        const outPath = args.output || `C:\\Windows\\Temp\\mimo_voiceclone_${Date.now()}.${fmt}`
        const outWsl = '/mnt/c/Windows/Temp/' + outPath.split(/[\\/]/).pop()
        const ref = String(args.reference)
        const refWsl = wslPathOf(ref)
        const isUrl = /^https?:\/\//i.test(ref)
        // Real MIME from the reference file extension — hardcoding audio/wav
        // misreports an mp3 reference to the API (which then rejects it).
        const refMime = mimeOf(ref)
        const tmp = `${TMP_ROOT}/mimo_vc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        // One python pass: read the reference audio (local file or URL), encode
        // it as a data URL, build the full request body in memory, POST to MiMo,
        // and write the raw response to a file. Everything stays on disk — the
        // reference audio base64 (~154KB for a 115KB clip) must never cross the
        // 64KB shell stdout cap that would truncate the data URL.
        const py = b64([
          'import sys,json,base64,urllib.request,urllib.error',
          'src,text,mime,fmt,api,url,out = sys.argv[1:8]',
          'b=urllib.request.urlopen(src,timeout=60).read() if src.startswith(("http://","https://")) else open(src,"rb").read()',
          'durl="data:%s;base64,"%mime+base64.b64encode(b).decode()',
          'payload={"model":"mimo-v2.5-tts-voiceclone","messages":[{"role":"user","content":"Use this reference voice to speak the following text naturally."},{"role":"assistant","content":text}],"audio":{"format":fmt,"voice":durl}}',
          'req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={"api-key":api,"Content-Type":"application/json"})',
          'try:',
          '  r=urllib.request.urlopen(req,timeout=180)',
          '  open(out,"wb").write(r.read())',
          '  print("OK")',
          'except urllib.error.HTTPError as e:',
          '  open(out,"wb").write(e.read())',
          '  print("HTTP_ERR")',
          'except Exception as ex:',
          '  open(out,"w").write("NET_ERR:"+str(ex)[:300])',
          '  print("NET_ERR")',
        ].join('\n'))
        const pyCmd = `printf '%s' ${py} | base64 -d | python3 - ${shq(isUrl ? ref : refWsl)} ${shq(args.text)} ${shq(refMime)} ${shq(fmt)} ${shq(key)} ${shq(BASE_URL + '/chat/completions')} ${shq(tmp + '.resp')}`
        const r = await run(pyCmd, exec, { timeoutMs: 220000 })
        const status = r.stdout.text.trim()
        await run(`rm -f ${shq(tmp + '.json')}`, exec, { timeoutMs: 5000 }).catch(() => {})
        if (!status.startsWith('OK')) {
          // On failure the response file may carry the HTTP error body; read it
          // through python (not cat) so a large body cannot hit the stdout cap.
          const errPy = b64([
            'import sys',
            'try: print(open(sys.argv[1],"rb").read().decode("utf-8","replace")[:400])',
            'except Exception: print("")',
          ].join('\n'))
          const errRun = await run(`printf '%s' ${errPy} | base64 -d | python3 - ${shq(tmp + '.resp')}`, exec, { timeoutMs: 10000 })
          const errText = (errRun.stdout.text || '').trim()
          await run(`rm -f ${shq(tmp + '.resp')}`, exec, { timeoutMs: 5000 }).catch(() => {})
          throw new Error(errText.replace(/^(HTTP_ERR|NET_ERR):/, '') || status || 'voice clone failed')
        }
        // Extract the base64 audio from the response JSON via python reading the
        // file directly — the audio data can be ~150KB, far beyond the 64KB
        // stdout cap, so `cat` would truncate it.
        const extractPy = b64([
          'import sys,json,base64',
          'try:',
          '  d=json.load(open(sys.argv[1],"rb"))',
          '  b=d["choices"][0]["message"]["audio"]["data"]',
          '  open(sys.argv[2],"wb").write(base64.b64decode(b))',
          '  print("OK")',
          'except Exception as ex:',
          '  print("ERR:"+str(ex)[:300])',
        ].join('\n'))
        const extractRun = await run(`printf '%s' ${extractPy} | base64 -d | python3 - ${shq(tmp + '.resp')} ${shq(outWsl)}`, exec, { timeoutMs: 30000 })
        await run(`rm -f ${shq(tmp + '.resp')}`, exec, { timeoutMs: 5000 }).catch(() => {})
        if (!extractRun.stdout.text.trim().startsWith('OK')) {
          throw new Error(extractRun.stdout.text.trim().replace(/^ERR:/, '') || 'failed to decode audio')
        }
        let bytes = 0
        try { bytes = Number((await run(`wc -c < ${shq(outWsl)}`, exec, { timeoutMs: 5000 })).stdout.text.trim()) || 0 } catch {}
        return { output: outWsl, bytes, format: fmt }
      }
    }
  ]

  for (const tool of tools) {
    ctx.tools.register(defineTool(tool))
  }

  // audio-tools skill: guidance for the MiMo audio toolset (transcribe /
  // speak / voiceclone / understand). The tools themselves are always
  // registered — they are lightweight pure-API calls, unlike vision-toolkit's
  // ten schemas — so this skill only teaches when to use which, and notes
  // what each call sends to the MiMo API.
  const audioSkill = {
    name: 'audio-tools',
    description: 'MiMo audio tools: mimo_asr (transcribe), mimo_tts (speak), mimo_voiceclone (clone a voice), mimo_audio (understand audio content).',
    whenToUse: 'Use whenever a task involves audio: transcribing a recording, synthesizing speech, cloning a voice from a reference clip, or understanding the content of an audio file.',
    source: 'runtime',
    content: [
      '# audio-tools (MiMo edition)',
      '',
      'The Xiaomi MiMo audio tools turn a text-only agent into an audio-capable one. Use the native tools directly; the underlying API is Xiaomi MiMo, not OpenAI — the audio endpoints differ (no /audio/transcriptions or /audio/speech).',
      '',
      '## Tools',
      '',
      '- **mimo_asr** — transcribe an audio file (wav/mp3, local path or URL) to text with the MiMo ASR model (mimo-v2.5-asr). Optionally pass `language` (`auto`/`zh`/`en`) for a hint.',
      '- **mimo_tts** — synthesize text into a .wav/.mp3 file. `voice` is a preset ID (mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean) or a free-form Chinese voice description (uses the voicedesign model). `style` adds a speaking tone; `format` picks wav (default) or mp3. Output lands on the Windows side (default C:\\Windows\\Temp).',
      '- **mimo_voiceclone** — clone a voice: give a short reference audio clip (local path or URL) plus target text; output is speech in the reference speaker\'s voice. `format` picks wav (default) or mp3.',
      '- **mimo_audio** — understand the content of an audio file (wav/mp3/flac/ogg/m4a) with the full-modal MiMo-V2.6 model (default `flash` tier): summarize, extract information, or answer questions about what is said or played.',
      '',
      '## Usage notes',
      '',
      '- Inputs accept local paths (WSL `/home/...`, `/mnt/c/...` or Windows `C:\\...`) or public URLs.',
      '- TTS and voiceclone write .wav files to `C:\\Windows\\Temp` by default (`.mp3` with `format: "mp3"`); pass `output` to choose another Windows-side path.',
      '- For voice cloning, keep the reference clip short (a few seconds); the audio is sent to the MiMo API as a data URL.',
      '- The voice models are still the v2.5 generation (mimo-v2.5-asr / -tts / -voicedesign / -voiceclone): Xiaomi has published no v2.6 voice models.',
      '- These tools send audio to the Xiaomi MiMo API; do not use them for sensitive audio you cannot upload.',
    ].join('\n'),
  }
  try {
    ctx.skills.register(audioSkill)
  } catch (error) {
    // A duplicate or invalid registration must not take the plugin down.
    const logger = ctx.logger
    logger?.warn?.('dsh-mimo-agent-tools: audio-tools skill registration failed: %s', error instanceof Error ? error.message : String(error))
  }
}
