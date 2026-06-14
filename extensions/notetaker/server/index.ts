import { OpenAPIHono } from '@hono/zod-openapi'
import type { ModuleDefinition, ModuleEnv } from '@maskin/module-sdk'
import {
	MEETING_DISPLAY_NAME,
	MEETING_FIELDS,
	MEETING_RELATIONSHIP_TYPES,
	MEETING_STATUSES,
	MODULE_ID,
	MODULE_NAME,
	NOTETAKER_DEFAULT_SETTINGS,
} from '../shared.js'
import { NotetakerDispatchPoller } from './poller.js'

export { NotetakerDispatchPoller } from './poller.js'
export * from './policy.js'
export * from './skjald.js'

function log(level: 'info' | 'warn', msg: string, ctx?: Record<string, unknown>): void {
	const line = JSON.stringify({
		level,
		msg,
		timestamp: new Date().toISOString(),
		...ctx,
	})
	console.log(line)
}

function isEnabled(): boolean {
	const raw = process.env.NOTETAKER_POLLER_ENABLED
	return raw === '1' || raw === 'true'
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? n : undefined
}

let activePoller: NotetakerDispatchPoller | null = null

/**
 * Test-only hook — stops and detaches the active poller so a subsequent test
 * can call `notetakerExtension.routes(env)` and observe a fresh start.
 */
export function __resetActivePollerForTests(): void {
	activePoller?.stop()
	activePoller = null
}

function buildRoutes(env: ModuleEnv): OpenAPIHono {
	const app = new OpenAPIHono()

	app.get('/health', (c) =>
		c.json({
			status: 'ok',
			pollerActive: activePoller !== null,
		}),
	)

	if (!isEnabled()) {
		log('info', 'Notetaker poller disabled (NOTETAKER_POLLER_ENABLED is not set)')
		return app
	}

	const skjaldUrl = process.env.SKJALD_URL
	const apiKey = process.env.SKJALD_API_KEY
	if (!skjaldUrl || !apiKey) {
		log('warn', 'Notetaker poller enabled but SKJALD_URL/SKJALD_API_KEY missing — not starting', {
			hasUrl: Boolean(skjaldUrl),
			hasApiKey: Boolean(apiKey),
		})
		return app
	}

	// Idempotent — `routes(env)` is invoked exactly once at boot in production,
	// but tests/HMR can re-enter; reuse the existing poller if so.
	if (activePoller) return app

	activePoller = new NotetakerDispatchPoller(env.db, {
		skjaldUrl,
		apiKey,
		intervalMs: parsePositiveInt(process.env.NOTETAKER_POLL_INTERVAL_MS),
		leadWindowMs: parsePositiveInt(process.env.NOTETAKER_LEAD_WINDOW_MS),
	})
	activePoller.start()

	return app
}

const notetakerExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'meeting',
			label: MEETING_DISPLAY_NAME,
			icon: 'video',
			defaultStatuses: [...MEETING_STATUSES],
			defaultFields: MEETING_FIELDS,
			defaultRelationshipTypes: [...MEETING_RELATIONSHIP_TYPES],
		},
	],
	defaultSettings: NOTETAKER_DEFAULT_SETTINGS,
	routes: buildRoutes,
}

export default notetakerExtension
