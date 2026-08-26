import { Hono } from 'hono'
import { Gauge, Registry } from 'prom-client'
import { type BuildInfo, resolveBuildInfo } from './build-info'

/**
 * Application metrics for agent-server, in Prometheus text format.
 *
 * Scope note: this is the APPLICATION half of observability. Host resources
 * (CPU, memory, disk) come from node_exporter embedded in Alloy and never pass
 * through this process — see observability/alloy.alloy. Nothing here knows
 * about /proc.
 *
 * EXTENDING THIS: `createMetricsRegistry()` returns a registry that every new
 * metric registers against. Adding one is a single `new Gauge({ registers:
 * [registry], ... })` call inside the factory (or a small function taking the
 * registry) — no plumbing, no changes to the route or the listener. The
 * stalled-session detector that follows this will add its gauges here.
 *
 * CARDINALITY RULE: label values must be BOUNDED. No `session_id`, no image
 * tag, no user id, no error message. Those are one series each, forever, and
 * the free-tier budget is 10,000 with 887 already in use. Per-session
 * visibility comes from the logs, which carry sessionId as structured
 * metadata — see the LogQL cookbook in observability/README.md.
 *
 * Default Node/process collectors (`collectDefaultMetrics`) are deliberately
 * NOT enabled: ~60 series of GC and heap detail that nothing here is going to
 * query, on a process whose interesting state is sessions, not heap.
 */

export type MetricsRegistry = {
	registry: Registry
	buildInfo: BuildInfo
}

export function createMetricsRegistry(buildInfo: BuildInfo = resolveBuildInfo()): MetricsRegistry {
	const registry = new Registry()

	// The standard `*_build_info` pattern: a gauge pinned at 1 whose LABELS are
	// the payload. The value carries no information, which is the point — it
	// makes `maskin_build_info` joinable onto any other series by {instance},
	// and turns "what commit is running" into a label lookup rather than an
	// ssh session.
	//
	// All four labels are bounded: one value per deployed build, per host.
	new Gauge({
		name: 'maskin_build_info',
		help: 'Identity of the running agent-server build. Always 1; the labels carry the information.',
		labelNames: ['commit', 'version', 'instance', 'env'] as const,
		registers: [registry],
	}).set(
		{
			commit: buildInfo.commit,
			version: buildInfo.version,
			instance: buildInfo.instance,
			env: buildInfo.env,
		},
		1,
	)

	return { registry, buildInfo }
}

/**
 * Hono app exposing GET /metrics.
 *
 * Mounted on its own LOOPBACK-ONLY listener, not on the public one — see the
 * `startMetricsServer` call in index.ts for why.
 */
export function buildMetricsApp(metrics: MetricsRegistry): Hono {
	const app = new Hono()

	app.get('/metrics', async (c) => {
		const body = await metrics.registry.metrics()
		// Prometheus 0.0.4 text format. prom-client's contentType carries the
		// version and charset parameters the scraper expects.
		return c.text(body, 200, { 'Content-Type': metrics.registry.contentType })
	})

	return app
}
