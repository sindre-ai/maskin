// The command desktop put-file runs on an agent's computer. Besides downloading the
// file it tidies up after earlier fetches, so the disk of a small computer does not
// fill with files nobody asked for any more. It is built here, on the server, so a
// computer that has not been re-opened since gets the cleanup too.

/** Room that must stay free after a fetch, on top of the incoming file. */
export const FETCH_FREE_HEADROOM_BYTES = 1024 ** 3

/** A fetched file this old is always removed before the next fetch. */
export const FETCH_KEEP_SECONDS = 24 * 60 * 60

/** A fetched file this young is never removed, not even to make room. */
export const FETCH_MIN_AGE_SECONDS = 60 * 60

/** Exit code of the command when there is no room even after cleanup. */
export const NO_ROOM_EXIT_CODE = 42

/** What the computer keeps of the files put there: one "<epoch seconds> <path>" line per file. */
const RECORD_FILE = '.maskin-fetched'

export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * A path for `sh`, with a leading ~/ turned into $HOME so quoting cannot stop it expanding.
 */
export function shellPath(path: string): string {
	return path.startsWith('~/') ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path)
}

/**
 * The shell script that fetches one file. Prints, one per line: the final path, the
 * sha256, the size and the free bytes left on the disk.
 *
 * Only files this command put on the computer (listed in the record) are ever removed.
 * What the agent made and what Chromium downloaded are not in the record, so they stay.
 * If there is not room (file size plus the headroom) even after cleanup, it prints
 * "NOROOM <free bytes>" and exits with NO_ROOM_EXIT_CODE before downloading anything.
 */
export function buildPutFileCommand(input: {
	folder: string
	fileName: string
	url: string
	sizeBytes: number
}): string {
	const need = input.sizeBytes + FETCH_FREE_HEADROOM_BYTES
	return [
		'set -e',
		`d=${shellPath(input.folder)}`,
		'mkdir -p "$d"',
		`f="$d"/${shellQuote(input.fileName)}`,
		`rec="$HOME"/${RECORD_FILE}`,
		`need=${need}`,
		`trap 'rm -f "$f.part" "$rec.new"' EXIT`,
		// Free bytes on the disk the file will land on.
		'free_bytes() { k=$(df -Pk "$d" | tail -n 1 | awk \'{print $(NF-2)}\'); echo $((k * 1024)); }',
		// Remove recorded files at least $1 seconds old, oldest first (the record is in the
		// order they arrived). With $2 = 1, stop as soon as there is room. Lines for files
		// that are gone are dropped.
		'prune() {',
		'  [ -f "$rec" ] || return 0',
		'  : > "$rec.new"',
		'  t=$(date +%s)',
		'  while IFS= read -r line || [ -n "$line" ]; do',
		'    ts=${line%% *}; p=${line#* }',
		"    case $ts in ''|*[!0-9]*) continue ;; esac",
		'    if [ ! -f "$p" ] || [ -L "$p" ]; then continue; fi',
		'    if [ $((t - ts)) -ge "$1" ] && { [ "$2" = 0 ] || [ "$(free_bytes)" -lt "$need" ]; }; then',
		'      rm -f -- "$p"',
		'    else',
		'      printf \'%s\\n\' "$line" >> "$rec.new"',
		'    fi',
		'  done < "$rec"',
		'  mv -f "$rec.new" "$rec"',
		'}',
		// Note a fetched file, replacing any earlier line for the same path so a fresh copy
		// is not removed on the old copy\'s clock.
		'record() {',
		'  : > "$rec.new"',
		'  if [ -f "$rec" ]; then',
		'    while IFS= read -r line || [ -n "$line" ]; do',
		'      [ "${line#* }" = "$1" ] || printf \'%s\\n\' "$line" >> "$rec.new"',
		'    done < "$rec"',
		'  fi',
		'  printf \'%s %s\\n\' "$(date +%s)" "$1" >> "$rec.new"',
		'  mv -f "$rec.new" "$rec"',
		'}',
		`prune ${FETCH_KEEP_SECONDS} 0`,
		`if [ "$(free_bytes)" -lt "$need" ]; then prune ${FETCH_MIN_AGE_SECONDS} 1; fi`,
		`if [ "$(free_bytes)" -lt "$need" ]; then echo "NOROOM $(free_bytes)"; exit ${NO_ROOM_EXIT_CODE}; fi`,
		// Downloads to a temp name and renames, so a half-finished download never looks like the file.
		`wget -nv --tries=2 --timeout=30 -O "$f.part" ${shellQuote(input.url)}`,
		'mv -f "$f.part" "$f"',
		'p=$(realpath "$f")',
		'record "$p"',
		'echo "$p"',
		`sha256sum "$f" | cut -d' ' -f1`,
		'stat -c %s "$f"',
		'free_bytes',
	].join('\n')
}

/** Bytes as a short size for a message a person or agent reads: "1.2 GB", "340 MB". */
export function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
	return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
