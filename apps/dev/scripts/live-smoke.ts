// Real-provider smoke test for Live mode. Mocks are evidence of nothing about
// OpenRouter, so this calls the three endpoints live mode depends on and prints
// what actually comes back.
//
// Run:
//   OPENROUTER_API_KEY=sk-or-... pnpm --filter @maskin/dev exec tsx scripts/live-smoke.ts [--tts-model <id>] [--llm-model <id>]
//
// (MASKIN_FALLBACK_OPENROUTER_KEY is accepted in place of OPENROUTER_API_KEY.)
//
// 1. A streamed chat completion with one forced tool call: time to first token,
//    the reassembled tool call, and the cost OpenRouter reports.
// 2. One sentence of TTS: the sample rate the provider really returns, time to
//    first audio byte, byte count. Written next to this file's scratch output.
// 3. That audio sent back through transcription: proves both audio endpoints and
//    the PCM handling end to end.
//
// Run it for every TTS model in MASKIN_LIVE_TTS_MODEL's allowlist before
// offering that model. Paste the output into the PR (live-verification rule).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	DEFAULT_LIVE_STT_MODEL,
	DEFAULT_LIVE_TTS_MODEL,
	DEFAULT_LIVE_TTS_VOICE,
	OPENROUTER_API_BASE,
} from '../src/lib/live-credentials'
import { ToolCallAccumulator, streamChatCompletion } from '../src/lib/llm/openai-stream'
import { pcm16ToWav, transcribeAudio } from '../src/services/live-stt'
import { synthesizeSentence } from '../src/services/live-tts'

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}

const apiKey = process.env.OPENROUTER_API_KEY || process.env.MASKIN_FALLBACK_OPENROUTER_KEY
if (!apiKey) {
	console.error('Set OPENROUTER_API_KEY (or MASKIN_FALLBACK_OPENROUTER_KEY).')
	process.exit(2)
}
const llmModel = arg('llm-model') || process.env.MASKIN_LIVE_MODEL || 'deepseek/deepseek-v4.1-flash'
const ttsModel = arg('tts-model') || process.env.MASKIN_LIVE_TTS_MODEL || DEFAULT_LIVE_TTS_MODEL
const ttsVoice = process.env.MASKIN_LIVE_TTS_VOICE || DEFAULT_LIVE_TTS_VOICE
const sttModel = process.env.MASKIN_LIVE_STT_MODEL || DEFAULT_LIVE_STT_MODEL
const ms = (t0: number) => `${Math.round(performance.now() - t0)} ms`

let failed = false
const fail = (step: string, e: unknown) => {
	failed = true
	console.error(`FAIL ${step}:`, e instanceof Error ? e.message : e)
}

// 1. Streamed chat with a forced tool call.
console.log(`\n1. chat  model=${llmModel}`)
try {
	const t0 = performance.now()
	let first = -1
	let text = ''
	let cost: number | undefined
	let tokens = ''
	const calls = new ToolCallAccumulator()
	for await (const ev of streamChatCompletion({
		apiKey,
		baseUrl: OPENROUTER_API_BASE,
		model: llmModel,
		messages: [
			{
				role: 'system',
				content: 'You are a voice assistant. Use tools when asked to look something up.',
			},
			{ role: 'user', content: 'Look up the bet called "retry window" using the search tool.' },
		],
		tools: [
			{
				type: 'function',
				function: {
					name: 'search_objects',
					description: 'Search the workspace for items by keyword.',
					parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
				},
			},
		],
	})) {
		if (first < 0 && (ev.type === 'text' || ev.type === 'tool_call')) first = performance.now() - t0
		if (ev.type === 'text') text += ev.delta
		if (ev.type === 'tool_call') calls.push(ev)
		if (ev.type === 'usage') {
			cost = ev.usage.cost
			tokens = `${ev.usage.prompt_tokens} in / ${ev.usage.completion_tokens} out`
		}
	}
	console.log(
		`   time to first token: ${first < 0 ? 'none' : `${Math.round(first)} ms`}, total ${ms(t0)}`,
	)
	console.log(`   text: ${JSON.stringify(text.slice(0, 120))}`)
	console.log(`   tool calls: ${JSON.stringify(calls.finish())}`)
	console.log(
		`   usage: ${tokens || 'not reported'}  cost: ${cost === undefined ? 'NOT REPORTED' : `$${cost}`}`,
	)
	if (calls.size === 0)
		console.log(
			'   NOTE: the model did not call the tool; pick a stronger MASKIN_LIVE_MODEL for live.',
		)
} catch (e) {
	fail('chat', e)
}

// 2. TTS, then 3. STT on its output.
console.log(`\n2. tts   model=${ttsModel} voice=${ttsVoice}`)
let audio: { pcm: Uint8Array; sampleRate: number } | null = null
try {
	const t0 = performance.now()
	const a = await synthesizeSentence({
		apiKey,
		baseUrl: OPENROUTER_API_BASE,
		model: ttsModel,
		voice: ttsVoice,
		text: 'The retry window is seven days, and two bets are blocked on legal.',
	})
	let firstByte = -1
	const chunks: Uint8Array[] = []
	for await (const c of a.pcm) {
		if (firstByte < 0) firstByte = performance.now() - t0
		chunks.push(c)
	}
	const pcm = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
	let o = 0
	for (const c of chunks) {
		pcm.set(c, o)
		o += c.length
	}
	console.log(
		`   sample rate returned/assumed: ${a.sampleRate} Hz, ${a.channels} ch, ${a.bitsPerSample}-bit`,
	)
	console.log(
		`   time to first audio: ${Math.round(firstByte)} ms, total ${ms(t0)}, ${pcm.length} bytes (~${(pcm.length / 2 / a.sampleRate).toFixed(2)} s of audio)`,
	)
	if (pcm.length === 0) throw new Error('empty audio')
	audio = { pcm, sampleRate: a.sampleRate }
	const out = join(process.env.TMPDIR || '.', 'live-smoke.wav')
	writeFileSync(out, pcm16ToWav(pcm, a.sampleRate))
	console.log(`   wrote ${out} (listen to it: the speech must sound right, not like static)`)
} catch (e) {
	fail('tts', e)
}

console.log(`\n3. stt   model=${sttModel}`)
if (audio) {
	try {
		const t0 = performance.now()
		const r = await transcribeAudio({
			apiKey,
			baseUrl: OPENROUTER_API_BASE,
			model: sttModel,
			audio: pcm16ToWav(audio.pcm, audio.sampleRate),
			format: 'wav',
			language: 'en',
		})
		console.log(`   ${ms(t0)}  text: ${JSON.stringify(r.text)}`)
		console.log(
			`   seconds: ${r.seconds ?? 'not reported'}  cost: ${r.costUsd === null ? 'NOT REPORTED' : `$${r.costUsd}`}`,
		)
		const ok = /retry/i.test(r.text) && /seven/i.test(r.text)
		console.log(
			ok
				? '   round trip OK (the audio is intelligible and the format is right)'
				: '   ROUND TRIP MISMATCH: the TTS format or sample rate is probably wrong',
		)
		if (!ok) failed = true
	} catch (e) {
		fail('stt', e)
	}
} else {
	console.log('   skipped (no audio from step 2)')
}

console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE OK')
process.exit(failed ? 1 : 0)
