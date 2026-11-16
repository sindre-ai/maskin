// Settings that live in an agent computer's image, and how to reach an existing computer
// without deleting it. A computer keeps the image it was created from, and re-opening it
// wipes its saved logins, so a changed setting (the file chooser's size, say) would never
// arrive. Instead the server builds one command that rewrites the files below on the running
// computer, the way put-file sends its download. The command is built here and nowhere else:
// the caller never names a file or a value.

/** Bump when SETTINGS_FILES changes, so a computer's recorded version says what it has. */
export const DESKTOP_SETTINGS_VERSION = 1

/** The only files the apply command writes, relative to the computer user's home. */
export const SETTINGS_FILES = {
	// GSettings keyfile backend: Plank's settings and the GTK file chooser's remembered size.
	keyfile: '.config/glib-2.0/settings/keyfile',
	// What the last apply wrote, so the read-only call can tell an old computer from a new one.
	marker: '.config/maskin-desktop/settings-version',
} as const

/**
 * Keys written into one section of the keyfile. Matches docker/desktop/dock/keyfile, which
 * seeds them at build time: unset, GTK opens the chooser 1124x822, taller than the screen,
 * so its Open button is off-screen. Both keys are needed. A key outside this list is left
 * exactly as it is, and so is every other section.
 */
export const CHOOSER_SECTION = 'org/gtk/settings/file-chooser'
export const CHOOSER_KEYS: ReadonlyArray<readonly [string, string]> = [
	['window-position', '(400, 20)'],
	['window-size', '(800, 480)'],
]

/**
 * True when a setting only takes effect after Chromium restarts. The keyfile is read
 * through GSettings, which watches the file, so a chooser opened after the write uses it.
 * A restart closes the pages that hold saved logins, so a future entry that needs it must
 * say so in the apply result rather than do it silently.
 */
export const KEYFILE_NEEDS_CHROMIUM_RESTART = false

// Runs on the computer under python3 (desktopd already needs it). Takes one argument, a JSON
// list: [home-relative keyfile, home-relative marker, section, [[key, value], ...], version].
// Rewrites only the named keys in the named section, in place (the file is tiny and GSettings
// watches it), and writes nothing when the file already says the same, so a second run
// changes nothing. Prints key=value lines.
const APPLY_SCRIPT = `
import json, os, sys
keyfile_rel, marker_rel, section, wanted, version = json.loads(sys.argv[1])
home = os.environ["HOME"]

def read(path):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return None

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)

keyfile = os.path.join(home, keyfile_rel)
before = read(keyfile)
lines = (before or "").split("\\n")
if lines and lines[-1] == "":
    lines.pop()
header = "[" + section + "]"
start = next((i for i, l in enumerate(lines) if l.strip() == header), None)
if start is None:
    if lines:
        lines.append("")
    lines.append(header)
    lines += [k + "=" + v for k, v in wanted]
else:
    end = next((i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith("[")), len(lines))
    body = lines[start + 1:end]
    for k, v in wanted:
        row = k + "=" + v
        at = next((i for i, l in enumerate(body) if l.split("=", 1)[0].strip() == k and "=" in l), None)
        if at is None:
            body.append(row)
        else:
            body[at] = row
    lines[start + 1:end] = body
after = "\\n".join(lines) + "\\n"
keyfile_changed = after != before
if keyfile_changed:
    write(keyfile, after)

marker = os.path.join(home, marker_rel)
marker_changed = (read(marker) or "").strip() != str(version)
if marker_changed:
    write(marker, str(version) + "\\n")

print("keyfile_changed=" + ("1" if keyfile_changed else "0"))
print("marker_changed=" + ("1" if marker_changed else "0"))
print("settings_version=" + str(version))
`

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** The one command that brings a running computer's settings files up to date. */
export function buildApplySettingsCommand(): string {
	const args = JSON.stringify([
		SETTINGS_FILES.keyfile,
		SETTINGS_FILES.marker,
		CHOOSER_SECTION,
		CHOOSER_KEYS,
		DESKTOP_SETTINGS_VERSION,
	])
	return `python3 -c ${shellQuote(APPLY_SCRIPT)} ${shellQuote(args)}`
}

/**
 * A read-only command: prints what a computer has, one key=value per line. Writes nothing.
 * image_tag is empty on an image built before the stamp existed, which is itself the answer
 * ("older than the stamp"). Sizes are in megabytes of the disk the home folder is on.
 */
export function buildReadSettingsCommand(): string {
	const keyfile = `"$HOME"/${shellQuote(SETTINGS_FILES.keyfile)}`
	return [
		`m="$HOME"/${shellQuote(SETTINGS_FILES.marker)}`,
		'echo "settings_version=$(cat "$m" 2>/dev/null | head -n1)"',
		'echo "image_tag=$(cat /etc/maskin-desktop-image 2>/dev/null | head -n1)"',
		`echo "chooser_size=$(grep -s '^window-size=' ${keyfile} | head -n1 | cut -d= -f2-)"`,
		`echo "chooser_position=$(grep -s '^window-position=' ${keyfile} | head -n1 | cut -d= -f2-)"`,
		`df -Pm "$HOME" | awk 'NR==2 {print "disk_total_mb=" $2; print "disk_free_mb=" $4}'`,
	].join('\n')
}

/** Reads the key=value lines a command above printed. Lines without an = are ignored. */
export function parseKeyValueLines(stdout: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const line of stdout.split('\n')) {
		const at = line.indexOf('=')
		if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
	}
	return out
}
