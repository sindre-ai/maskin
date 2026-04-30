#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const ENV_PATH = '.env'

function readEnvValue(content, name) {
	const match = content.match(new RegExp(`^${name}=(.*)$`, 'm'))
	return match ? match[1].trim() : ''
}

function upsertEnvLine(content, name, value) {
	const withValueRe = new RegExp(`^${name}=.*$`, 'm')
	const bareRe = new RegExp(`^${name}$`, 'm')
	let next = content
	if (withValueRe.test(next)) {
		next = next.replace(withValueRe, `${name}=${value}`)
	} else if (bareRe.test(next)) {
		next = next.replace(bareRe, `${name}=${value}`)
	} else {
		if (next && !next.endsWith('\n')) next += '\n'
		next += `${name}=${value}\n`
	}
	return next
}

const KEY_NAME = 'INTEGRATION_ENCRYPTION_KEY'
const KEY_BYTES = 32
const EXPECTED_HEX_LEN = KEY_BYTES * 2

function isValidHexKey(value) {
	return /^[0-9a-fA-F]+$/.test(value) && value.length === EXPECTED_HEX_LEN
}

const DATABASE_URL_NAME = 'DATABASE_URL'
const DATABASE_URL_DEFAULT = 'postgresql://postgres:postgres@localhost:5432/maskin'

let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : ''
let changed = false

const keyFromEnv = (process.env[KEY_NAME] ?? '').trim()
const keyFromFile = readEnvValue(content, KEY_NAME)
if (!isValidHexKey(keyFromEnv) && !isValidHexKey(keyFromFile)) {
	const generated = randomBytes(KEY_BYTES).toString('hex')
	content = upsertEnvLine(content, KEY_NAME, generated)
	changed = true
	console.log(`Generated ${KEY_NAME} (written to ${ENV_PATH})`)
}

const dbUrlFromEnv = (process.env[DATABASE_URL_NAME] ?? '').trim()
const dbUrlFromFile = readEnvValue(content, DATABASE_URL_NAME)
if (!dbUrlFromEnv && !dbUrlFromFile) {
	content = upsertEnvLine(content, DATABASE_URL_NAME, DATABASE_URL_DEFAULT)
	changed = true
	console.log(`Set default ${DATABASE_URL_NAME} (written to ${ENV_PATH})`)
}

if (changed) {
	writeFileSync(ENV_PATH, content)
}
