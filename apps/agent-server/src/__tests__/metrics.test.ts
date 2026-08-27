import { hostname } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { UNKNOWN, resolveBuildInfo } from '../lib/build-info'
import {
	METRICS_HOSTNAME,
	type ServeFn,
	buildMetricsApp,
	createMetricsRegistry,
	startMetricsServer,
} from '../lib/metrics'
import { StallTracker } from '../lib/stall-tracker'

/** Parse `name{a="1",b="2"} 1` into its label map. */
function parseLabels(line: string): Record<string, string> {
	const inner = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
	return Object.fromEntries(
		inner.split(',').map((pair) => {
			const eq = pair.indexOf('=')
			return [pair.slice(0, eq), pair.slice(eq + 1).replace(/^"|"$/g, '')]
		}),
	)
}

async function fetchMetrics(env: NodeJS.ProcessEnv): Promise<Response> {
	const app = buildMetricsApp(createMetricsRegistry(resolveBuildInfo(env)))
	return app.request('http://localhost/metrics')
}

describe('resolveBuildInfo', () => {
	it('reads commit and version from the injected build constants', () => {
		const info = resolveBuildInfo({
			MASKIN_COMMIT_SHA: 'abc123',
			MASKIN_BUILD_VERSION: '1.2.3',
		})
		expect(info.commit).toBe('abc123')
		expect(info.version).toBe('1.2.3')
	})

	it('falls back to "unknown" when git metadata is absent', () => {
		// The tarball / no-.git build path. It must degrade to a label value,
		// never to a throw — an unidentifiable build still has to boot.
		const info = resolveBuildInfo({})
		expect(info.commit).toBe(UNKNOWN)
		expect(info.version).toBe(UNKNOWN)
	})

	it('treats a blank or whitespace commit as absent', () => {
		// `git rev-parse` failing into an empty string must not produce
		// commit="" — an empty label is indistinguishable from a broken scrape.
		expect(resolveBuildInfo({ MASKIN_COMMIT_SHA: '   ' }).commit).toBe(UNKNOWN)
	})

	it('ignores an ambient commit in process.env when a source is supplied', async () => {
		// An explicit `source` is the complete truth for build identity: absent
		// means absent. The bundled constants are captured at module load, so
		// this has to re-import the module with the env already stubbed —
		// stubbing after import would prove nothing.
		//
		// Why it matters twice over: CI exporting MASKIN_COMMIT_SHA (it is in
		// turbo.json globalPassThroughEnv) would otherwise break the fallback
		// tests above, and on a box a stale .env entry could override the
		// compiled-in SHA, leaving the metric reporting a commit that is not
		// the one running — silently, and forever.
		vi.stubEnv('MASKIN_COMMIT_SHA', 'ambient-sha')
		vi.stubEnv('MASKIN_BUILD_VERSION', '9.9.9')
		vi.resetModules()
		try {
			const mod = await import('../lib/build-info')
			expect(mod.resolveBuildInfo({}).commit).toBe(mod.UNKNOWN)
			expect(mod.resolveBuildInfo({}).version).toBe(mod.UNKNOWN)
			// ...and with no source at all, the ambient value IS what a fresh
			// module load sees, since that read is the esbuild `define` target.
			expect(mod.resolveBuildInfo().commit).toBe('ambient-sha')
		} finally {
			vi.unstubAllEnvs()
			vi.resetModules()
		}
	})

	it('defaults instance and env to the same values alloy.alloy uses', () => {
		const info = resolveBuildInfo({})
		// alloy.alloy: coalesce(sys.env("DEPLOY_ENV"), "production")
		expect(info.env).toBe('production')
		// alloy.alloy: coalesce(sys.env("AGENT_SERVER_INSTANCE"), constants.hostname)
		expect(info.instance).toBe(hostname())
	})

	it('takes instance and env from the environment when set', () => {
		const info = resolveBuildInfo({ AGENT_SERVER_INSTANCE: 'agent-1', DEPLOY_ENV: 'staging' })
		expect(info.instance).toBe('agent-1')
		expect(info.env).toBe('staging')
	})
})

describe('GET /metrics', () => {
	it('serves the Prometheus 0.0.4 text format', async () => {
		const res = await fetchMetrics({ MASKIN_COMMIT_SHA: 'abc123' })
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/plain')
		expect(res.headers.get('content-type')).toContain('version=0.0.4')

		const body = await res.text()
		// A valid exposition carries HELP and TYPE for every metric family.
		expect(body).toContain('# HELP maskin_build_info')
		expect(body).toContain('# TYPE maskin_build_info gauge')
	})

	it('exposes maskin_build_info as a gauge fixed at 1 carrying the identity labels', async () => {
		const res = await fetchMetrics({
			MASKIN_COMMIT_SHA: 'abc123',
			MASKIN_BUILD_VERSION: '1.2.3',
			AGENT_SERVER_INSTANCE: 'agent-1',
			DEPLOY_ENV: 'production',
		})
		const line = (await res.text()).split('\n').find((l) => l.startsWith('maskin_build_info{'))
		expect(line).toBeDefined()

		// The value carries no information — the labels are the payload.
		expect(line?.endsWith(' 1')).toBe(true)
		expect(parseLabels(line as string)).toEqual({
			commit: 'abc123',
			version: '1.2.3',
			instance: 'agent-1',
			env: 'production',
		})
	})

	it('still exposes build info when the commit is unknown', async () => {
		const line = (await (await fetchMetrics({})).text())
			.split('\n')
			.find((l) => l.startsWith('maskin_build_info{'))
		expect(parseLabels(line as string).commit).toBe(UNKNOWN)
	})

	it('carries no unbounded label such as session_id', async () => {
		// Cardinality guard: the free-tier budget is 10k series and a per-session
		// label would consume it without bound. See the rule in lib/metrics.ts.
		expect(await (await fetchMetrics({})).text()).not.toContain('session_id')
	})

	it('does not register the default Node process collectors', async () => {
		// ~60 series of GC/heap detail nobody queries. Asserted so enabling them
		// is a deliberate decision, not an accident of a prom-client upgrade.
		expect(await (await fetchMetrics({})).text()).not.toContain('nodejs_')
	})

	it('serves nothing but /metrics', async () => {
		const app = buildMetricsApp(createMetricsRegistry(resolveBuildInfo({})))
		expect((await app.request('http://localhost/health')).status).toBe(404)
	})
})

describe('GET /metrics — stalled-session gauges', () => {
	async function fetchWithTracker(tracker: StallTracker): Promise<Response> {
		const app = buildMetricsApp(createMetricsRegistry(resolveBuildInfo({}), tracker))
		return await app.request('http://localhost/metrics')
	}

	it('exposes every arm, including the zeroes', async () => {
		// An absent series is indistinguishable from a broken scrape in PromQL,
		// and an alert on a metric that only exists while firing cannot be tested.
		const body = await (await fetchWithTracker(new StallTracker())).text()
		expect(body).toContain('maskin_sessions_stalled{reason="never_seeded"} 0')
		expect(body).toContain('maskin_sessions_stalled{reason="undelivered"} 0')
		expect(body).toContain('maskin_sessions_stalled{reason="no_output"} 0')
	})

	it('reports the count for a stalled session without naming it', async () => {
		let clock = 0
		const tracker = new StallTracker({ now: () => clock, thresholdMs: 1000 })
		tracker.trackSession('sess-abcdef0123456789', { interactive: true })
		clock = 5000

		const body = await (await fetchWithTracker(tracker)).text()
		expect(body).toContain('maskin_sessions_stalled{reason="never_seeded"} 1')
		expect(body).toContain('maskin_sessions_tracked 1')
		// The whole operational design: count in the alert, id in the logs.
		expect(body).not.toContain('sess-abcdef0123456789')
	})

	it('reports reattached sessions as unobserved rather than healthy', async () => {
		const tracker = new StallTracker()
		tracker.trackSession('survivor', { interactive: true, reattached: true })
		const body = await (await fetchWithTracker(tracker)).text()
		expect(body).toContain('maskin_sessions_unobserved 1')
		expect(body).toContain('maskin_sessions_stalled{reason="undelivered"} 0')
	})

	it('recomputes on each scrape rather than serving a cached value', async () => {
		let clock = 0
		const tracker = new StallTracker({ now: () => clock, thresholdMs: 1000 })
		tracker.trackSession('s1', { interactive: true })
		const app = buildMetricsApp(createMetricsRegistry(resolveBuildInfo({}), tracker))

		const first = await (await app.request('http://localhost/metrics')).text()
		expect(first).toContain('maskin_sessions_stalled{reason="never_seeded"} 0')
		clock = 5000
		const second = await (await app.request('http://localhost/metrics')).text()
		expect(second).toContain('maskin_sessions_stalled{reason="never_seeded"} 1')
	})

	it('omits the session gauges entirely when no tracker is wired', async () => {
		expect(await (await fetchMetrics({})).text()).not.toContain('maskin_sessions_stalled')
	})
})

describe('startMetricsServer', () => {
	/** A `serve` stand-in that records its options and hands back the 'error' hook. */
	function fakeServe() {
		const calls: Array<{ port: number; hostname: string }> = []
		let onError: ((err: Error) => void) | undefined
		let closed = 0
		const serve = ((options, onListen) => {
			calls.push({ port: options.port, hostname: options.hostname })
			onListen({ port: options.port })
			return {
				close: () => {
					closed++
				},
				on: (_event: 'error', cb: (err: Error) => void) => {
					onError = cb
				},
			}
		}) as ServeFn
		return {
			serve,
			calls,
			closed: () => closed,
			emitError: (err: Error) => onError?.(err),
		}
	}

	const buildInfo = resolveBuildInfo({ MASKIN_COMMIT_SHA: 'abc123' })

	it('binds to loopback only', () => {
		// THE security boundary for this feature: /metrics is unauthenticated and
		// the main listener is 0.0.0.0, reachable from every session microVM. A
		// one-character edit here would publish build identity and live workload
		// to agent code running inside sessions.
		const f = fakeServe()
		startMetricsServer({ port: 9464, buildInfo, serve: f.serve })
		expect(f.calls).toEqual([{ port: 9464, hostname: METRICS_HOSTNAME }])
		expect(METRICS_HOSTNAME).toBe('127.0.0.1')
	})

	it('does not listen at all when the port is 0', () => {
		const f = fakeServe()
		expect(startMetricsServer({ port: 0, buildInfo, serve: f.serve })).toBeNull()
		expect(f.calls).toEqual([])
	})

	it('survives a bind failure instead of taking the process down', () => {
		// `serve()` attaches no 'error' handler of its own, and an unhandled
		// 'error' on a net.Server is an uncaught exception -> Sentry exits ->
		// systemd Restart=always crashloops. Losing /metrics must cost a
		// dashboard panel, never the sessions running on the box.
		const f = fakeServe()
		const onError = vi.fn()
		startMetricsServer({ port: 9464, buildInfo, serve: f.serve, onError })

		const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
		expect(() => f.emitError(err)).not.toThrow()
		expect(onError).toHaveBeenCalledWith(err)
	})

	it('closes the listener on shutdown', () => {
		const f = fakeServe()
		startMetricsServer({ port: 9464, buildInfo, serve: f.serve })?.close()
		expect(f.closed()).toBe(1)
	})
})
