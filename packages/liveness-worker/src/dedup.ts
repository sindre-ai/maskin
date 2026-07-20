/**
 * Silence-flag dedup backed by Workers KV. A plain module-level variable is not
 * usable here — Cloudflare recycles V8 isolates between invocations, so the
 * flag would reset and every cron tick during an outage would page again.
 *
 * The flag holds the ISO timestamp of the first page, purely for debugging;
 * presence is what matters. `latest_completed_at` from the heartbeat is what
 * flips it — a clean 2xx with a non-null `latest_completed_at` clears silence,
 * a "silent" verdict raises it if it isn't already set.
 */

export const SILENCE_KEY = 'silence_active'

export type SilenceStateKV = Pick<KVNamespace, 'get' | 'put' | 'delete'>

export type SilenceState = { kind: 'idle' } | { kind: 'active'; sinceIso: string }

export async function readSilenceState(kv: SilenceStateKV): Promise<SilenceState> {
	const sinceIso = await kv.get(SILENCE_KEY)
	if (!sinceIso) return { kind: 'idle' }
	return { kind: 'active', sinceIso }
}

export async function raiseSilence(kv: SilenceStateKV, at: Date): Promise<void> {
	await kv.put(SILENCE_KEY, at.toISOString())
}

export async function clearSilence(kv: SilenceStateKV): Promise<void> {
	await kv.delete(SILENCE_KEY)
}
