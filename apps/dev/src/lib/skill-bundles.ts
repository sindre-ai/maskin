import AdmZip from 'adm-zip'

export const SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024 // 10 MB
export const SKILL_BUNDLE_MAX_ENTRY_BYTES = 5 * 1024 * 1024 // per-entry cap (zip-bomb guard)
export const SKILL_BUNDLE_MAX_ENTRIES = 500

export type SkillBundleEntry = {
	/** Path relative to the bundle root, never starts with `/` or contains `..`. */
	path: string
	data: Buffer
}

export type SkillBundle = {
	entries: SkillBundleEntry[]
	skillMd: { path: string; content: string }
	totalBytes: number
}

export type SkillBundleError =
	| { kind: 'zip_invalid'; message: string }
	| { kind: 'no_skill_md'; message: string }
	| { kind: 'multiple_skill_md'; message: string }
	| { kind: 'too_many_entries'; message: string }
	| { kind: 'too_large'; message: string }
	| { kind: 'unsafe_path'; message: string }

export type ExtractSkillBundleResult =
	| { ok: true; bundle: SkillBundle }
	| { ok: false; error: SkillBundleError }

function isUnsafePath(path: string): boolean {
	if (path.startsWith('/') || path.startsWith('\\')) return true
	if (path.includes('..')) return true
	// Absolute Windows-style (drive letter)
	if (/^[a-zA-Z]:/.test(path)) return true
	return false
}

function normalisePath(rawPath: string): string {
	return rawPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '')
}

/**
 * Parse + validate a skill bundle zip. Accepts both flat (`SKILL.md` at root)
 * and wrapped (`skill-name/SKILL.md`) layouts. The wrapper directory, if any,
 * is stripped so the returned `entries` are always rooted at the bundle.
 *
 * On a structural failure (oversize, missing SKILL.md, traversal) returns
 * `{ ok: false, error }` so the caller can land a row with `isValid: false`
 * instead of returning a 4xx. The route surfaces the error via the response.
 */
export function extractSkillBundle(buffer: Buffer): ExtractSkillBundleResult {
	let zip: AdmZip
	try {
		zip = new AdmZip(buffer)
	} catch (err) {
		return {
			ok: false,
			error: {
				kind: 'zip_invalid',
				message: err instanceof Error ? err.message : String(err),
			},
		}
	}

	const rawEntries = zip.getEntries().filter((e) => !e.isDirectory)
	if (rawEntries.length === 0) {
		return { ok: false, error: { kind: 'no_skill_md', message: 'Zip contained no files' } }
	}
	if (rawEntries.length > SKILL_BUNDLE_MAX_ENTRIES) {
		return {
			ok: false,
			error: {
				kind: 'too_many_entries',
				message: `Bundle has ${rawEntries.length} entries (limit ${SKILL_BUNDLE_MAX_ENTRIES})`,
			},
		}
	}

	// Detect wrapping directory: if every entry shares a non-empty top segment,
	// strip it. Empty bundles are caught above.
	const topSegments = new Set<string>()
	for (const entry of rawEntries) {
		const normalised = normalisePath(entry.entryName)
		const top = normalised.split('/')[0] ?? ''
		topSegments.add(top)
	}
	const wrapper =
		topSegments.size === 1 &&
		[...topSegments][0] !== '' &&
		[...topSegments][0]?.includes('.') === false
			? [...topSegments][0]
			: null

	const entries: SkillBundleEntry[] = []
	let totalBytes = 0
	let skillMdPath: string | null = null
	let skillMdContent = ''

	for (const entry of rawEntries) {
		const normalised = normalisePath(entry.entryName)
		if (isUnsafePath(normalised)) {
			return {
				ok: false,
				error: {
					kind: 'unsafe_path',
					message: `Refused path traversal entry: ${entry.entryName}`,
				},
			}
		}

		const relative = wrapper
			? normalised.startsWith(`${wrapper}/`)
				? normalised.slice(wrapper.length + 1)
				: normalised
			: normalised
		if (relative === '') continue

		// Zip-bomb guard: reject on the declared uncompressed size BEFORE
		// decompressing — getData() allocates the full declared size up front,
		// so checking afterwards would let a tiny zip allocate gigabytes.
		const declaredBytes = entry.header.size
		if (declaredBytes > SKILL_BUNDLE_MAX_ENTRY_BYTES) {
			return {
				ok: false,
				error: {
					kind: 'too_large',
					message: `Entry ${relative} is ${declaredBytes} bytes (limit ${SKILL_BUNDLE_MAX_ENTRY_BYTES})`,
				},
			}
		}
		if (totalBytes + declaredBytes > SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES) {
			return {
				ok: false,
				error: {
					kind: 'too_large',
					message: `Bundle exceeds ${SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES} bytes uncompressed`,
				},
			}
		}

		// A header lying LOW about its size is caught by adm-zip's inflater
		// (maxOutputLength = declared size) — surface that as zip_invalid
		// instead of an uncaught throw.
		let data: Buffer
		try {
			data = entry.getData()
		} catch (err) {
			return {
				ok: false,
				error: {
					kind: 'zip_invalid',
					message: `Failed to decompress entry ${relative}: ${err instanceof Error ? err.message : String(err)}`,
				},
			}
		}
		if (data.length > SKILL_BUNDLE_MAX_ENTRY_BYTES) {
			return {
				ok: false,
				error: {
					kind: 'too_large',
					message: `Entry ${relative} is ${data.length} bytes (limit ${SKILL_BUNDLE_MAX_ENTRY_BYTES})`,
				},
			}
		}
		totalBytes += data.length
		if (totalBytes > SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES) {
			return {
				ok: false,
				error: {
					kind: 'too_large',
					message: `Bundle exceeds ${SKILL_BUNDLE_MAX_UNCOMPRESSED_BYTES} bytes uncompressed`,
				},
			}
		}

		if (relative === 'SKILL.md') {
			if (skillMdPath !== null) {
				return {
					ok: false,
					error: {
						kind: 'multiple_skill_md',
						message: 'Bundle contains more than one SKILL.md at its root',
					},
				}
			}
			skillMdPath = relative
			skillMdContent = data.toString('utf-8')
		}
		entries.push({ path: relative, data })
	}

	if (!skillMdPath) {
		return {
			ok: false,
			error: { kind: 'no_skill_md', message: 'Bundle is missing SKILL.md at its root' },
		}
	}

	return {
		ok: true,
		bundle: {
			entries,
			skillMd: { path: skillMdPath, content: skillMdContent },
			totalBytes,
		},
	}
}
