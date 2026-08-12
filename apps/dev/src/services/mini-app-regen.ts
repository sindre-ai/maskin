/**
 * Daily mini-app regen.
 *
 * The bet's architecture is "refresh = agent rewrites the app file": an
 * existing cron trigger fires an agent session whose action prompt drives the
 * regen. Those two backend paths already exist (trigger runner + update_file's
 * in-place byte swap on the same file id) and are reused untouched — this
 * module is the testable kernel that produces the slot and the trigger for
 * that flow, plus the affordance to provision the daily trigger.
 *
 * The data slot is the seam the app reads: a
 * `<script id="maskin-state" type="application/json">` node whose parsed value
 * the app template exposes as `window.__MASKIN_APP_DATA__`. Regen refills that
 * node from current workspace objects — no content lives outside the slot.
 */

export const MASKIN_STATE_SLOT_ID = 'maskin-state'
export const MASKIN_APP_DATA_WINDOW_KEY = '__MASKIN_APP_DATA__'

// Daily, off the :00/:30 marks so it doesn't pile onto the top of the hour.
export const DAILY_REGEN_CRON = '17 3 * * *'

export interface MiniAppFileRef {
	/** The file object id the app lives on — must stay the same across regen. */
	id: string
	/** Display name of the file/app. */
	name: string
}

/** Serialize a value as JSON safe to inline inside a `</script>`-terminated node. */
export function jsonEncodeForScript(value: unknown): string {
	// Escaping `<` as \u003c keeps a baked `</script>` from terminating the
	// node early while staying valid JSON (recovered by JSON.parse).
	return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** Build the data-slot node with live objects baked in. */
export function buildMaskinStateSlot(objects: unknown[]): string {
	const json = jsonEncodeForScript(objects)
	return `<script id="${MASKIN_STATE_SLOT_ID}" type="application/json">${json}</script>`
}

/**
 * Deterministic action prompt that drives the regen agent once the daily cron
 * trigger fires. Encodes the whole keep-current procedure: repopulate the
 * slot, rewrite the SAME file id in place (never a copy), and smoke-check the
 * new file before it counts as published.
 */
export function buildDailyRegenActionPrompt(file: MiniAppFileRef): string {
	return [
		`Regenerate the hosted mini-app "${file.name}" (file id ${file.id}) so it stays current.`,
		'',
		'Steps:',
		'1. Fetch the current workspace objects this app should display (get_objects / search_objects).',
		`2. Bake them into the data slot — the <script id="${MASKIN_STATE_SLOT_ID}" type="application/json"> node the app exposes as window.${MASKIN_APP_DATA_WINDOW_KEY} — keeping the slot contract the app already reads. All app data lives in that slot; nothing hardcoded outside it.`,
		'3. Keep the file a single self-contained .html that renders offline (no network calls), matching the app template and the egress-blocked CSP.',
		`4. Rewrite the file IN PLACE: call update_file on THIS SAME id (${file.id}) with the complete regenerated document in one atomic call. Never create a new object or copy — the pin keeps resolving this id. Validate the full document before the write so there is no broken intermediate state.`,
		'5. Smoke-test the new file before considering it published: verify it still opens/renders and that the data slot carries the fresh objects.',
		'',
		'If the file no longer exists, recreate it with create_file using the same name and this slot contract, then continue.',
	].join('\n')
}

export function dailyRegenTriggerName(appName: string): string {
	return `Regen ${appName || 'mini-app'} daily`
}

export interface DailyRegenTriggerParams {
	file: MiniAppFileRef
	targetActorId: string
	/** Falls back to the file name. */
	appName?: string
	triggerName?: string
}

export interface DailyRegenTriggerBody {
	name: string
	type: 'cron'
	config: { expression: string; file_id: string }
	action_prompt: string
	target_actor_id: string
	enabled: true
}

/**
 * The cron trigger row that makes a hosted app regenerate daily. Shapes to the
 * existing `createTriggerSchema` so it can be persisted through the standard
 * triggers path; the trigger runner schedules it with the runner's own
 * `config.expression`, no new trigger machinery.
 */
export function buildDailyRegenTrigger(params: DailyRegenTriggerParams): DailyRegenTriggerBody {
	const appName = params.appName ?? params.file.name
	return {
		name: params.triggerName ?? dailyRegenTriggerName(appName),
		type: 'cron',
		// file_id makes the trigger self-describing so the provision route can
		// upsert per-file instead of per-name — apps routinely share filenames
		// across folders, and a name-only key would let one trigger silently
		// take over another app's regen.
		config: { expression: DAILY_REGEN_CRON, file_id: params.file.id },
		action_prompt: buildDailyRegenActionPrompt(params.file),
		target_actor_id: params.targetActorId,
		enabled: true,
	}
}
