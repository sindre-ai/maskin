import { Hono } from 'hono'
import { Gauge, Registry } from 'prom-client'
import { type BuildInfo, resolveBuildInfo } from './build-info'
import { STALL_REASONS, type StallTracker } from './stall-tracker'

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
 * stalled-session gauges below were added exactly that way.
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

export function createMetricsRegistry(
	buildInfo: BuildInfo = resolveBuildInfo(),
	stallTracker?: StallTracker,
): MetricsRegistry {
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

	if (stallTracker) registerStallMetrics(registry, stallTracker)

	return { registry, buildInfo }
}

/**
 * Gauges for the stalled-session detector (see stall-tracker.ts).
 *
 * Collected at scrape time rather than pushed, so the value is always computed
 * against the scrape's own clock — a tracker that stopped being fed cannot
 * leave a stale non-zero count sitting on a gauge.
 *
 * `reason` is the only label and it is bounded to three compile-time constants.
 * Emphatically NO `session_id`: that is one series per session forever, and the
 * whole operational design is count-in-the-alert, id-in-the-logs. The pivot
 * from this number to the specific session is the LogQL walkthrough in
 * observability/README.md.
 */
function registerStallMetrics(registry: Registry, tracker: StallTracker): void {
	new Gauge({
		name: 'maskin_sessions_stalled',
		help: 'Live sessions with a delivered-or-missing turn and no answer, by failure arm.',
		labelNames: ['reason'] as const,
		registers: [registry],
		collect() {
			const counts = tracker.counts()
			// Every arm is set on every scrape, including the zeroes. An absent
			// series is indistinguishable from a broken scrape in PromQL, and an
			// alert on a metric that only exists while firing cannot be tested.
			for (const reason of STALL_REASONS) this.set({ reason }, counts[reason])
		},
	})

	new Gauge({
		name: 'maskin_sessions_tracked',
		help: 'Live sessions this process is tracking for stall detection.',
		registers: [registry],
		collect() {
			this.set(tracker.tracked())
		},
	})

	// The restart blind spot, made visible. Sessions reattached by
	// reconcileOnBoot have no turn history in this process, so they are excluded
	// from every stall arm — but they are NOT healthy, they are unknown, and a
	// deploy during an incident moves sessions into exactly this bucket. A
	// non-zero value here is how an operator knows the stalled count is
	// incomplete rather than reassuring.
	new Gauge({
		name: 'maskin_sessions_unobserved',
		help: 'Live sessions reattached after a restart, with no turn history — stall state unknown.',
		registers: [registry],
		collect() {
			this.set(tracker.unobserved())
		},
	})
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
