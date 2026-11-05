// A phone only raises its keyboard for a text field, and noVNC's canvas is not one. The viewer
// keeps a hidden textarea for that and turns what is typed into it into X11 key presses.

/** What the hidden textarea holds, so Backspace has something to delete on every phone keyboard. */
export const KEYBOARD_SENTINEL = '_'.repeat(99)

const KEYSYM = {
	BackSpace: 0xff08,
	Tab: 0xff09,
	Return: 0xff0d,
	Escape: 0xff1b,
	Left: 0xff51,
	Up: 0xff52,
	Right: 0xff53,
	Down: 0xff54,
	Delete: 0xffff,
}

/** Keys that arrive as keydown (an attached keyboard, or Return and Delete on iOS), by `KeyboardEvent.key`. */
export const SPECIAL_KEYS: Record<string, number> = {
	Backspace: KEYSYM.BackSpace,
	Tab: KEYSYM.Tab,
	Enter: KEYSYM.Return,
	Escape: KEYSYM.Escape,
	ArrowLeft: KEYSYM.Left,
	ArrowUp: KEYSYM.Up,
	ArrowRight: KEYSYM.Right,
	ArrowDown: KEYSYM.Down,
	Delete: KEYSYM.Delete,
}

/** The X11 keysym for one typed character: Latin-1 is its own code, the rest is Unicode-prefixed. */
export function keysymForChar(char: string): number {
	const code = char.codePointAt(0) ?? 0
	if (code === 0x0a || code === 0x0d) return KEYSYM.Return
	return code < 0x100 ? code : 0x01000000 + code
}

/**
 * What changed between the textarea's last and current text, as key presses: how many Backspaces,
 * then the characters to type. Compares from the start so a keyboard's autocorrect (which rewrites
 * the word before the cursor) comes out as Backspaces plus the new letters.
 */
export function diffTyped(previous: string, next: string): { backspaces: number; typed: string[] } {
	let common = 0
	const shortest = Math.min(previous.length, next.length)
	while (common < shortest && previous[common] === next[common]) common++
	return { backspaces: previous.length - common, typed: [...next.slice(common)] }
}
