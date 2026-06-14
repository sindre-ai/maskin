// T4 prototype demo, code half — drives the merged bet branch's actual
// `buildApp()` for the spawn path (T2's `POST /sessions`, bearer-auth-gated
// by T7) plus the T3 lifecycle routes for `stop`/`snapshot`/`restore`,
// against an in-process fake `msb`. Verifies the bet's verdict-gating
// idempotency contract:
//
//   1. sandbox name preserved across restore (sandboxName === sessionId)
//   2. drift wiped — post-restore tree matches pre-snapshot tree
//   3. no double-write — careless retry that writes a duplicate idempotency
//      key into the drifted host workspace is dropped on restore
//
// When Finland is up, swap the fake `CommandRunner` for the real msb v0.5.4
// binary and the same flow re-runs against libkrun. The harness already
// drives the production buildApp() + lifecycle routes so the swap point is
// the runner injection on AppDeps.msb, not the test scaffolding.

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../index'
import { createSessionsLifecycleRoutes } from '../routes/sessions-lifecycle'
import type { CommandRunner } from '../services/microsandbox'
import type { MsbCli, MsbCreateOptions, MsbListEntry } from '../services/msb-cli'
import { SessionLifecycle } from '../services/session-lifecycle'
import { SnapshotStore } from '../services/snapshot-store'

const AGENT_SERVER_SECRET = 'demo-secret-for-prototype-1234'
const SANDBOX_IMAGE = 'maskin/agent-base:latest'
const MSB_VERSION = '0.5.4'

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

// `msb` shim for the T2 spawn path. Real msb on Finland is a CLI; the
// production code shells out via execFile. Tests inject a CommandRunner
// that mirrors the v0.5.4 surface buildMsbCreateArgs() drives.
function createFakeRunner(): { runner: CommandRunner; createdSandboxes: string[] } {
	const createdSandboxes: string[] = []
	const runner: CommandRunner = async (_bin, args) => {
		const a = [...args]
		if (a[0] === '--version') return { stdout: `microsandbox ${MSB_VERSION}\n`, stderr: '' }
		if (a[0] === 'create') {
			const nameIdx = a.indexOf('--name')
			const name = nameIdx >= 0 ? a[nameIdx + 1] : undefined
			if (name) createdSandboxes.push(name)
			return { stdout: '', stderr: '' }
		}
		if (a[0] === 'list') {
			const rows = createdSandboxes.map((name) => ({ name, status: 'Running' }))
			return { stdout: JSON.stringify(rows), stderr: '' }
		}
		if (a[0] === 'remove') return { stdout: '', stderr: '' }
		return { stdout: '', stderr: '' }
	}
	return { runner, createdSandboxes }
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

describe('T4 prototype demo — POST /sessions → stop → snapshot → restore', () => {
	it('drives merged buildApp() + lifecycle routes with bearer auth; survives drift + duplicate retry', async () => {
		const sessionId = `demo-${Date.now()}`
		const sessionDir = join(sessionDirRoot, sessionId)

		// Production app — same buildApp() that boots on Finland, with a fake
		// CommandRunner standing in for msb v0.5.4 on the box.
		const { runner } = createFakeRunner()
		const app = buildApp({
			env: {
				PORT: 3001,
				AGENT_SERVER_SECRET,
				MSB_BIN: '/fake/msb',
				AGENT_SESSION_ROOT: sessionDirRoot,
				S3_REGION: 'us-east-1',
			} as never,
			storage: null,
			msb: { msbBin: '/fake/msb', run: runner, sleep: async () => {}, now: Date.now },
		})

		// Gap surfaced in this session: the merged buildApp() does NOT mount
		// T3's lifecycle routes. The harness mounts them itself on the same
		// app so the demo can drive the real production code paths end-to-end.
		// See verdict report — this is a follow-up task for whoever wires T2
		// + T3 together into the agent-server entry point.
		const msb = new FakeMsb()
		const snapshots = new SnapshotStore(storeRoot)
		const lifecycle = new SessionLifecycle(msb, snapshots, {
			sessionDirRoot,
			defaultMemoryMib: 1024,
			defaultCpus: 2,
		})
		app.route('/sessions', createSessionsLifecycleRoutes(lifecycle))

		const timings: Record<string, number> = {}
		const time = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
			const t0 = performance.now()
			const r = await fn()
			timings[step] = Math.round(performance.now() - t0)
			return r
		}

		const authHeader = `Bearer ${AGENT_SERVER_SECRET}`

		// /health — `ok` tracks msb liveness via the injected runner.
		const health = await app.request('/health')
		expect(health.status).toBe(200)
		const healthBody = (await health.json()) as { ok: boolean; msb_version: string }
		expect(healthBody).toMatchObject({ ok: true, msb_version: MSB_VERSION })

		// Auth gate — sessions endpoints reject unauthenticated requests.
		const noAuth = await app.request('/sessions', { method: 'POST' })
		expect(noAuth.status).toBe(401)

		// Spawn via T2 POST /sessions (bearer-gated).
		const spawn = await time('spawn', async () => {
			const r = await app.request('/sessions', {
				method: 'POST',
				headers: { authorization: authHeader, 'content-type': 'application/json' },
				body: JSON.stringify({
					sessionId,
					image: SANDBOX_IMAGE,
					env: { MASKIN_SESSION_ID: sessionId },
				}),
			})
			expect(r.status).toBe(201)
			return (await r.json()) as { sandboxName: string; connection: { host: string; port: number } }
		})
		expect(spawn.sandboxName).toBe(sessionId)
		expect(spawn.connection.port).toBe(3001)

		// Comment — the agent's one side effect, idempotency-keyed. Real
		// agents write to /agent inside the microVM; the host sees it through
		// the bind mount, so this test writes directly into sessionDir.
		const initial = await time('comment', () =>
			appendSideEffect(sessionDir, {
				idempotencyKey: 'comment-prototype-demo-1',
				payload: 'first run',
				createdAt: new Date().toISOString(),
			}),
		)
		expect(initial).toHaveLength(1)

		const preSnapshotTree = await listTree(sessionDir)

		// Stop → Snapshot via T3 lifecycle routes (also bearer-gated because
		// the auth middleware in buildApp is mounted on `/sessions/*`).
		const stop = await time('stop', async () => {
			const r = await app.request(`/sessions/${sessionId}/stop`, {
				method: 'POST',
				headers: { authorization: authHeader },
			})
			expect(r.status).toBe(200)
			return r.json() as Promise<{ stopped: true }>
		})
		expect(stop.stopped).toBe(true)

		const snapshotResp = await time('snapshot', async () => {
			const r = await app.request(`/sessions/${sessionId}/snapshot`, {
				method: 'POST',
				headers: { authorization: authHeader },
			})
			expect(r.status).toBe(200)
			return (await r.json()) as { snapshot: { snapshotId: string; archiveBytes: number } }
		})
		expect(snapshotResp.snapshot.archiveBytes).toBeGreaterThan(0)

		// Drift — post-snapshot host-side mutation + a careless retry that
		// re-appends the same idempotency key. Restore must wipe both.
		await time('drift', async () => {
			await writeFile(join(sessionDir, 'workspace/drift.txt'), 'stale; should be wiped')
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

		await new Promise((r) => setTimeout(r, 250))
		timings.wait = 250

		const restoreResp = await time('restore', async () => {
			const r = await app.request(`/sessions/${sessionId}/restore`, {
				method: 'POST',
				headers: { authorization: authHeader, 'content-type': 'application/json' },
				body: JSON.stringify({
					image: SANDBOX_IMAGE,
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

		const report = {
			pass: true,
			sessionId,
			msb_version: healthBody.msb_version,
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
				bearer_auth_enforced: true,
			},
		}
		process.stdout.write(`\nT4 PROTOTYPE DEMO VERDICT REPORT\n${JSON.stringify(report, null, 2)}\n`)
	})
})
