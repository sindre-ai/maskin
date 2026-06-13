// T4 prototype demo, code half — drives spawn (T2-equivalent) → comment →
// stop → snapshot → drift → restore through T3's Hono boundary with a fake
// msb in place of libkrun. Verifies the bet's verdict-gating idempotency
// contract: the agent's one side-effect write survives a snapshot-restore
// round-trip without duplication, even if a "careless retry" tried to
// re-write the same idempotency key into the drifted host workspace.
//
// When Finland comes up, swap FakeMsb for MsbCliImpl and the host-side
// `sessionDir` for the bind-mount path created by apps/dev's session
// manager — the same flow re-runs against the real microsandbox runtime.

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionsLifecycleRoutes } from '../routes/sessions-lifecycle'
import type { MsbCli, MsbCreateOptions, MsbListEntry } from '../services/msb-cli'
import { SessionLifecycle } from '../services/session-lifecycle'
import { SnapshotStore } from '../services/snapshot-store'

class FakeMsb implements MsbCli {
	createCalls: MsbCreateOptions[] = []
	removeCalls: string[] = []
	async create(options: MsbCreateOptions): Promise<void> {
		this.createCalls.push(options)
	}
	async remove(name: string): Promise<void> {
		this.removeCalls.push(name)
	}
	async list(): Promise<MsbListEntry[]> {
		return []
	}
}

type SideEffect = { idempotencyKey: string; payload: string; createdAt: string }

async function appendSideEffect(sessionDir: string, entry: SideEffect): Promise<SideEffect[]> {
	const path = join(sessionDir, 'workspace/side_effects.json')
	await mkdir(join(sessionDir, 'workspace'), { recursive: true })
	let list: SideEffect[] = []
	try {
		list = JSON.parse(await readFile(path, 'utf8')) as SideEffect[]
	} catch {
		list = []
	}
	if (list.some((e) => e.idempotencyKey === entry.idempotencyKey)) return list
	list.push(entry)
	await writeFile(path, JSON.stringify(list, null, 2))
	return list
}

async function listTree(dir: string, prefix = ''): Promise<string[]> {
	const out: string[] = []
	let entries: string[] = []
	try {
		entries = await readdir(dir)
	} catch {
		return out
	}
	entries.sort()
	for (const e of entries) {
		const p = join(dir, e)
		const rel = prefix ? `${prefix}/${e}` : e
		const s = await stat(p)
		if (s.isDirectory()) out.push(...(await listTree(p, rel)))
		else out.push(`${rel} (${s.size} B)`)
	}
	return out
}

let storeRoot: string
let sessionDirRoot: string

beforeEach(async () => {
	storeRoot = await mkdtemp(join(tmpdir(), 'maskin-t4-store-'))
	sessionDirRoot = await mkdtemp(join(tmpdir(), 'maskin-t4-sessions-'))
})

afterEach(async () => {
	await rm(storeRoot, { recursive: true, force: true })
	await rm(sessionDirRoot, { recursive: true, force: true })
})

describe('T4 prototype demo — stop → snapshot → restore round-trip', () => {
	it('survives drift + duplicate retry with one side-effect entry, drift wiped, sandbox identity preserved', async () => {
		const sessionId = `demo-${Date.now()}`
		const sessionDir = join(sessionDirRoot, sessionId)
		const msb = new FakeMsb()
		const snapshots = new SnapshotStore(storeRoot)
		const lifecycle = new SessionLifecycle(msb, snapshots, {
			sessionDirRoot,
			defaultMemoryMib: 1024,
			defaultCpus: 2,
		})
		const app = new Hono()
		app.route('/sessions', createSessionsLifecycleRoutes(lifecycle))

		const timings: Record<string, number> = {}
		const time = async <T,>(step: string, fn: () => Promise<T>): Promise<T> => {
			const t0 = performance.now()
			const r = await fn()
			timings[step] = Math.round(performance.now() - t0)
			return r
		}

		// Spawn — host pre-creates the bind-mount subtree (bet constraint #3,
		// HOST_SETUP §5). T2's POST /sessions would do this over HTTP.
		await time('spawn', async () => {
			for (const sub of ['workspace', 'skills', 'learnings', 'memory']) {
				await mkdir(join(sessionDir, sub), { recursive: true })
			}
			await msb.create({
				name: sessionId,
				image: 'maskin/agent-base:latest',
				memoryMib: 1024,
				cpus: 2,
				env: { MASKIN_SESSION_ID: sessionId },
				volumes: [{ host: sessionDir, guest: '/agent' }],
			})
		})

		// Comment — the agent's only side effect, idempotency-keyed.
		const initial = await time('comment', () =>
			appendSideEffect(sessionDir, {
				idempotencyKey: 'comment-prototype-demo-1',
				payload: 'first run',
				createdAt: new Date().toISOString(),
			}),
		)
		expect(initial).toHaveLength(1)

		const preSnapshotTree = await listTree(sessionDir)

		// Stop → Snapshot
		const stop = await time('stop', async () => {
			const r = await app.request(`/sessions/${sessionId}/stop`, { method: 'POST' })
			expect(r.status).toBe(200)
			return r.json() as Promise<{ stopped: true }>
		})
		expect(stop.stopped).toBe(true)

		const snapshotResp = await time('snapshot', async () => {
			const r = await app.request(`/sessions/${sessionId}/snapshot`, { method: 'POST' })
			expect(r.status).toBe(200)
			return (await r.json()) as { snapshot: { snapshotId: string; archiveBytes: number } }
		})
		expect(snapshotResp.snapshot.archiveBytes).toBeGreaterThan(0)

		// Drift — simulate post-snapshot host-side mutation + a careless retry
		// that tries to re-append the same idempotency key. Restore must wipe
		// the drift and the retry's re-append both.
		await time('drift', async () => {
			await writeFile(join(sessionDir, 'workspace/drift.txt'), 'stale; should be wiped')
			// Bypass the in-memory dedup by direct write — this is what a
			// non-idempotent retry path would do.
			await writeFile(
				join(sessionDir, 'workspace/side_effects.json'),
				JSON.stringify(
					[
						...initial,
						{
							idempotencyKey: 'comment-prototype-demo-1',
							payload: 'careless retry',
							createdAt: new Date().toISOString(),
						},
					],
					null,
					2,
				),
			)
		})

		// Quiescence window — matches the shape of yesterday's local run.
		await new Promise((r) => setTimeout(r, 250))
		timings.wait = 250

		// Restore
		const restoreResp = await time('restore', async () => {
			const r = await app.request(`/sessions/${sessionId}/restore`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					image: 'maskin/agent-base:latest',
					env: { MASKIN_SESSION_ID: sessionId },
				}),
			})
			expect(r.status).toBe(200)
			return (await r.json()) as { sandboxName: string; sessionDir: string }
		})

		const postRestoreTree = await listTree(sessionDir)
		const finalSideEffects = JSON.parse(
			await readFile(join(sessionDir, 'workspace/side_effects.json'), 'utf8'),
		) as SideEffect[]

		// Contracts — the three that gate the bet's verdict.
		expect(restoreResp.sandboxName, 'sandbox name preserved across restore').toBe(sessionId)
		expect(
			postRestoreTree.some((p) => p.startsWith('workspace/drift.txt')),
			'drift wiped by restore',
		).toBe(false)
		expect(finalSideEffects, 'no double-write on idempotent retry').toHaveLength(1)
		expect(finalSideEffects[0]?.payload).toBe('first run')
		expect(msb.removeCalls).toContain(sessionId)
		expect(msb.createCalls.at(-1)?.name).toBe(sessionId)

		// Verdict report — printed for the verifier to copy into the bet comment.
		const report = {
			pass: true,
			sessionId,
			timings_ms: timings,
			archive_bytes: snapshotResp.snapshot.archiveBytes,
			snapshot_id: snapshotResp.snapshot.snapshotId,
			pre_snapshot_tree: preSnapshotTree,
			post_restore_tree: postRestoreTree,
			side_effects_after_restore: finalSideEffects.length,
			msb_create_calls: msb.createCalls.length,
			msb_remove_calls: msb.removeCalls.length,
			contracts: {
				sandbox_name_preserved: true,
				drift_wiped_by_restore: true,
				no_double_write_on_retry: true,
			},
		}
		process.stdout.write(`\nT4 PROTOTYPE DEMO VERDICT REPORT\n${JSON.stringify(report, null, 2)}\n`)
	})
})
