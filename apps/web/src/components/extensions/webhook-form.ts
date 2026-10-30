import type {
	ExtensionSignatureScheme,
	ExtensionWebhookConfig,
	LiteralOrPath,
	VendorRecipe,
} from '@/lib/api'
import { isValidJsonPath } from '@maskin/shared'

/** The three verifiers the backend ships. No "none" and no bearer option (signing is required). */
export const SIGNATURE_SCHEMES: { value: ExtensionSignatureScheme; label: string }[] = [
	{ value: 'hmac-sha256', label: 'HMAC-SHA256 raw body' },
	{ value: 'hmac-sha1', label: 'HMAC-SHA1 raw body' },
	{ value: 'timestamp', label: 'HMAC-SHA256 timestamp + body' },
]

export type FieldMode = 'literal' | 'path'

export interface WebhookFormState {
	scheme: ExtensionSignatureScheme
	signatureHeader: string
	signaturePrefix: string
	timestampHeader: string
	timestampBodyTemplate: string
	externalIdPath: string
	entityTypeMode: FieldMode
	entityType: string
	actionMode: FieldMode
	action: string
	/** Only held while the owner is typing or has just generated one; blank means "keep the stored secret". */
	signingSecret: string
}

export type WebhookFormErrors = Partial<Record<keyof WebhookFormState, string>>

export function emptyWebhookForm(): WebhookFormState {
	return {
		scheme: 'hmac-sha256',
		signatureHeader: '',
		signaturePrefix: '',
		timestampHeader: '',
		timestampBodyTemplate: '',
		externalIdPath: '',
		entityTypeMode: 'literal',
		entityType: '',
		actionMode: 'literal',
		action: '',
		signingSecret: '',
	}
}

function splitLiteralOrPath(v: LiteralOrPath | undefined): { mode: FieldMode; value: string } {
	if (!v) return { mode: 'literal', value: '' }
	return 'path' in v ? { mode: 'path', value: v.path } : { mode: 'literal', value: v.literal }
}

/** Fills a form from a saved config (secret stays blank: the server never returns it). */
export function formFromConfig(
	cfg: Partial<ExtensionWebhookConfig>,
	base: WebhookFormState = emptyWebhookForm(),
): WebhookFormState {
	const entity = splitLiteralOrPath(cfg.eventMap?.entityType)
	const action = splitLiteralOrPath(cfg.eventMap?.action)
	return {
		...base,
		scheme: cfg.signatureScheme ?? base.scheme,
		signatureHeader: cfg.signatureHeader ?? base.signatureHeader,
		signaturePrefix: cfg.signaturePrefix ?? '',
		timestampHeader: cfg.timestampHeader ?? '',
		timestampBodyTemplate: cfg.timestampBodyTemplate ?? '',
		externalIdPath: cfg.eventMap?.externalIdPath ?? base.externalIdPath,
		entityTypeMode: entity.mode,
		entityType: entity.value,
		actionMode: action.mode,
		action: action.value,
	}
}

export function formFromRecipe(recipe: VendorRecipe, base: WebhookFormState): WebhookFormState {
	return recipe.webhookConfig ? formFromConfig(recipe.webhookConfig, base) : base
}

function toLiteralOrPath(mode: FieldMode, value: string): LiteralOrPath {
	return mode === 'path' ? { path: value.trim() } : { literal: value.trim() }
}

export function configFromForm(form: WebhookFormState): ExtensionWebhookConfig {
	const cfg: ExtensionWebhookConfig = {
		signatureScheme: form.scheme,
		signatureHeader: form.signatureHeader.trim(),
		secretSource: 'credential',
		eventMap: {
			externalIdPath: form.externalIdPath.trim(),
			entityType: toLiteralOrPath(form.entityTypeMode, form.entityType),
			action: toLiteralOrPath(form.actionMode, form.action),
		},
	}
	if (form.signaturePrefix.trim()) cfg.signaturePrefix = form.signaturePrefix.trim()
	if (form.scheme === 'timestamp') {
		cfg.timestampHeader = form.timestampHeader.trim()
		cfg.timestampBodyTemplate = form.timestampBodyTemplate.trim()
	}
	return cfg
}

const INVALID_PATH = 'Not a valid path. Use something like $.meeting_id or $.data.items[0].id'

/** Client-side checks that mirror the server's Zod rules, so Save can be disabled instead of failing. */
export function validateWebhookForm(
	form: WebhookFormState,
	opts: { requireSecret: boolean },
): WebhookFormErrors {
	const errors: WebhookFormErrors = {}
	if (!form.signatureHeader.trim()) errors.signatureHeader = 'Required'
	if (form.scheme === 'timestamp') {
		if (!form.timestampHeader.trim()) errors.timestampHeader = 'Required'
		if (!form.timestampBodyTemplate.trim()) errors.timestampBodyTemplate = 'Required'
	}
	if ((opts.requireSecret || form.signingSecret) && form.signingSecret.length < 16) {
		errors.signingSecret = 'Use at least 16 characters, or press Generate'
	}
	if (!form.externalIdPath.trim()) errors.externalIdPath = 'Required'
	else if (!isValidJsonPath(form.externalIdPath.trim())) errors.externalIdPath = INVALID_PATH
	if (!form.entityType.trim()) errors.entityType = 'Required'
	else if (form.entityTypeMode === 'path' && !isValidJsonPath(form.entityType.trim()))
		errors.entityType = INVALID_PATH
	if (!form.action.trim()) errors.action = 'Required'
	else if (form.actionMode === 'path' && !isValidJsonPath(form.action.trim()))
		errors.action = INVALID_PATH
	return errors
}

export function hasErrors(errors: WebhookFormErrors): boolean {
	return Object.keys(errors).length > 0
}

/** Lowercase letters, numbers and single dashes, as the API requires for a slug. */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)
		.replace(/-+$/g, '')
}
