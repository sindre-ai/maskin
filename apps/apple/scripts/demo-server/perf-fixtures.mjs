// Heavy, deterministic demo data for the scroll and memory measurements (Apps/MaskinUITests/
// ScrollPerfTests.swift, scripts/perf-scroll.sh). Only served when the demo server runs with
// DEMO_PERF=1, so the screenshots other work relies on keep their small, curated lists.
//
//   - A "Brand shoot" room with 400 messages, about a third of them carrying a photo (some three).
//     The photos are 24 distinct 1600x1200 PNGs, so each one costs a real fetch and decode.
//   - A For you feed of 40 decision cards plus 12 email drafts to review, with the v8 flag on.
//
// Nothing here is random: the same server always serves the same bytes and the same text.
import { deflateSync } from 'node:zlib'

export const PERF_ROOM = 310
export const MESSAGE_COUNT = 400
const IMAGE_COUNT = 24
const IMAGE_W = 1600
const IMAGE_H = 1200

const imageId = (uuid, k) => uuid(5000 + k)

// ── PNG encoder (no dependencies) ─────────────────────────────────────────────────────────────
const crcTable = (() => {
	const t = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		t[n] = c >>> 0
	}
	return t
})()

function crc32(buf) {
	let c = 0xffffffff
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(body))
	return Buffer.concat([len, body, crc])
}

const pngCache = new Map()

/** A photo-sized image: colour gradients, rings and fine deterministic grain, so it neither
 *  compresses to nothing nor decodes as a flat colour. */
function png(k) {
	if (pngCache.has(k)) return pngCache.get(k)
	const raw = Buffer.alloc((IMAGE_W * 3 + 1) * IMAGE_H)
	let seed = 1234567 + k * 7919
	const hue = (k * 47) % 360
	let o = 0
	for (let y = 0; y < IMAGE_H; y++) {
		raw[o++] = 0
		for (let x = 0; x < IMAGE_W; x++) {
			seed = (seed * 1664525 + 1013904223) >>> 0
			const grain = ((seed >>> 24) % 9) - 4
			const dx = x - IMAGE_W / 2
			const dy = y - IMAGE_H / 2
			const ring = Math.sin(Math.hypot(dx, dy) / (18 + (k % 7))) * 40
			const r = 120 + 100 * Math.sin((x / IMAGE_W) * 3 + hue) + ring + grain
			const g = 120 + 100 * Math.sin((y / IMAGE_H) * 4 + hue / 2) + ring / 2 + grain
			const b = 140 + 90 * Math.cos(((x + y) / IMAGE_W) * 2 + hue) + grain
			raw[o++] = Math.max(0, Math.min(255, r))
			raw[o++] = Math.max(0, Math.min(255, g))
			raw[o++] = Math.max(0, Math.min(255, b))
		}
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(IMAGE_W, 0)
	ihdr.writeUInt32BE(IMAGE_H, 4)
	ihdr[8] = 8
	ihdr[9] = 2
	const bytes = Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 3 })),
		chunk('IEND', Buffer.alloc(0)),
	])
	pngCache.set(k, bytes)
	return bytes
}

// ── The long thread ────────────────────────────────────────────────────────────────────────────
const SENTENCES = [
	'Pulled the second set from the Friday shoot.',
	'The warm light on the studio wall works better than the grey one.',
	'Can we crop these to square for the feed?',
	'I tagged the ones with the product label facing the camera.',
	'Northwind wants three options by Thursday, so these are the front runners.',
	'Colour grade is still rough; I kept the skin tones close to the raw files.',
	'Dropping the outdoor ones, the sky blew out in half of them.',
	'Here is the contact sheet. Numbers 4, 9 and 17 are my picks.',
	'Retouching is booked for Monday morning, so tell me before then.',
	'Agreed. Send the picks over and I will queue the export.',
]

function messageText(i) {
	const n = 1 + (i % 4)
	const parts = []
	for (let k = 0; k < n; k++) parts.push(SENTENCES[(i * 3 + k * 7) % SENTENCES.length])
	return `${parts.join(' ')} (${i})`
}

function attachmentsFor(i, uuid) {
	if (i % 11 === 0) {
		return [0, 1, 2].map((j) => photoRef(uuid, i * 3 + j))
	}
	if (i % 3 === 0) return [photoRef(uuid, i)]
	return []
}

function photoRef(uuid, seed) {
	const k = seed % IMAGE_COUNT
	return {
		file_id: imageId(uuid, k),
		name: `shoot-${String(k + 1).padStart(2, '0')}.png`,
		mime_type: 'image/png',
		size_bytes: png(k).length,
	}
}

/** Adds the long room to the Team list. Call once at load, before the rooms are served. */
export function addPerfRoom(rooms, ids) {
	// Encode every photo now: a first request that pauses for a minute would measure the server.
	for (let k = 0; k < IMAGE_COUNT; k++) png(k)
	rooms.unshift({
		n: PERF_ROOM,
		title: 'Brand shoot',
		with: [ids.PRIYA, ids.CHIEF],
		unread: 0,
		snippet: messageText(MESSAGE_COUNT),
		by: 'Priya Rao',
		at: 1,
	})
}

export function perfOverrides({ method, path, query, item, base, ctx }) {
	const { uuid, ago, ME, actors, WORKSPACE_ID, CHIEF, PRIYA } = ctx

	if (method === 'get' && path === '/api/feature-flags') {
		return { body: { flags: { 'apple-foryou-v8': true } } }
	}

	// Photos: the same endpoint the chat and Files use, base64 inside JSON.
	const file = path.match(/^\/api\/files\/([^/]+)$/)
	if (method === 'get' && file) {
		const k = Array.from({ length: IMAGE_COUNT }, (_, j) => j).find(
			(j) => imageId(uuid, j) === file[1],
		)
		if (k === undefined) return null
		const bytes = png(k)
		return {
			body: {
				...base,
				id: file[1],
				workspaceId: WORKSPACE_ID,
				name: `shoot-${String(k + 1).padStart(2, '0')}.png`,
				description: null,
				mimeType: 'image/png',
				sizeBytes: bytes.length,
				createdBy: PRIYA,
				createdAt: ago(60),
				updatedAt: ago(60),
				content: bytes.toString('base64'),
				encoding: 'base64',
				url: 'https://maskin.io',
			},
		}
	}

	const msgs = path.match(/^\/api\/conversations\/([^/]+)\/messages$/)
	if (method === 'get' && msgs && msgs[1] === uuid(PERF_ROOM)) {
		const num = (key) => {
			const v = Number(query.get(key))
			return Number.isFinite(v) && v > 0 ? v : null
		}
		const limit = Math.min(num('limit') ?? 50, 200)
		const before = num('before_id')
		const after = num('after_id')
		let ids = Array.from({ length: MESSAGE_COUNT }, (_, j) => j + 1)
		if (before) ids = ids.filter((i) => i < before)
		if (after) ids = ids.filter((i) => i > after)
		const hasMore = ids.length > limit
		// Newest first when paging into the past, oldest first when catching up.
		ids = after ? ids.slice(0, limit) : ids.slice(-limit)
		const people = [actors.find((a) => a.id === PRIYA), actors.find((a) => a.id === ME.id)]
		return {
			body: {
				messages: ids.map((i) => {
					const who = people[i % 3 === 0 ? 1 : 0]
					const photos = attachmentsFor(i, uuid)
					return {
						...item,
						id: i,
						conversationId: uuid(PERF_ROOM),
						actorId: who.id,
						actorName: who.name,
						actorType: who.type ?? 'human',
						kind: 'message',
						content: messageText(i),
						metadata: photos.length ? { attachments: photos } : null,
						sessionId: null,
						createdAt: ago((MESSAGE_COUNT - i) * 7 + 1),
						editedAt: null,
						spawned_sessions: [],
					}
				}),
				has_more: hasMore,
			},
		}
	}

	if (method === 'get' && path === '/api/for-you') return { body: { items: forYou(item, ctx) } }
	return null
}

// ── For you: 40 decisions and 12 email drafts ──────────────────────────────────────────────────
const TOPICS = [
	'Contoso renewal terms',
	'Q4 webinar spend',
	'Northwind pricing page',
	'Berlin offsite budget',
	'Partner programme draft',
	'Hiring plan for support',
	'Invoice 2041 dispute',
	'Press embargo date',
]

function forYou(item, ctx) {
	const { uuid, ago, CHIEF, WORKSPACE_ID } = ctx
	const object = (n, title) => ({
		id: uuid(n),
		workspaceId: WORKSPACE_ID,
		type: 'task',
		title,
		content: null,
		status: 'in_progress',
		metadata: {},
		driver: CHIEF,
		activeSessionId: null,
		createdBy: CHIEF,
		createdAt: ago(10 * 24 * 60),
		updatedAt: ago(30),
		is_subscribed: true,
		unread_count: 1,
		subscriber_count: 2,
		is_starred_by_me: false,
	})
	const out = []
	for (let i = 0; i < 40; i++) {
		const topic = `${TOPICS[i % TOPICS.length]} ${Math.floor(i / TOPICS.length) + 1}`
		const obj = object(6000 + i, topic)
		out.push({
			...item,
			notification_id: null,
			source: 'decision',
			rank: i,
			latest_event_id: 20000 + i,
			headline: `Decide: ${topic}`,
			rationale: null,
			due_at: null,
			created_at: ago(20 + i * 9),
			entity_type: 'object',
			entity_id: obj.id,
			session_id: null,
			object: obj,
			latest_mention: {
				event_id: 20000 + i,
				actor_id: CHIEF,
				created_at: ago(20 + i * 9),
				content: `${topic}: the agent has a recommendation and needs your call before the end of the day.`,
				attention: 90 - i,
				decision: {
					title: `Go ahead with ${topic}?`,
					summary: `The agent checked the numbers for ${topic} and found nothing blocking. It recommends going ahead.`,
					ask: 'Go ahead?',
					options: [
						{
							label: 'Go ahead',
							consequences: ['Starts today'],
							recommended: true,
							destructive: false,
						},
						{
							label: 'Hold',
							consequences: ['Nothing changes'],
							recommended: false,
							destructive: false,
						},
					],
				},
			},
		})
	}
	for (let i = 0; i < 12; i++) {
		const obj = object(6100 + i, `Reply to contact ${i + 1}`)
		const draftObject = uuid(6200 + i)
		out.push({
			...item,
			notification_id: null,
			source: 'decision',
			rank: 40 + i,
			latest_event_id: 21000 + i,
			headline: `Email to contact ${i + 1}`,
			rationale: null,
			due_at: null,
			created_at: ago(5 + i),
			entity_type: 'object',
			entity_id: obj.id,
			session_id: null,
			object: obj,
			latest_mention: {
				event_id: 21000 + i,
				actor_id: CHIEF,
				created_at: ago(5 + i),
				content: `Draft email ready for contact ${i + 1}.`,
				attention: 95,
				decision: {
					title: `Send the follow-up to contact ${i + 1}?`,
					summary: 'The agent wrote a short follow-up and wants your approval before it goes out.',
					ask: 'Send it?',
					options: [
						{
							label: 'Send',
							consequences: ['Reaches a real person'],
							recommended: true,
							destructive: false,
						},
						{
							label: 'Hold',
							consequences: ['Nothing is sent'],
							recommended: false,
							destructive: false,
						},
					],
					draft: {
						id: `draft-${i}`,
						object_id: draftObject,
						label: `Email to contact ${i + 1}`,
						to: `Contact ${i + 1}, Northwind`,
						body: '',
						preview: {
							kind: 'email',
							label: 'Email',
							provider: 'gmail',
							recipients: [
								{
									role: 'to',
									name: `Contact ${i + 1}`,
									address: `contact${i + 1}@northwind.example`,
								},
							],
							subject: `Following up on ${TOPICS[i % TOPICS.length]}`,
							details: [],
							context: null,
							body: Array.from(
								{ length: 3 + (i % 3) },
								(_, p) => SENTENCES[(i + p * 3) % SENTENCES.length],
							).join('\n\n'),
							maxLength: null,
							missing: [],
							warnings: [],
							content_hash: `hash-${i}`,
							delivery: { state: 'draft', at: null },
						},
					},
				},
			},
		})
	}
	return out
}
