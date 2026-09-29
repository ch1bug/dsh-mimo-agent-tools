// Static registration tests for dsh-mimo-agent-tools index.js — no network,
// no real ctx: we fake the minimal ctx surface (tools.register, skills.register,
// ctx.get) and assert what the plugin declares.
//
// Run: node --test tests/tools.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from '../index.js'

function makeCtx() {
  const registered = []
  const skills = []
  const ctx = {
    get() { return undefined },
    tools: { register(t) { registered.push(t) } },
    skills: { register(s) { skills.push(s) } },
    logger: { warn() {} },
  }
  apply(ctx)
  return { registered, skills }
}

const { registered, skills } = makeCtx()
const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
// defineTool wraps parameters into a JSON schema: { type, properties, required }.
const props = (t) => t.parameters?.properties ?? {}

test('plugin metadata', () => {
  assert.equal(name, 'dsh-mimo-agent-tools')
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('shell'))
})

test('registers all 9 tools', () => {
  const expected = ['mimo_search', 'mimo_think', 'mimo_json', 'mimo_vision', 'mimo_audio', 'mimo_video', 'mimo_asr', 'mimo_tts', 'mimo_voiceclone']
  assert.deepEqual(Object.keys(byName).sort(), [...expected].sort())
})

test('every tool declares required params with required:true only (DSH 0.2 DSL)', () => {
  // The current value-schema DSL rejects `required: false`: an optional
  // property OMITS `required`. A tool that regresses here fails at defineTool.
  for (const t of Object.values(byName)) {
    for (const [key, spec] of Object.entries(props(t))) {
      if (spec.required !== undefined) {
        assert.equal(spec.required, true, `${t.name}.${key} must use required: true or omit required`)
      }
    }
  }
})

test('mimo_tts preset list spells Dean (not Dea) in description', () => {
  const d = byName.mimo_tts.description
  assert.ok(d.includes('Dean'), 'description should list Dean')
  // word-boundary check: /Dean is fine, a bare Dea token is the bug
  assert.ok(!/\/Dea(?![a-z])/.test(d), 'no stray Dea token in description')
})

test('mimo_tts exposes format + style', () => {
  const p = props(byName.mimo_tts)
  assert.equal(p.format.type, 'string')
  assert.equal(p.style.type, 'string')
  assert.ok(p.format.description.includes('wav'))
  assert.ok(p.format.description.includes('mp3'))
})

test('mimo_search exposes force_search + user_location', () => {
  const p = props(byName.mimo_search)
  assert.equal(p.force_search.type, 'boolean')
  assert.equal(p.user_location.type, 'object')
})

test('mimo_video exposes fps + media_resolution and accepts local files', () => {
  const p = props(byName.mimo_video)
  // The API takes fps as a float in [0.1, 10.0] and media_resolution as default|max.
  assert.equal(p.fps.type, 'number')
  assert.equal(p.media_resolution.type, 'string')
  assert.deepEqual([...p.media_resolution.enum], ['default', 'max'])
  assert.ok(byName.mimo_video.description.includes('local video file'), 'video should accept local files')
})

test('chat-side tools expose a model parameter with the V2.6 tiers', () => {
  for (const t of ['mimo_search', 'mimo_think', 'mimo_json', 'mimo_vision', 'mimo_audio', 'mimo_video']) {
    const p = props(byName[t])
    assert.equal(p.model.type, 'string', `${t} should accept a model tier`)
    assert.ok(p.model.description.includes('pro'), `${t} model description should name the pro tier`)
    assert.ok(p.model.description.includes('flash'), `${t} model description should name the flash tier`)
    assert.ok(p.model.description.includes('ultraspeed'), `${t} model description should name the ultraspeed tier`)
  }
})

test('no tool references the deprecated mimo-v2.5 / mimo-v2.5-pro chat models', () => {
  const voiceTools = new Set(['mimo_asr', 'mimo_tts', 'mimo_voiceclone'])
  for (const t of Object.values(byName)) {
    assert.ok(!t.description.includes('mimo-v2.5-pro'), `${t.name} should not name the deprecated mimo-v2.5-pro`)
    if (!voiceTools.has(t.name)) {
      assert.ok(!t.description.includes('mimo-v2.5'), `${t.name} should target MiMo-V2.6, not the deprecated v2.5 chat models`)
    }
  }
})

test('mimo_think and mimo_json exist with required prompt param', () => {
  assert.ok(byName.mimo_think.parameters.required.includes('prompt'))
  assert.ok(byName.mimo_json.parameters.required.includes('prompt'))
})

test('mimo_voiceclone exposes format (wav/mp3)', () => {
  const p = props(byName.mimo_voiceclone)
  assert.equal(p.format.type, 'string')
  assert.ok(p.format.description.includes('wav'))
  assert.ok(p.format.description.includes('mp3'))
})

test('audio + asr descriptions claim URL support (now true)', () => {
  for (const t of ['mimo_audio', 'mimo_asr']) {
    assert.ok(byName[t].description.includes('public URL'), `${t} description should claim URL support`)
  }
})

test('registers the audio-tools skill with Dean (no Dea)', () => {
  assert.ok(skills.some((s) => s.name === 'audio-tools'))
  const skill = skills.find((s) => s.name === 'audio-tools')
  assert.ok(skill.content.includes('Dean'))
  assert.ok(!/\/Dea(?![a-z])/.test(skill.content))
})

test('runtime skill registration carries the now-required source field', () => {
  const skill = skills.find((s) => s.name === 'audio-tools')
  assert.equal(skill.source, 'runtime')
  assert.ok(skill.description.length > 0, 'the skills service rejects an empty description')
})
