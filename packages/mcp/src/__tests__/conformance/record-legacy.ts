// Records the legacy fixtures from a RUNNING v1 server (SDK 1.29, before the
// swap). Run it against a checkout of v1 main, never against the swapped
// server, or the fixtures stop being the thing the swap is held to.
//
//   BASE_URL=http://localhost:3000 API_KEY=ank_... WORKSPACE_ID=... \
//     RECORDED_FROM="v1 main @ <sha> (SDK 1.29)" \
//     pnpm --filter @maskin/mcp exec tsx src/__tests__/conformance/record-legacy.ts

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolDigests } from './canonical'
import { LEGACY_CASES, type LegacyFixtureFile, type ToolsDigestFixture } from './legacy-cases'
import { runLegacyCase } from './legacy-replay'
import { legacyRequest, post, rpcResult } from './wire'

const here = dirname(fileURLToPath(import.meta.url))

function required(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is required`)
	return value
}

const target = {
	baseUrl: required('BASE_URL'),
	apiKey: required('API_KEY'),
	workspaceId: required('WORKSPACE_ID'),
	webAppOrigin: process.env.WEB_APP_ORIGIN ?? 'https://maskin.io',
}
const recordedFrom = required('RECORDED_FROM')
const recordedAt = new Date().toISOString()

const cases: LegacyFixtureFile['cases'] = []
for (const c of LEGACY_CASES) {
	cases.push({ id: c.id, response: await runLegacyCase(target, c) })
}
const transcripts: LegacyFixtureFile = { recordedFrom, recordedAt, cases }
writeFileSync(
	join(here, 'fixtures', 'legacy-v1-transcripts.json'),
	`${JSON.stringify(transcripts, null, '\t')}\n`,
)

const listing = rpcResult(await post(target, legacyRequest('tools/list')))
const digests: ToolsDigestFixture = {
	recordedFrom,
	recordedAt,
	tools: toolDigests(listing.tools as Array<{ name: string }>),
}
writeFileSync(
	join(here, 'fixtures', 'legacy-v1-tools-digest.json'),
	`${JSON.stringify(digests, null, '\t')}\n`,
)

console.log(`recorded ${cases.length} transcripts and ${digests.tools.length} tool digests`)
