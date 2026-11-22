// The command desktop save-file runs on an agent's computer: the mirror of put-file. It checks
// the path, then sends the file straight to a short-lived storage URL, so the bytes never pass
// through the caller and the agent's API key is never on the computer. Built on the server so a
// computer that has not been re-opened since gets the same checks.

import { shellPath, shellQuote } from './desktop-put-file-command'

/** Largest file a save accepts. The computer stops any command at 120 seconds, so more would time out. */
export const SAVE_FILE_MAX_BYTES = 100 * 1024 * 1024

/** At most this many saves per computer per hour, so a steered agent cannot flood the workspace. */
export const SAVE_FILE_MAX_PER_HOUR = 20

/** The path is not a file under the agent's home folder (or is inside a hidden folder there). */
export const NOT_ALLOWED_EXIT_CODE = 43
/** The file is over the cap. Nothing was uploaded. */
export const TOO_BIG_EXIT_CODE = 44
/** There is no regular file at the path. */
export const NOT_FOUND_EXIT_CODE = 45
/** The file is empty, and an empty file is not worth a workspace file. */
export const EMPTY_EXIT_CODE = 46

/**
 * The shell script that sends one file. Prints, one per line: the resolved path, the size
 * before the upload, the sha256, and the size after it (a file still being written shows up as
 * two different sizes).
 *
 * Only a regular file under the home folder goes, and nothing inside a hidden folder there:
 * that is where the browser keeps its logins. The path is resolved first, so a link or ".."
 * cannot lead out. If the file is over the cap it prints "TOOBIG <bytes>" and exits before
 * hashing or uploading anything.
 */
export function buildSaveFileCommand(input: {
	path: string
	url: string
	maxBytes: number
}): string {
	return [
		'set -e',
		`r=$(realpath -e -- ${shellPath(input.path)} 2>/dev/null) || exit ${NOT_FOUND_EXIT_CODE}`,
		`[ -f "$r" ] || exit ${NOT_FOUND_EXIT_CODE}`,
		'home=$(realpath "$HOME")',
		`case "$r" in "$home"/*) ;; *) exit ${NOT_ALLOWED_EXIT_CODE} ;; esac`,
		'rel=${r#"$home"/}',
		`case "/$rel" in */.*) exit ${NOT_ALLOWED_EXIT_CODE} ;; esac`,
		'size=$(stat -c %s "$r")',
		`if [ "$size" -gt ${input.maxBytes} ]; then echo "TOOBIG $size"; exit ${TOO_BIG_EXIT_CODE}; fi`,
		`[ "$size" -gt 0 ] || exit ${EMPTY_EXIT_CODE}`,
		`sum=$(sha256sum "$r" | cut -d' ' -f1)`,
		`wget -nv --tries=1 --timeout=60 --method=PUT --body-file="$r" -O /dev/null ${shellQuote(input.url)}`,
		'echo "$r"',
		'echo "$size"',
		'echo "$sum"',
		'stat -c %s "$r"',
	].join('\n')
}

const MIME_BY_EXTENSION: Record<string, string> = {
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	webm: 'video/webm',
	mkv: 'video/x-matroska',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	pdf: 'application/pdf',
	zip: 'application/zip',
	json: 'application/json',
	csv: 'text/csv',
	txt: 'text/plain',
	md: 'text/markdown',
	srt: 'application/x-subrip',
}

/** The type a saved file gets, from its name. Unknown extensions are plain bytes. */
export function mimeTypeForFileName(name: string): string {
	const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined
	return (extension && MIME_BY_EXTENSION[extension]) || 'application/octet-stream'
}
