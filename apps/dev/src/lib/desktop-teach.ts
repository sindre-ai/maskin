import {
	DESKTOP_SCREEN_HEIGHT,
	DESKTOP_SCREEN_WIDTH,
	TEACH_MAX_FRAME_BYTES,
	TEACH_MAX_TOTAL_FRAME_BYTES,
	type TeachEvent,
	type TeachRequest,
} from '@maskin/shared'

// "Teach a task" hand-off. The browser sends an action log plus JPEG stills; this
// module validates them and builds what the learning agent reads. The files are
// written under the agent's storage prefix with this file type, so the session
// pulls them to /agent/teach/<recordingId>/ like any other agent file.

export const TEACH_FILE_TYPE = 'teach'
// Recordings are inputs, not records: nothing should keep them. The route deletes
// them when asked to (the page does, once the session ends) and sweeps stragglers.
export const TEACH_RETENTION_MS = 6 * 60 * 60 * 1000

export function teachDir(recordingId: string): string {
	return `${recordingId}`
}

export function frameFileName(frameId: string): string {
	return `frames/${frameId}.jpg`
}

export type DecodedFrame = { id: string; t_ms: number; data: Buffer }

export type DecodeResult = { ok: true; frames: DecodedFrame[] } | { ok: false; message: string }

const JPEG_MAGIC = [0xff, 0xd8, 0xff]

// Standard base64 only: Buffer.from(..., 'base64') silently skips invalid
// characters, which would let garbage through as "an image".
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Decodes and validates the uploaded frames. Everything here is an external
 * input: ids must be unique, the bytes must really be JPEGs, and sizes are
 * capped per frame and in total. Every event's frame reference must exist.
 */
export function decodeTeachFrames(request: TeachRequest): DecodeResult {
	const seen = new Set<string>()
	const frames: DecodedFrame[] = []
	let total = 0

	for (const frame of request.frames) {
		if (seen.has(frame.id)) return { ok: false, message: `Duplicate frame id ${frame.id}` }
		seen.add(frame.id)
		if (!BASE64_RE.test(frame.data_base64)) {
			return { ok: false, message: `Frame ${frame.id} is not valid base64` }
		}
		const data = Buffer.from(frame.data_base64, 'base64')
		if (data.length > TEACH_MAX_FRAME_BYTES) {
			return { ok: false, message: `Frame ${frame.id} is too large` }
		}
		if (!JPEG_MAGIC.every((byte, i) => data[i] === byte)) {
			return { ok: false, message: `Frame ${frame.id} is not a JPEG` }
		}
		total += data.length
		if (total > TEACH_MAX_TOTAL_FRAME_BYTES) {
			return { ok: false, message: 'Recording frames are too large in total' }
		}
		frames.push({ id: frame.id, t_ms: frame.t_ms, data })
	}

	for (const event of request.events) {
		if (event.frame && !seen.has(event.frame)) {
			return { ok: false, message: `Event refers to missing frame ${event.frame}` }
		}
	}
	if (request.final_frame && !seen.has(request.final_frame)) {
		return { ok: false, message: `Final frame ${request.final_frame} is missing` }
	}
	return { ok: true, frames }
}

function describeEvent(event: TeachEvent): Record<string, unknown> {
	const base = {
		at_seconds: Math.round(event.t_ms / 100) / 10,
		screenshot: event.frame ? frameFileName(event.frame) : null,
	}
	switch (event.type) {
		case 'click':
			return {
				...base,
				action: event.double ? 'double_click' : 'click',
				button: event.button,
				x: event.x,
				y: event.y,
			}
		case 'scroll':
			return {
				...base,
				action: 'scroll',
				direction: event.direction,
				amount: event.amount,
				x: event.x,
				y: event.y,
			}
		case 'type':
			return { ...base, action: 'type', text: event.text }
		case 'key':
			return { ...base, action: 'key', keys: event.keys }
	}
}

/** The action log the agent reads: numbered, in order, each pointing at its screenshot. */
export function buildActionLog(request: TeachRequest): string {
	const actions = request.events.map((event, i) => ({ step: i + 1, ...describeEvent(event) }))
	return JSON.stringify(
		{
			task: request.description,
			duration_seconds: Math.round(request.duration_ms / 1000),
			screen: { width: DESKTOP_SCREEN_WIDTH, height: DESKTOP_SCREEN_HEIGHT },
			actions,
			final_screenshot: request.final_frame ? frameFileName(request.final_frame) : null,
		},
		null,
		2,
	)
}

export function buildReadme(recordingId: string, request: TeachRequest): string {
	return `# Recording ${recordingId}

A person demonstrated this task on the shared workspace desktop:

> ${request.description.replace(/\n/g, '\n> ')}

## Files

- \`log.json\` — every action in order (\`click\`, \`double_click\`, \`scroll\`, \`type\`, \`key\`), with the
  time it happened and the screenshot taken at that moment.
- \`frames/fNNN.jpg\` — screenshots of the ${DESKTOP_SCREEN_WIDTH}x${DESKTOP_SCREEN_HEIGHT} screen, taken
  *just before* the action it belongs to. \`x\`/\`y\` in the log are pixels in that image, with (0,0) at the
  top-left. Some actions have no screenshot (a cap on how many were kept).

There is no video. To see what an action did, look at the next step's screenshot; \`final_screenshot\` in
\`log.json\` shows the screen after the last action.

## Reading it

Open \`log.json\`, then open the screenshots one at a time and work out what each click or keypress was
for: which button, field or menu was under the pointer, and what changed on the next screen.

The \`type\` text is exactly what the person typed. It may contain passwords or tokens.
`
}

export function buildTeachPrompt(opts: {
	recordingId: string
	description: string
	agentId: string
	agentName: string
}): string {
	const dir = `/agent/${TEACH_FILE_TYPE}/${opts.recordingId}`
	return `A teammate just showed you how to do a task on the shared workspace desktop. Learn it by writing a reusable skill.

Task, in their words:
"""
${opts.description}
"""

The recording is in ${dir}/ — start with ${dir}/README.md, then ${dir}/log.json, then look at the screenshots in ${dir}/frames/. There is no video: each action has a screenshot taken just before it.

Write the skill:
1. Work out the real procedure behind the clicks. Describe each step by WHAT you act on (the "Export" button, the search field, the Settings menu), never by pixel coordinates — coordinates break as soon as a page moves.
2. Say when to use the skill (a one-line trigger), what must be true before starting, the numbered steps, how to check each important step worked, and what to do if it didn't.
3. One demonstration misses things. Add the decision rules and failure handling a careful person would apply, and mark clearly anything you are guessing so the teammate can correct it.
4. NEVER copy a password, token, API key or other secret from the typed text into the skill. Where a step needs a credential, write a placeholder and say where to get it.
5. Do not carry out the task yourself. You are only writing the skill.

Save it:
- Create the skill with create_workspace_skill: a short lowercase-hyphenated name, and SKILL.md content that starts with YAML frontmatter (name, description) — the description must say when to use it.
- Attach it to yourself with update_actor, actor id ${opts.agentId}, using attach_skill_ids (this adds to your skills; it does not replace them).

When you are done, reply with the skill name, a short summary of the steps you learned, and the things you were unsure about.`
}
