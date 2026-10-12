// Dump the OpenAPI 3.1 document to a file for native-client SDK generation.
// Needs no DB, S3 or Docker — see `buildOpenAPIDocument()`.
//
// Run:
//   pnpm --filter @maskin/dev exec tsx scripts/dump-openapi.ts [outfile]
//
// Default outfile is apps/apple/openapi.json. The Apple CI job re-runs this
// and fails on a diff, so a route/schema change can't ship without the
// snapshot (and therefore the generated Swift client) being updated.
//
// The snapshot is the served spec plus ONE codegen normalization, below.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { buildOpenAPIDocument } from '../src/openapi'

const JSON_MEMBER_TYPES = new Set(['string', 'number', 'boolean', 'null', 'object', 'array'])

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function isRecord(node: Json | undefined): node is { [key: string]: Json } {
	return typeof node === 'object' && node !== null && !Array.isArray(node)
}

/**
 * `anyOf` of JSON primitives incl. `{ type: 'null' }` — what `safeJsonValue` / `safeMetadataSchema`
 * produce — meaning "any JSON value".
 *
 * swift-openapi-generator emits `value4: …Value4Payload?` for the bare-`null` member but never
 * declares that type, so the generated client doesn't compile (observed on generator 1.13: every
 * `metadata` / `settings` / `data` field in the document). A free-form `{}` says the same thing
 * and is generated as `OpenAPIValueContainer`. `$ref` members are excluded on purpose: a union
 * over named schemas is real structure and must be left alone.
 */
function isJsonValueUnion(node: Json | undefined): boolean {
	if (!isRecord(node) || !Array.isArray(node.anyOf)) return false
	const members = node.anyOf
	const allPlain = members.every(
		(m) =>
			isRecord(m) && !('$ref' in m) && typeof m.type === 'string' && JSON_MEMBER_TYPES.has(m.type),
	)
	return allPlain && members.some((m) => isRecord(m) && m.type === 'null')
}

function normalizeForCodegen(node: Json, counter: { replaced: number }): Json {
	if (Array.isArray(node)) return node.map((item) => normalizeForCodegen(item, counter))
	if (!isRecord(node)) return node
	const out: { [key: string]: Json } = {}
	for (const [key, value] of Object.entries(node)) {
		if (isJsonValueUnion(value)) {
			counter.replaced++
			out[key] = {}
		} else {
			out[key] = normalizeForCodegen(value, counter)
		}
	}
	return out
}

const out = resolve(process.argv[2] ?? '../apple/openapi.json')
const counter = { replaced: 0 }
const doc = normalizeForCodegen(buildOpenAPIDocument() as Json, counter)

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(doc, null, '\t')}\n`)
console.log(`Wrote ${out} (${counter.replaced} JSON-value unions normalized)`)
