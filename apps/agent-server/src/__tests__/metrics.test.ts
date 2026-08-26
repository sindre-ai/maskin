import { hostname } from 'node:os'
import { describe, expect, it } from 'vitest'
import { UNKNOWN, resolveBuildInfo } from '../lib/build-info'
import { buildMetricsApp, createMetricsRegistry } from '../lib/metrics'

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

	it('defaults instance and env to the same values alloy.alloy uses', () => {
		const info = resolveBuildInfo({})
		// alloy.alloy: coalesce(sys.env("DEPLOY_ENV"), "production")
		expect(info.env).toBe('production')
		// alloy.alloy: coalesce(sys.env("AGENT_SERVER_INSTANCE"), constants.hostname)
		expect(info.instance).toBe(hostname())
	})

	it('takes instance and env from the environment when set', () => {
		const info = resolveBuildInfo({ AGENT_SERVER_INSTANCE: 'finland-1', DEPLOY_ENV: 'staging' })
		expect(info.instance).toBe('finland-1')
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
			AGENT_SERVER_INSTANCE: 'finland-1',
			DEPLOY_ENV: 'production',
		})
		const line = (await res.text()).split('\n').find((l) => l.startsWith('maskin_build_info{'))
		expect(line).toBeDefined()

		// The value carries no information — the labels are the payload.
		expect(line?.endsWith(' 1')).toBe(true)
		expect(parseLabels(line as string)).toEqual({
			commit: 'abc123',
			version: '1.2.3',
			instance: 'finland-1',
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
