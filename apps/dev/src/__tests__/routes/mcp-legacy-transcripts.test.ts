import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	type LegacyTranscript,
	type LegacyWireServer,
	loadLegacyTranscripts,
	sendRecordedRequest,
	startLegacyWireServer,
} from '../mcp-legacy-harness'

// Replays the transcripts recorded from the legacy (SDK v1) /mcp route against
// the route as it is now, with no mocks between the request and the SDK's
// reply. Status, content-type and body must match what v1 sent, byte for byte.
// They are the baseline for the SDK swap, so a diff here is either a
// regression or a decision to make in the PR that causes it: it is never
// fixed by re-recording from the swapped server.
//
// Fixtures: packages/mcp/src/__tests__/fixtures/legacy-v1/ (see its README).

const transcripts = loadLegacyTranscripts()

describe('legacy /mcp transcripts', () => {
	let server: LegacyWireServer

	beforeAll(async () => {
		server = await startLegacyWireServer()
	})

	afterAll(async () => {
		await server.close()
	})

	it('covers every request kind the swap must keep serving', () => {
		const names = transcripts.map((t) => t.name)
		for (const required of [
			'initialize',
			'tools-list',
			'tools-call-ok',
			'notification',
			'batch-array',
			'get',
			'delete',
			'malformed-json',
		]) {
			expect(names).toContain(required)
		}
	})

	it.each(transcripts.map((t): [string, LegacyTranscript] => [t.name, t]))(
		'replays %s with the recorded status, content-type and body',
		async (_name, transcript) => {
			const actual = await sendRecordedRequest(server.url, transcript.request)

			expect(actual).toEqual(transcript.response)
		},
	)
})
