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
//
// Retries: a failure that may pass on another try (network, an Apple server error, a rate limit)
// is run again after a pause, 3 attempts in all. A failure another try cannot fix (a bad store
// listing, missing release notes, an app or build that cannot be picked) stops at once. When the
// run still fails it ends red, with one line in the run summary naming the version and the reason.
// Exit code: 0 done, 1 gave up after retries, 2 stopped without retrying.

import { createPrivateKey, sign } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

// AFTER_APPROVAL: the version goes to customers as soon as Apple approves it, with no one pressing
// Release. The version number is a deliberate edit of MARKETING_VERSION, so a bump is the decision
// to ship. To hold releases for a click again, change this to 'MANUAL'.
const RELEASE_TYPE = 'AFTER_APPROVAL'

const BUNDLE_ID = 'io.maskin.app'
const PLATFORM = 'IOS'
const API = 'https://api.appstoreconnect.apple.com'
const PROCESSING_CAP_MS = 45 * 60 * 1000
const POLL_MS = 60 * 1000
const WHATS_NEW_MAX = 4000
const MAX_ATTEMPTS = 3
const RETRY_PAUSE_MS = Number(process.env.RETRY_PAUSE_MS) || 3 * 60 * 1000

// Store listing fields Apple refuses to submit without. The what's-new text is not listed: this
// script sets it from release-notes.md. Add a name here when Apple rejects a submit for another one.
const APP_INFO_FIELDS = ['name', 'privacyPolicyUrl', 'privacyPolicyText']
const VERSION_FIELDS = ['description', 'keywords', 'supportUrl']
const VERSION_ATTRIBUTES = ['copyright']

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
	GITHUB_STEP_SUMMARY = '',
} = process.env
const DRY_RUN = process.env.DRY_RUN === 'true'

const plan = []
const problems = []

// retryable false: running it again cannot help, so the workflow stops at once (exit code 2).
function fail(message, { retryable = true } = {}) {
	throw Object.assign(new Error(message), { retryable })
}

const b64url = (v) => Buffer.from(v).toString('base64url')
const privateKey = ASC_KEY_P8_PATH ? createPrivateKey(readFileSync(ASC_KEY_P8_PATH, 'utf8')) : null

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

// A 4xx from Apple means the request itself is wrong (bad field, wrong state), so another try
// gets the same answer. Rate limits (429), timeouts (408) and server errors (5xx) can pass later.
// A 409 is retried unless Apple says an entity is invalid (ENTITY_ERROR), which is a listing problem.
function retryableStatus(status, text) {
	if (status === 408 || status === 429 || status >= 500) return true
	if (status === 409) return !text.includes('ENTITY_ERROR')
	return false
}

// Only reads are retried here. A write that failed may have gone through, and the next run finds it.
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
		fail(`${method} ${path} -> ${res.status}: ${text}`, {
			retryable: retryableStatus(res.status, text),
		})
	}
}

const query = (params) => new URLSearchParams(params).toString()
const stateOf = (version) => version.attributes.appVersionState ?? version.attributes.appStoreState

function readReleaseNotes() {
	if (!existsSync(RELEASE_NOTES_PATH)) {
		fail(
			`${RELEASE_NOTES_PATH} is missing. Add it with "# ${SUBMIT_VERSION}" on the first line and the what's-new text below it.`,
			{ retryable: false },
		)
	}
	const [first = '', ...rest] = readFileSync(RELEASE_NOTES_PATH, 'utf8')
		.replace(/\r/g, '')
		.split('\n')
	const found = first.match(/^#\s+(\S+)\s*$/)?.[1]
	if (found !== SUBMIT_VERSION) {
		fail(
			`${RELEASE_NOTES_PATH} holds the notes for ${found ? `version ${found}` : 'no version'}, not ${SUBMIT_VERSION}. Replace the text, with "# ${SUBMIT_VERSION}" on the first line.`,
			{ retryable: false },
		)
	}
	const text = rest.join('\n').trim()
	if (!text) {
		fail(`${RELEASE_NOTES_PATH} has a heading but no what's-new text below it.`, {
			retryable: false,
		})
	}
	if (text.length > WHATS_NEW_MAX) {
		fail(`${RELEASE_NOTES_PATH} is ${text.length} characters, Apple allows ${WHATS_NEW_MAX}.`, {
			retryable: false,
		})
	}
	return text
}

async function findApp() {
	const res = await asc(
		'GET',
		`/v1/apps?${query({ 'filter[bundleId]': BUNDLE_ID, 'fields[apps]': 'name,bundleId,primaryLocale' })}`,
	)
	// The bundle id filter can also return apps whose id merely contains ours, so keep exact matches.
	const matches = res.data.filter((app) => app.attributes.bundleId === BUNDLE_ID)
	if (matches.length === 1) return matches[0]
	if (matches.length === 0) {
		fail(`No app with bundle id ${BUNDLE_ID}, App Store Connect returned ${res.data.length}.`, {
			retryable: false,
		})
	}
	// Still several: take the one that has an iPhone App Store version, since this script only
	// sends iPhone builds. A record that exists only for another platform has none.
	const withIosVersion = []
	for (const app of matches) {
		const versions = await asc(
			'GET',
			`/v1/apps/${app.id}/appStoreVersions?${query({ 'filter[platform]': PLATFORM, limit: '1' })}`,
		)
		if (versions.data.length > 0) withIosVersion.push(app)
	}
	if (withIosVersion.length === 1) {
		const others = matches.filter((app) => app !== withIosVersion[0]).map(describeApp)
		console.log(
			`${matches.length} apps share bundle id ${BUNDLE_ID}. Using the one with an ${PLATFORM} App Store version; ignoring ${others.join(', ')}.`,
		)
		return withIosVersion[0]
	}
	fail(
		`${matches.length} apps share bundle id ${BUNDLE_ID} and ${withIosVersion.length} of them have an ${PLATFORM} App Store version, so the app cannot be told apart. Apps: ${matches.map(describeApp).join(', ')}.`,
		{ retryable: false },
	)
}

const describeApp = (app) => `${app.attributes.name} (id ${app.id})`

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
			fail(`No usable build for ${SUBMIT_VERSION}. Builds seen: ${describeBuilds(builds)}.`, {
				retryable: false,
			})
		}
		if (Date.now() > deadline) {
			// A retry would wait another 45 minutes for a build that is not there. A person looks.
			fail(
				`App Store Connect did not finish processing ${SUBMIT_VERSION}${BUILD_NUMBER ? ` build ${BUILD_NUMBER}` : ''} within 45 minutes. Builds seen: ${describeBuilds(builds)}.`,
				{ retryable: false },
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

const isEmpty = (value) => !String(value ?? '').trim()

// Names of required listing fields that are empty, for example "app info en-US privacyPolicyText".
// Reads the pending app info (the one still open for edits) and, when the App Store version
// exists, its text fields. A version that does not exist yet is created without checks here.
async function emptyListingFields(appId, version) {
	const empty = []
	const infos = await asc('GET', `/v1/apps/${appId}/appInfos?limit=10`)
	const pending = infos.data.filter((info) =>
		EDITABLE.has(info.attributes.state ?? info.attributes.appStoreState),
	)
	if (pending.length === 0) console.log('No pending app info to check.')
	for (const info of pending) {
		const locs = await asc('GET', `/v1/appInfos/${info.id}/appInfoLocalizations?limit=200`)
		for (const loc of locs.data) {
			for (const field of APP_INFO_FIELDS) {
				if (isEmpty(loc.attributes[field])) empty.push(`app info ${loc.attributes.locale} ${field}`)
			}
		}
	}
	if (version) {
		for (const field of VERSION_ATTRIBUTES) {
			if (isEmpty(version.attributes[field])) empty.push(`version ${SUBMIT_VERSION} ${field}`)
		}
		const locs = await asc(
			'GET',
			`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`,
		)
		for (const loc of locs.data) {
			for (const field of VERSION_FIELDS) {
				if (isEmpty(loc.attributes[field])) empty.push(`version ${loc.attributes.locale} ${field}`)
			}
		}
	}
	return empty
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
	// A retry starts clean: main runs again from the top.
	plan.length = 0
	problems.length = 0
	if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_P8_PATH) {
		fail('ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8_PATH must be set.', { retryable: false })
	}
	if (!/^\d+(\.\d+){1,2}$/.test(SUBMIT_VERSION)) {
		fail(`SUBMIT_VERSION must look like 1.2 or 1.2.1, got "${SUBMIT_VERSION}".`, {
			retryable: false,
		})
	}
	console.log(
		`${DRY_RUN ? 'DRY RUN. ' : ''}Version ${SUBMIT_VERSION}, ${BUILD_NUMBER ? `build ${BUILD_NUMBER}` : 'newest processed build'}, release type ${RELEASE_TYPE}.`,
	)

	let notes = ''
	try {
		notes = readReleaseNotes()
		console.log(`Release notes: ${notes.length} characters for ${SUBMIT_VERSION}.`)
	} catch (error) {
		if (!DRY_RUN) throw error
		problems.push(error.message)
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
				{ retryable: false },
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

	// Before the build wait, so a bad listing fails in a minute and not after 45.
	const empty = await emptyListingFields(app.id, version)
	if (empty.length) {
		const message = `The store listing has empty required fields: ${empty.join(', ')}. Fill them in App Store Connect, then run the workflow again with submit_version ${SUBMIT_VERSION}.`
		if (!DRY_RUN) fail(message, { retryable: false })
		problems.push(message)
		console.log(`WOULD FAIL: ${message}`)
	} else {
		console.log('Store listing: all required fields are filled in.')
	}

	let build
	if (DRY_RUN) {
		const builds = await listBuilds(app.id)
		console.log(`Builds for ${SUBMIT_VERSION}: ${describeBuilds(builds)}.`)
		build = builds.find((b) => b.attributes.processingState === 'VALID' && !b.attributes.expired)
		if (!build) {
			problems.push(`no processed build for ${SUBMIT_VERSION} yet`)
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
		if (problems.length)
			fail(`Dry run found ${problems.length} problem(s): ${problems.join(' ')}`, {
				retryable: false,
			})
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

// Runs main again after a failure that may pass on another try, up to MAX_ATTEMPTS in all with a
// pause between. Safe because every step reuses what an earlier attempt already created. A failure
// no retry can fix (retryable false) stops at once. The last failure ends the run red, with one
// plain line in the run summary naming the version and the reason.
async function run() {
	for (let attempt = 1; ; attempt++) {
		try {
			await main()
			return
		} catch (error) {
			console.error(`::error::${error.message}`)
			const retryable = error.retryable !== false
			if (retryable && attempt < MAX_ATTEMPTS) {
				console.log(
					`Attempt ${attempt} of ${MAX_ATTEMPTS} failed. Trying again in ${RETRY_PAUSE_MS / 60000} minutes.`,
				)
				await sleep(RETRY_PAUSE_MS)
				continue
			}
			const why = retryable
				? `gave up after ${attempt} attempts`
				: 'not retried, a retry cannot fix it'
			const reason = error.message.replace(/\s+/g, ' ').slice(0, 600)
			if (GITHUB_STEP_SUMMARY) {
				appendFileSync(
					GITHUB_STEP_SUMMARY,
					`App Review submit failed for version ${SUBMIT_VERSION} (${why}): ${reason}\n`,
				)
			}
			process.exit(retryable ? 1 : 2)
		}
	}
}

await run()
