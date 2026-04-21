#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const ENV_PATH = '.env'
const KEY_NAME = 'INTEGRATION_ENCRYPTION_KEY'
const KEY_BYTES = 32
const EXPECTED_HEX_LEN = KEY_BYTES * 2

function readEnvValue(content, name) {
	const match = content.match(new RegExp(`^${name}=(.*)$`, 'm'))
	return match ? match[1].trim() : ''
}

function isValidHexKey(value) {
	return /^[0-9a-fA-F]+$/.test(value) && value.length === EXPECTED_HEX_LEN
}

const existingContent = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : ''
const currentFromEnv = (process.env[KEY_NAME] ?? '').trim()
const currentFromFile = readEnvValue(existingContent, KEY_NAME)

if (isValidHexKey(currentFromEnv) || isValidHexKey(currentFromFile)) {
	process.exit(0)
}

const key = randomBytes(KEY_BYTES).toString('hex')
let next = existingContent
const withValueRe = new RegExp(`^${KEY_NAME}=.*$`, 'm')
const bareRe = new RegExp(`^${KEY_NAME}$`, 'm')

if (withValueRe.test(next)) {
	next = next.replace(withValueRe, `${KEY_NAME}=${key}`)
} else if (bareRe.test(next)) {
	next = next.replace(bareRe, `${KEY_NAME}=${key}`)
} else {
	if (next && !next.endsWith('\n')) next += '\n'
	next += `${KEY_NAME}=${key}\n`
}

writeFileSync(ENV_PATH, next)
console.log(`Generated ${KEY_NAME} (written to ${ENV_PATH})`)
