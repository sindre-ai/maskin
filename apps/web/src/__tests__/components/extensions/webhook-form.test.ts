import {
	configFromForm,
	emptyWebhookForm,
	formFromConfig,
	formFromRecipe,
	hasErrors,
	slugify,
	validateWebhookForm,
} from '@/components/extensions/webhook-form'
import type { ExtensionWebhookConfig, VendorRecipe } from '@/lib/api'
import { describe, expect, it } from 'vitest'

const FIREFLIES: ExtensionWebhookConfig = {
	signatureScheme: 'hmac-sha256',
	signatureHeader: 'X-Hub-Signature',
	signaturePrefix: 'sha256=',
	secretSource: 'credential',
	eventMap: {
		externalIdPath: '$.meeting_id',
		entityType: { literal: 'fireflies.transcript' },
		action: { literal: 'ready' },
	},
}

const SECRET = 'a'.repeat(64)

describe('webhook form model', () => {
	it('round-trips a saved config through the form', () => {
		const form = formFromConfig(FIREFLIES)
		expect(form.externalIdPath).toBe('$.meeting_id')
		expect(form.entityTypeMode).toBe('literal')
		expect(configFromForm(form)).toEqual(FIREFLIES)
	})

	it('keeps a path-driven action as a path', () => {
		const form = formFromConfig({
			...FIREFLIES,
			eventMap: { ...FIREFLIES.eventMap, action: { path: '$.triggerEvent' } },
		})
		expect(form.actionMode).toBe('path')
		expect(configFromForm(form).eventMap.action).toEqual({ path: '$.triggerEvent' })
	})

	it('only sends timestamp fields for the timestamp scheme', () => {
		const raw = configFromForm({ ...formFromConfig(FIREFLIES), timestampHeader: 'x-ts' })
		expect(raw.timestampHeader).toBeUndefined()
		const ts = configFromForm({
			...formFromConfig(FIREFLIES),
			scheme: 'timestamp',
			timestampHeader: 'x-ts',
			timestampBodyTemplate: 'v0:{timestamp}:{body}',
		})
		expect(ts.timestampHeader).toBe('x-ts')
		expect(ts.timestampBodyTemplate).toBe('v0:{timestamp}:{body}')
	})

	it('pre-fills from a recipe without touching the secret', () => {
		const recipe: VendorRecipe = {
			slug: 'fireflies',
			displayName: 'Fireflies',
			webhookConfig: FIREFLIES,
			docsUrl: 'https://docs.fireflies.ai/graphql-api/webhooks-v2',
		}
		const base = { ...emptyWebhookForm(), signingSecret: SECRET }
		const form = formFromRecipe(recipe, base)
		expect(form.signatureHeader).toBe('X-Hub-Signature')
		expect(form.signingSecret).toBe(SECRET)
	})
})

describe('validateWebhookForm', () => {
	const valid = { ...formFromConfig(FIREFLIES), signingSecret: SECRET }

	it('accepts a complete form', () => {
		expect(hasErrors(validateWebhookForm(valid, { requireSecret: true }))).toBe(false)
	})

	it('requires a secret on first save but not when one is stored', () => {
		const noSecret = { ...valid, signingSecret: '' }
		expect(validateWebhookForm(noSecret, { requireSecret: true }).signingSecret).toBeTruthy()
		expect(hasErrors(validateWebhookForm(noSecret, { requireSecret: false }))).toBe(false)
	})

	it('rejects a short replacement secret even when one is stored', () => {
		const short = { ...valid, signingSecret: 'short' }
		expect(validateWebhookForm(short, { requireSecret: false }).signingSecret).toBeTruthy()
	})

	it('flags JSONPath fields that do not parse and ignores literal values', () => {
		const bad = { ...valid, externalIdPath: 'meeting_id', actionMode: 'path' as const, action: 'x' }
		const errors = validateWebhookForm(bad, { requireSecret: true })
		expect(errors.externalIdPath).toBeTruthy()
		expect(errors.action).toBeTruthy()
		expect(errors.entityType).toBeUndefined()
	})

	it('requires the timestamp header and template for the timestamp scheme', () => {
		const errors = validateWebhookForm({ ...valid, scheme: 'timestamp' }, { requireSecret: true })
		expect(errors.timestampHeader).toBeTruthy()
		expect(errors.timestampBodyTemplate).toBeTruthy()
	})
})

describe('slugify', () => {
	it('makes a lowercase dashed slug', () => {
		expect(slugify('Fireflies')).toBe('fireflies')
		expect(slugify('Cal.com')).toBe('cal-com')
		expect(slugify('  Loops.so  Events ')).toBe('loops-so-events')
	})

	it('drops accents and symbols, and caps the length', () => {
		expect(slugify('Café 100%')).toBe('cafe-100')
		expect(slugify('x'.repeat(80)).length).toBeLessThanOrEqual(48)
	})

	it('returns an empty string when nothing usable is left', () => {
		expect(slugify('!!!')).toBe('')
	})
})
