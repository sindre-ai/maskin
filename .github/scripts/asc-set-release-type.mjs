// Changes how one App Store version of the iPhone app is released. Run by asc-set-release-type.yml.
//
//   node asc-set-release-type.mjs
//
// Needs ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_PATH (same key as asc-submit-review.mjs), plus:
//   SUBMIT_VERSION  the marketing version to change, for example 1.1
//   RELEASE_TYPE    AFTER_APPROVAL (goes live as soon as Apple approves) or MANUAL (waits for a
//                   click on Release). Defaults to AFTER_APPROVAL.
//
// It reads the version, sets the release type, reads it back and prints it. It never submits,
// attaches a build or releases anything. A version that Apple has already approved is left alone
// and the run fails, so this can never be the thing that puts a version live.
// To undo: run it again with RELEASE_TYPE MANUAL. Nothing secret is printed.
//
// The token and fetch helper below are the same as in asc-submit-review.mjs. They are copied, not
// imported, because that file starts a submission as soon as it is loaded.

import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const BUNDLE_ID = 'io.maskin.app'
const PLATFORM = 'IOS'
const API = 'https://api.appstoreconnect.apple.com'
const RELEASE_TYPES = new Set(['AFTER_APPROVAL', 'MANUAL'])

// Versions Apple has approved or is already releasing. Changing the release type here could put
// the version live, or does nothing useful, so the script stops instead.
const APPROVED = new Set([
	'PENDING_APPLE_RELEASE',
	'PENDING_DEVELOPER_RELEASE',
	'PROCESSING_FOR_APP_STORE',
	'PROCESSING_FOR_DISTRIBUTION',
	'ACCEPTED',
	'READY_FOR_SALE',
	'READY_FOR_DISTRIBUTION',
	'REPLACED_WITH_NEW_VERSION',
	'REMOVED_FROM_SALE',
])

const {
	ASC_KEY_ID,
	ASC_ISSUER_ID,
	ASC_KEY_P8_PATH,
	SUBMIT_VERSION = '',
	RELEASE_TYPE = 'AFTER_APPROVAL',
} = process.env

function fail(message) {
	throw new Error(message)
}

if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_P8_PATH) {
	fail('ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_PATH must be set.')
}
if (!/^\d+(\.\d+){1,2}$/.test(SUBMIT_VERSION)) {
	fail(`SUBMIT_VERSION must look like 1.2 or 1.2.1, got "${SUBMIT_VERSION}".`)
}
if (!RELEASE_TYPES.has(RELEASE_TYPE)) {
	fail(`RELEASE_TYPE must be AFTER_APPROVAL or MANUAL, got "${RELEASE_TYPE}".`)
}

const b64url = (v) => Buffer.from(v).toString('base64url')
const privateKey = createPrivateKey(readFileSync(ASC_KEY_P8_PATH, 'utf8'))

function authToken() {
	const now = Math.floor(Date.now() / 1000)
	const header = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }
	const claims = { iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }
	const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
	const signature = sign('sha256', Buffer.from(signingInput), {
		key: privateKey,
		dsaEncoding: 'ieee-p1363',
	})
	return `${signingInput}.${b64url(signature)}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Only reads are retried. A write that failed may have gone through, and the readback shows it.
async function asc(method, path, body) {
	for (let attempt = 1; ; attempt++) {
		const headers = { Authorization: `Bearer ${authToken()}` }
		if (body) headers['Content-Type'] = 'application/json'
		const res = await fetch(API + path, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		})
		const text = await res.text()
		if (res.ok) return text ? JSON.parse(text) : {}
		if (method === 'GET' && (res.status === 429 || res.status >= 500) && attempt < 4) {
			await sleep(attempt * 5000)
			continue
		}
		fail(`${method} ${path} -> ${res.status}: ${text}`)
	}
}

const query = (params) => new URLSearchParams(params).toString()
const stateOf = (version) => version.attributes.appVersionState ?? version.attributes.appStoreState

async function findApp() {
	const res = await asc(
		'GET',
		`/v1/apps?${query({ 'filter[bundleId]': BUNDLE_ID, 'fields[apps]': 'name,bundleId' })}`,
	)
	if (res.data.length !== 1) {
		fail(
			`Expected one app with bundle id ${BUNDLE_ID}, App Store Connect returned ${res.data.length}.`,
		)
	}
	return res.data[0]
}

async function findVersion(appId) {
	const res = await asc(
		'GET',
		`/v1/apps/${appId}/appStoreVersions?${query({
			'filter[platform]': PLATFORM,
			'filter[versionString]': SUBMIT_VERSION,
			'fields[appStoreVersions]': 'versionString,releaseType,appStoreState,appVersionState',
		})}`,
	)
	return res.data[0] ?? null
}

const describe = (version) =>
	`state ${stateOf(version)}, release type ${version.attributes.releaseType}`

async function main() {
	const app = await findApp()
	console.log(`App: ${app.attributes.name} (${app.attributes.bundleId}), id ${app.id}.`)

	const version = await findVersion(app.id)
	if (!version) fail(`App Store version ${SUBMIT_VERSION} does not exist.`)
	console.log(`App Store version ${SUBMIT_VERSION} (${version.id}): ${describe(version)}.`)

	const state = stateOf(version)
	if (APPROVED.has(state)) {
		fail(
			`Version ${SUBMIT_VERSION} is already approved or released (${state}). Nothing was changed.`,
		)
	}

	if (version.attributes.releaseType === RELEASE_TYPE) {
		console.log(`Release type is already ${RELEASE_TYPE}. Nothing to change.`)
	} else {
		console.log(`Setting release type ${version.attributes.releaseType} -> ${RELEASE_TYPE}.`)
		await asc('PATCH', `/v1/appStoreVersions/${version.id}`, {
			data: {
				type: 'appStoreVersions',
				id: version.id,
				attributes: { releaseType: RELEASE_TYPE },
			},
		})
	}

	const after = await findVersion(app.id)
	if (!after) fail(`Readback: App Store version ${SUBMIT_VERSION} is gone.`)
	console.log(`Readback: version ${SUBMIT_VERSION}, ${describe(after)}.`)
	if (after.attributes.releaseType !== RELEASE_TYPE) {
		fail(`Readback shows ${after.attributes.releaseType}, expected ${RELEASE_TYPE}.`)
	}
}

try {
	await main()
} catch (error) {
	console.error(`::error::${error.message}`)
	process.exit(1)
}
