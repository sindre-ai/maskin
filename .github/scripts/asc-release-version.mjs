// Releases one App Store version of the iPhone app that Apple has approved. Run by
// asc-release-version.yml.
//
//   node asc-release-version.mjs
//
// Needs ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_PATH (same key as asc-submit-review.mjs), plus:
//   SUBMIT_VERSION  the marketing version to release, for example 1.2
//
// It acts on exactly one state: PENDING_DEVELOPER_RELEASE (approved, waiting for a click on
// Release). Any other state fails the run and nothing is changed. It prints the version and its
// state, and writes them to the run summary, before it releases. It then reads the state back and
// fails if it did not move on. It never submits, attaches a build or changes the release type.
// A release cannot be undone once the version is live. Nothing secret is printed.
//
// The token and fetch helper below are the same as in asc-set-release-type.mjs. They are copied,
// not imported, because each script is run on its own.

import { createPrivateKey, sign } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'

const BUNDLE_ID = 'io.maskin.app'
const PLATFORM = 'IOS'
const API = 'https://api.appstoreconnect.apple.com'

// The one state this script may act on. Everything else is refused, including states it does not
// know about, so a new Apple state can never be released by accident.
const RELEASABLE_STATE = 'PENDING_DEVELOPER_RELEASE'

const READBACK_ATTEMPTS = 8
const READBACK_WAIT_MS = 15000

const {
	ASC_KEY_ID,
	ASC_ISSUER_ID,
	ASC_KEY_P8_PATH,
	SUBMIT_VERSION = '',
	GITHUB_STEP_SUMMARY,
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

// Only reads are retried. A release that failed may have gone through, and the readback shows it.
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

function summary(line) {
	console.log(line)
	if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${line}\n`)
}

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
	if (res.data.length > 1) {
		fail(`Expected one App Store version ${SUBMIT_VERSION}, found ${res.data.length}.`)
	}
	return res.data[0] ?? null
}

async function main() {
	const app = await findApp()
	console.log(`App: ${app.attributes.name} (${app.attributes.bundleId}), id ${app.id}.`)

	const version = await findVersion(app.id)
	if (!version) fail(`App Store version ${SUBMIT_VERSION} does not exist.`)

	const state = stateOf(version)
	summary(`Version ${SUBMIT_VERSION} (${version.id}) is in state ${state}.`)
	if (state !== RELEASABLE_STATE) {
		fail(
			`Version ${SUBMIT_VERSION} is in state ${state}, not ${RELEASABLE_STATE}. Nothing was changed.`,
		)
	}

	summary(`Releasing version ${SUBMIT_VERSION} now. This cannot be undone once it is live.`)
	await asc('POST', '/v1/appStoreVersionReleaseRequests', {
		data: {
			type: 'appStoreVersionReleaseRequests',
			relationships: {
				appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
			},
		},
	})

	// The state can take a moment to change after the request is accepted.
	for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt++) {
		const after = await findVersion(app.id)
		if (!after) fail(`Readback: App Store version ${SUBMIT_VERSION} is gone.`)
		const afterState = stateOf(after)
		console.log(
			`Readback ${attempt}/${READBACK_ATTEMPTS}: version ${SUBMIT_VERSION}, state ${afterState}.`,
		)
		if (afterState !== RELEASABLE_STATE) {
			summary(`Released. Version ${SUBMIT_VERSION} is now in state ${afterState}.`)
			return
		}
		if (attempt < READBACK_ATTEMPTS) await sleep(READBACK_WAIT_MS)
	}
	fail(
		`Readback: version ${SUBMIT_VERSION} is still ${RELEASABLE_STATE} after the release request. Check App Store Connect. Running this again is safe: it only acts on ${RELEASABLE_STATE}.`,
	)
}

try {
	await main()
} catch (error) {
	console.error(`::error::${error.message}`)
	process.exit(1)
}
