// Sends one build of the iPhone app to App Review. Run by ios-testflight.yml after the upload.
//
//   node asc-submit-review.mjs
//
// Needs ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_PATH (same key as asc-dev-certs.mjs), plus:
//   SUBMIT_VERSION  the marketing version to submit, for example 1.2
//   BUILD_NUMBER    the build the workflow just uploaded. Empty on a manual run: the script then
//                   takes the newest processed build of that version.
//   DRY_RUN         "true" reads from App Store Connect and prints what it would do, creates nothing.
//   RELEASE_NOTES_PATH  defaults to apps/apple/release-notes.md. First line "# <version>", the
//                   what's-new text below it. A file for another version fails the step.
//
// Safe to run twice: it reuses the App Store version and an unsent review submission, and stops
// when the version is already waiting for, in or past review. Any error fails the run with
// Apple's message. The build stays in TestFlight either way. Nothing secret is printed.

import { createPrivateKey, sign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

// MANUAL: Apple approves, then a person clicks Release in App Store Connect. A wrong version bump
// then costs a click, not a public release. After one clean cycle the CTO can change this to
// 'AFTER_APPROVAL' to release as soon as Apple approves.
const RELEASE_TYPE = 'MANUAL'

const BUNDLE_ID = 'io.maskin.app'
const PLATFORM = 'IOS'
const API = 'https://api.appstoreconnect.apple.com'
const PROCESSING_CAP_MS = 45 * 60 * 1000
const POLL_MS = 60 * 1000
const WHATS_NEW_MAX = 4000

// App Store version states, by what to do. Anything not listed fails loud instead of guessing.
const EDITABLE = new Set([
	'PREPARE_FOR_SUBMISSION',
	'READY_FOR_REVIEW',
	'WAITING_FOR_EXPORT_COMPLIANCE',
	'DEVELOPER_REJECTED',
	'REJECTED',
	'METADATA_REJECTED',
	'INVALID_BINARY',
])
const ALREADY_SENT = new Set([
	'WAITING_FOR_REVIEW',
	'IN_REVIEW',
	'PENDING_APPLE_RELEASE',
	'PENDING_DEVELOPER_RELEASE',
	'PROCESSING_FOR_APP_STORE',
	'PROCESSING_FOR_DISTRIBUTION',
	'ACCEPTED',
	'READY_FOR_SALE',
	'READY_FOR_DISTRIBUTION',
])

const {
	ASC_KEY_ID,
	ASC_ISSUER_ID,
	ASC_KEY_P8_PATH,
	SUBMIT_VERSION = '',
	BUILD_NUMBER = '',
	RELEASE_NOTES_PATH = 'apps/apple/release-notes.md',
} = process.env
const DRY_RUN = process.env.DRY_RUN === 'true'

const plan = []
let problems = 0

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

// A new token per request: Apple caps a token at 20 minutes and the build wait can run for 45.
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

// Only reads are retried. A write that failed may have gone through, and the next run finds it.
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

function readReleaseNotes() {
	if (!existsSync(RELEASE_NOTES_PATH)) {
		fail(
			`${RELEASE_NOTES_PATH} is missing. Add it with "# ${SUBMIT_VERSION}" on the first line and the what's-new text below it.`,
		)
	}
	const [first = '', ...rest] = readFileSync(RELEASE_NOTES_PATH, 'utf8')
		.replace(/\r/g, '')
		.split('\n')
	const found = first.match(/^#\s+(\S+)\s*$/)?.[1]
	if (found !== SUBMIT_VERSION) {
		fail(
			`${RELEASE_NOTES_PATH} holds the notes for ${found ? `version ${found}` : 'no version'}, not ${SUBMIT_VERSION}. Replace the text, with "# ${SUBMIT_VERSION}" on the first line.`,
		)
	}
	const text = rest.join('\n').trim()
	if (!text) fail(`${RELEASE_NOTES_PATH} has a heading but no what's-new text below it.`)
	if (text.length > WHATS_NEW_MAX) {
		fail(`${RELEASE_NOTES_PATH} is ${text.length} characters, Apple allows ${WHATS_NEW_MAX}.`)
	}
	return text
}

async function findApp() {
	const res = await asc(
		'GET',
		`/v1/apps?${query({ 'filter[bundleId]': BUNDLE_ID, 'fields[apps]': 'name,bundleId,primaryLocale' })}`,
	)
	if (res.data.length !== 1) {
		fail(
			`Expected one app with bundle id ${BUNDLE_ID}, App Store Connect returned ${res.data.length}.`,
		)
	}
	return res.data[0]
}

async function listBuilds(appId) {
	const params = {
		'filter[app]': appId,
		'filter[preReleaseVersion.version]': SUBMIT_VERSION,
		'filter[preReleaseVersion.platform]': PLATFORM,
		'fields[builds]': 'version,processingState,uploadedDate,expired',
		sort: '-uploadedDate',
		limit: '20',
	}
	if (BUILD_NUMBER) params['filter[version]'] = BUILD_NUMBER
	return (await asc('GET', `/v1/builds?${query(params)}`)).data
}

const describeBuilds = (builds) =>
	builds.length
		? builds.map((b) => `${b.attributes.version} ${b.attributes.processingState}`).join(', ')
		: 'none yet'

// Waits for App Store Connect to finish processing. The upload returns before that is done, and
// the build may not even be listed for the first minutes.
async function waitForBuild(appId) {
	const deadline = Date.now() + PROCESSING_CAP_MS
	for (;;) {
		const builds = await listBuilds(appId)
		const ready = builds.find(
			(b) => b.attributes.processingState === 'VALID' && !b.attributes.expired,
		)
		if (ready) return ready
		const processing = builds.some((b) => b.attributes.processingState === 'PROCESSING')
		if (builds.length && !processing) {
			fail(`No usable build for ${SUBMIT_VERSION}. Builds seen: ${describeBuilds(builds)}.`)
		}
		if (Date.now() > deadline) {
			fail(
				`App Store Connect did not finish processing ${SUBMIT_VERSION}${BUILD_NUMBER ? ` build ${BUILD_NUMBER}` : ''} within 45 minutes. Builds seen: ${describeBuilds(builds)}.`,
			)
		}
		console.log(`Waiting for processing. Builds seen: ${describeBuilds(builds)}.`)
		await sleep(POLL_MS)
	}
}

async function findVersion(appId) {
	const res = await asc(
		'GET',
		`/v1/apps/${appId}/appStoreVersions?${query({ 'filter[platform]': PLATFORM, 'filter[versionString]': SUBMIT_VERSION })}`,
	)
	return res.data[0] ?? null
}

async function createVersion(appId) {
	const res = await asc('POST', '/v1/appStoreVersions', {
		data: {
			type: 'appStoreVersions',
			attributes: { platform: PLATFORM, versionString: SUBMIT_VERSION, releaseType: RELEASE_TYPE },
			relationships: { app: { data: { type: 'apps', id: appId } } },
		},
	})
	console.log(`Created App Store version ${SUBMIT_VERSION} (${res.data.id}).`)
	return res.data
}

async function attachBuild(versionId, buildId) {
	await asc('PATCH', `/v1/appStoreVersions/${versionId}`, {
		data: {
			type: 'appStoreVersions',
			id: versionId,
			attributes: { releaseType: RELEASE_TYPE },
			relationships: { build: { data: { type: 'builds', id: buildId } } },
		},
	})
}

async function setWhatsNew(versionId, app, text) {
	const res = await asc(
		'GET',
		`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`,
	)
	for (const loc of res.data) {
		await asc('PATCH', `/v1/appStoreVersionLocalizations/${loc.id}`, {
			data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew: text } },
		})
		console.log(`Set the what's-new text for ${loc.attributes.locale}.`)
	}
	if (res.data.length === 0) {
		const locale = app.attributes.primaryLocale
		await asc('POST', '/v1/appStoreVersionLocalizations', {
			data: {
				type: 'appStoreVersionLocalizations',
				attributes: { locale, whatsNew: text },
				relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
			},
		})
		console.log(`Created the ${locale} localization with the what's-new text.`)
	}
}

// Review submissions that are still open, with the App Store version each one carries.
async function listOpenSubmissions(appId) {
	const res = await asc(
		'GET',
		`/v1/reviewSubmissions?${query({
			'filter[app]': appId,
			'filter[platform]': PLATFORM,
			'filter[state]': 'READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES',
			limit: '50',
		})}`,
	)
	const open = []
	for (const submission of res.data) {
		const items = await asc(
			'GET',
			`/v1/reviewSubmissions/${submission.id}/items?${query({ include: 'appStoreVersion', limit: '50' })}`,
		)
		const versionIds = items.data
			.map((item) => item.relationships?.appStoreVersion?.data?.id)
			.filter(Boolean)
		open.push({
			id: submission.id,
			state: submission.attributes.state,
			versionIds,
			items: items.data,
		})
	}
	return open
}

async function submitForReview(appId, versionId, open) {
	// A draft from an earlier run that stopped half way: finish it instead of opening a second.
	const draft = open.find(
		(s) =>
			s.state === 'READY_FOR_REVIEW' && (s.versionIds.includes(versionId) || s.items.length === 0),
	)
	let submissionId = draft?.id
	if (submissionId) {
		console.log(`Reusing the unsent review submission ${submissionId}.`)
	} else {
		const created = await asc('POST', '/v1/reviewSubmissions', {
			data: {
				type: 'reviewSubmissions',
				attributes: { platform: PLATFORM },
				relationships: { app: { data: { type: 'apps', id: appId } } },
			},
		})
		submissionId = created.data.id
		console.log(`Created review submission ${submissionId}.`)
	}
	if (!draft?.versionIds.includes(versionId)) {
		await asc('POST', '/v1/reviewSubmissionItems', {
			data: {
				type: 'reviewSubmissionItems',
				relationships: {
					reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
					appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
				},
			},
		})
	}
	await asc('PATCH', `/v1/reviewSubmissions/${submissionId}`, {
		data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } },
	})
	return submissionId
}

async function main() {
	console.log(
		`${DRY_RUN ? 'DRY RUN. ' : ''}Version ${SUBMIT_VERSION}, ${BUILD_NUMBER ? `build ${BUILD_NUMBER}` : 'newest processed build'}, release type ${RELEASE_TYPE}.`,
	)

	let notes = ''
	try {
		notes = readReleaseNotes()
		console.log(`Release notes: ${notes.length} characters for ${SUBMIT_VERSION}.`)
	} catch (error) {
		if (!DRY_RUN) throw error
		problems++
		console.log(`WOULD FAIL: ${error.message}`)
	}

	const app = await findApp()
	console.log(`App: ${app.attributes.name} (${app.attributes.bundleId}), id ${app.id}.`)

	let version = await findVersion(app.id)
	if (version) {
		const state = stateOf(version)
		console.log(`App Store version ${SUBMIT_VERSION} exists (${version.id}), state ${state}.`)
		if (ALREADY_SENT.has(state)) {
			console.log(`Nothing to do: ${SUBMIT_VERSION} is already past submission (${state}).`)
			return
		}
		if (!EDITABLE.has(state)) {
			fail(
				`App Store version ${SUBMIT_VERSION} is in state ${state}, which this script does not handle.`,
			)
		}
	} else {
		console.log(`App Store version ${SUBMIT_VERSION} does not exist yet.`)
		plan.push(`create App Store version ${SUBMIT_VERSION} (release type ${RELEASE_TYPE})`)
	}

	const open = await listOpenSubmissions(app.id)
	for (const s of open) {
		console.log(`Review submission ${s.id}: ${s.state}, ${s.versionIds.length} version(s).`)
	}
	const sent =
		version && open.find((s) => s.state !== 'READY_FOR_REVIEW' && s.versionIds.includes(version.id))
	if (sent) {
		console.log(
			`Nothing to do: review submission ${sent.id} already carries ${SUBMIT_VERSION} (${sent.state}).`,
		)
		return
	}

	let build
	if (DRY_RUN) {
		const builds = await listBuilds(app.id)
		console.log(`Builds for ${SUBMIT_VERSION}: ${describeBuilds(builds)}.`)
		build = builds.find((b) => b.attributes.processingState === 'VALID' && !b.attributes.expired)
		if (!build) {
			problems++
			console.log('WOULD FAIL: no processed build for this version yet.')
		}
	} else {
		build = await waitForBuild(app.id)
	}
	if (build) {
		console.log(`Build to attach: ${build.attributes.version} (${build.id}).`)
		plan.push(`attach build ${build.attributes.version} and set the what's-new text`)
	}
	plan.push('create (or reuse) the review submission and submit it')

	if (DRY_RUN) {
		console.log('Dry run: nothing was created. It would:')
		for (const step of plan) console.log(`  - ${step}`)
		if (problems) process.exitCode = 1
		return
	}

	version ??= await createVersion(app.id)
	await attachBuild(version.id, build.id)
	console.log(`Attached build ${build.attributes.version}.`)
	await setWhatsNew(version.id, app, notes)
	const submissionId = await submitForReview(app.id, version.id, open)

	const after = await findVersion(app.id)
	const state = after ? stateOf(after) : 'unknown'
	console.log(
		`Submitted ${SUBMIT_VERSION}: review submission ${submissionId}, version state ${state}.`,
	)
	if (state !== 'WAITING_FOR_REVIEW') {
		console.log(`::warning::Expected WAITING_FOR_REVIEW, App Store Connect reports ${state}.`)
	}
}

try {
	await main()
} catch (error) {
	console.error(`::error::${error.message}`)
	process.exit(1)
}
