// The loop-page settings a marketplace loop ships: entry condition, close condition, tags and
// starter targets. Stored as one jsonb column on marketplace_loops (loop_settings) and copied
// onto the installer's loop object (metadata.entry_condition and so on) at install and on a
// version push.

import { loopTargetSchema, normalizeTags } from '@maskin/shared'
import { z } from 'zod'

// A shipped target never carries an owner: actor ids from the publishing workspace do not exist
// in the installer's workspace.
const shippedTargetSchema = loopTargetSchema.omit({ ownerActorId: true })

export const loopSettingsSchema = z.object({
	entryCondition: z.string().min(1).optional(),
	closeCondition: z.string().min(1).optional(),
	tags: z.array(z.string().min(1)).optional(),
	targets: z.array(shippedTargetSchema).optional(),
})
export type LoopSettings = z.infer<typeof loopSettingsSchema>

// Reads the stored column back; anything that does not parse is treated as "ships no settings"
// so a bad row cannot fail an install.
export function readLoopSettings(raw: unknown): LoopSettings | null {
	const parsed = loopSettingsSchema.safeParse(raw)
	return parsed.success ? parsed.data : null
}

const SHIPPED_KEY = 'shipped_loop_settings'
type Meta = Record<string, unknown>

// The text the loop object gets: entry_condition, close_condition and tags.
function textMetadata(settings: LoopSettings): Meta {
	const out: Meta = {}
	if (settings.entryCondition) out.entry_condition = settings.entryCondition
	if (settings.closeCondition) out.close_condition = settings.closeCondition
	if (settings.tags) out.tags = normalizeTags(settings.tags)
	return out
}

// Metadata for a new install: the text, the starter targets, and a copy of the text as shipped
// so a later version push can tell an untouched loop from one a workspace has edited.
export function loopSettingsForInstall(settings: LoopSettings | null): Meta {
	if (!settings) return {}
	const text = textMetadata(settings)
	const out: Meta = { ...text }
	if (Object.keys(text).length > 0) out[SHIPPED_KEY] = text
	if (settings.targets && settings.targets.length > 0) out.targets = settings.targets
	return out
}

// Metadata to merge into an existing install on a version push. A field is refreshed only when
// the loop is still on the text it was installed with, or has none. An edited field is kept.
// A field already on the new shipped text, with the shipped copy to match, is left alone.
// A loop installed before settings existed has no shipped copy, so it only gets fields it lacks.
// Targets only seed a loop that has none, since the loop's agents keep their actuals.
export function loopSettingsPatch(settings: LoopSettings | null, current: Meta | null): Meta {
	if (!settings) return {}
	const meta = current ?? {}
	const shipped = (meta[SHIPPED_KEY] as Meta | undefined) ?? {}
	const patch: Meta = {}
	const nextShipped: Meta = { ...shipped }
	for (const [key, next] of Object.entries(textMetadata(settings))) {
		const cur = meta[key]
		const nextJson = JSON.stringify(next)
		const untouched =
			cur === undefined ||
			cur === null ||
			cur === '' ||
			(key in shipped && JSON.stringify(cur) === JSON.stringify(shipped[key]))
		if (!untouched) continue
		if (JSON.stringify(cur) === nextJson && JSON.stringify(shipped[key]) === nextJson) continue
		patch[key] = next
		nextShipped[key] = next
	}
	if (Object.keys(patch).length > 0) patch[SHIPPED_KEY] = nextShipped
	const hasTargets = Array.isArray(meta.targets) && meta.targets.length > 0
	if (!hasTargets && settings.targets && settings.targets.length > 0)
		patch.targets = settings.targets
	return patch
}
