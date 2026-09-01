import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compress } from 'snappyjs'
import { encodeWriteRequest } from './remote-write'
import { type RunReport, metrics } from './report'

/**
 * Ship the last run to a Prometheus remote_write endpoint.
 *
 * remote_write is the reason this is not a Grafana lock-in. It is a public
 * protocol: the same body, the same headers, and one changed URL sends these
 * series to Mimir, Thanos, VictoriaMetrics, or a self-hosted Prometheus with
 * `--web.enable-remote-write-receiver`. Nothing about the eval cases, the
 * grader, or the metric definitions is aware of who is receiving them.
 */
async function main(): Promise<void> {
	const url = process.env.PROM_REMOTE_WRITE_URL
	if (!url) {
		// Not an error, and deliberately so. Fork PRs get no secrets, and a
		// developer running the suite locally has no endpoint. A run that graded
		// correctly must not report failure because nobody was listening.
		console.log('PROM_REMOTE_WRITE_URL is not set - skipping metrics push.')
		return
	}

	const path = join(process.cwd(), 'results', 'mcp-tools.json')
	const report = JSON.parse(await readFile(path, 'utf8')) as RunReport

	// Stamped with the run's own start time, not now(): pushing the same file
	// twice then writes the same samples at the same offsets rather than
	// smearing one run across the timeline as if it were two.
	// Copied into a fresh Uint8Array because snappyjs types its return as backed
	// by ArrayBufferLike, which BodyInit does not accept (it could be a
	// SharedArrayBuffer). The copy is a few KB and happens once per run.
	const compressed = compress(encodeWriteRequest(metrics(report), report.startedAt * 1000))
	const body = new Uint8Array(compressed)

	const headers: Record<string, string> = {
		'Content-Type': 'application/x-protobuf',
		'Content-Encoding': 'snappy',
		'X-Prometheus-Remote-Write-Version': '0.1.0',
	}
	const user = process.env.PROM_USERNAME
	const password = process.env.PROM_PASSWORD
	if (user && password) {
		headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
	}

	const res = await fetch(url, { method: 'POST', headers, body })
	if (!res.ok) {
		throw new Error(`remote_write returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
	}
	console.log(`Pushed ${metrics(report).length} samples to ${new URL(url).host}.`)
}

main().catch((error) => {
	// Logged, never fatal. An outage at the metrics endpoint, an expired
	// credential, or a network blip must not turn a green eval run red - the
	// same posture the Argos upload takes in the verify-e2e job.
	console.error(
		`Metrics push failed (continuing): ${error instanceof Error ? error.message : error}`,
	)
})
