// Emoji picker trigger for Tiptap editors, built on `@tiptap/suggestion`:
// typing ":smi" at the start of a word lists matching emoji, Enter or a click
// swaps the typed text for the emoji. Like slash-command.ts this module owns
// only the Tiptap side (data, filter, trigger rules, suggestion lifecycle) and
// renders nothing; apps/web injects the list through `createView`.

import { type Editor, Extension, type Range } from '@tiptap/core'
import { type EditorState, PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion'

export interface EmojiItem {
	/** Name typed after the colon, lowercase with underscores: "smile". */
	shortcode: string
	emoji: string
	/** Other words that find the same emoji ("lol" finds "joy"). */
	aliases?: readonly string[]
}

// A short everyday set, not the full Unicode list: it ships in the editor
// bundle, so every row has to earn its place.
export const EMOJI_ITEMS: readonly EmojiItem[] = [
	{ shortcode: 'smile', emoji: '😄', aliases: ['happy'] },
	{ shortcode: 'smiley', emoji: '😃', aliases: ['happy'] },
	{ shortcode: 'grinning', emoji: '😀' },
	{ shortcode: 'grin', emoji: '😁' },
	{ shortcode: 'slightly_smiling_face', emoji: '🙂', aliases: ['smile'] },
	{ shortcode: 'blush', emoji: '😊' },
	{ shortcode: 'wink', emoji: '😉' },
	{ shortcode: 'joy', emoji: '😂', aliases: ['lol', 'laugh'] },
	{ shortcode: 'rofl', emoji: '🤣', aliases: ['lol', 'laugh'] },
	{ shortcode: 'sweat_smile', emoji: '😅' },
	{ shortcode: 'laughing', emoji: '😆', aliases: ['satisfied'] },
	{ shortcode: 'heart_eyes', emoji: '😍', aliases: ['love'] },
	{ shortcode: 'star_struck', emoji: '🤩' },
	{ shortcode: 'kissing_heart', emoji: '😘' },
	{ shortcode: 'yum', emoji: '😋' },
	{ shortcode: 'stuck_out_tongue', emoji: '😛' },
	{ shortcode: 'stuck_out_tongue_winking_eye', emoji: '😜' },
	{ shortcode: 'sunglasses', emoji: '😎', aliases: ['cool'] },
	{ shortcode: 'nerd_face', emoji: '🤓' },
	{ shortcode: 'thinking', emoji: '🤔', aliases: ['hmm'] },
	{ shortcode: 'face_with_raised_eyebrow', emoji: '🤨' },
	{ shortcode: 'neutral_face', emoji: '😐' },
	{ shortcode: 'expressionless', emoji: '😑' },
	{ shortcode: 'unamused', emoji: '😒' },
	{ shortcode: 'roll_eyes', emoji: '🙄' },
	{ shortcode: 'grimacing', emoji: '😬' },
	{ shortcode: 'relieved', emoji: '😌' },
	{ shortcode: 'pensive', emoji: '😔' },
	{ shortcode: 'sleepy', emoji: '😪' },
	{ shortcode: 'sleeping', emoji: '😴', aliases: ['zzz'] },
	{ shortcode: 'mask', emoji: '😷', aliases: ['sick'] },
	{ shortcode: 'face_with_thermometer', emoji: '🤒', aliases: ['sick'] },
	{ shortcode: 'confused', emoji: '😕' },
	{ shortcode: 'worried', emoji: '😟' },
	{ shortcode: 'slightly_frowning_face', emoji: '🙁' },
	{ shortcode: 'open_mouth', emoji: '😮' },
	{ shortcode: 'astonished', emoji: '😲' },
	{ shortcode: 'flushed', emoji: '😳' },
	{ shortcode: 'pleading_face', emoji: '🥺' },
	{ shortcode: 'cry', emoji: '😢', aliases: ['sad'] },
	{ shortcode: 'sob', emoji: '😭', aliases: ['sad'] },
	{ shortcode: 'scream', emoji: '😱' },
	{ shortcode: 'disappointed', emoji: '😞', aliases: ['sad'] },
	{ shortcode: 'sweat', emoji: '😓' },
	{ shortcode: 'weary', emoji: '😩' },
	{ shortcode: 'triumph', emoji: '😤' },
	{ shortcode: 'rage', emoji: '😡', aliases: ['angry'] },
	{ shortcode: 'angry', emoji: '😠' },
	{ shortcode: 'exploding_head', emoji: '🤯', aliases: ['mind_blown'] },
	{ shortcode: 'partying_face', emoji: '🥳', aliases: ['party'] },
	{ shortcode: 'hugs', emoji: '🤗' },
	{ shortcode: 'shushing_face', emoji: '🤫' },
	{ shortcode: 'zipper_mouth_face', emoji: '🤐' },
	{ shortcode: 'upside_down_face', emoji: '🙃' },
	{ shortcode: 'money_mouth_face', emoji: '🤑' },
	{ shortcode: 'skull', emoji: '💀', aliases: ['dead'] },
	{ shortcode: 'ghost', emoji: '👻' },
	{ shortcode: 'robot', emoji: '🤖' },
	{ shortcode: 'poop', emoji: '💩' },
	{ shortcode: 'see_no_evil', emoji: '🙈' },
	{ shortcode: 'hear_no_evil', emoji: '🙉' },
	{ shortcode: 'speak_no_evil', emoji: '🙊' },
	{ shortcode: 'thumbsup', emoji: '👍', aliases: ['+1', 'like', 'yes'] },
	{ shortcode: 'thumbsdown', emoji: '👎', aliases: ['-1', 'dislike', 'no'] },
	{ shortcode: 'ok_hand', emoji: '👌' },
	{ shortcode: 'v', emoji: '✌️', aliases: ['peace'] },
	{ shortcode: 'crossed_fingers', emoji: '🤞', aliases: ['luck'] },
	{ shortcode: 'raised_hands', emoji: '🙌', aliases: ['hooray'] },
	{ shortcode: 'clap', emoji: '👏', aliases: ['applause'] },
	{ shortcode: 'pray', emoji: '🙏', aliases: ['please', 'thanks', 'highfive'] },
	{ shortcode: 'handshake', emoji: '🤝', aliases: ['deal'] },
	{ shortcode: 'muscle', emoji: '💪', aliases: ['strong'] },
	{ shortcode: 'wave', emoji: '👋', aliases: ['hello', 'bye'] },
	{ shortcode: 'point_up', emoji: '☝️' },
	{ shortcode: 'point_right', emoji: '👉' },
	{ shortcode: 'point_left', emoji: '👈' },
	{ shortcode: 'point_down', emoji: '👇' },
	{ shortcode: 'raised_hand', emoji: '✋', aliases: ['stop'] },
	{ shortcode: 'facepalm', emoji: '🤦' },
	{ shortcode: 'shrug', emoji: '🤷' },
	{ shortcode: 'eyes', emoji: '👀', aliases: ['look'] },
	{ shortcode: 'brain', emoji: '🧠' },
	{ shortcode: 'heart', emoji: '❤️', aliases: ['love'] },
	{ shortcode: 'orange_heart', emoji: '🧡' },
	{ shortcode: 'yellow_heart', emoji: '💛' },
	{ shortcode: 'green_heart', emoji: '💚' },
	{ shortcode: 'blue_heart', emoji: '💙' },
	{ shortcode: 'purple_heart', emoji: '💜' },
	{ shortcode: 'black_heart', emoji: '🖤' },
	{ shortcode: 'broken_heart', emoji: '💔' },
	{ shortcode: 'sparkling_heart', emoji: '💖' },
	{ shortcode: 'fire', emoji: '🔥', aliases: ['lit', 'hot'] },
	{ shortcode: 'sparkles', emoji: '✨', aliases: ['new'] },
	{ shortcode: 'star', emoji: '⭐' },
	{ shortcode: 'zap', emoji: '⚡', aliases: ['lightning'] },
	{ shortcode: 'boom', emoji: '💥' },
	{ shortcode: 'tada', emoji: '🎉', aliases: ['party', 'celebrate', 'congrats'] },
	{ shortcode: 'confetti_ball', emoji: '🎊' },
	{ shortcode: 'balloon', emoji: '🎈' },
	{ shortcode: 'gift', emoji: '🎁', aliases: ['present'] },
	{ shortcode: 'trophy', emoji: '🏆', aliases: ['win'] },
	{ shortcode: 'medal', emoji: '🏅' },
	{ shortcode: 'dart', emoji: '🎯', aliases: ['target', 'goal'] },
	{ shortcode: 'rocket', emoji: '🚀', aliases: ['launch', 'ship'] },
	{ shortcode: '100', emoji: '💯' },
	{ shortcode: 'white_check_mark', emoji: '✅', aliases: ['done', 'check'] },
	{ shortcode: 'heavy_check_mark', emoji: '✔️', aliases: ['check'] },
	{ shortcode: 'x', emoji: '❌', aliases: ['no', 'cross'] },
	{ shortcode: 'warning', emoji: '⚠️', aliases: ['careful'] },
	{ shortcode: 'no_entry', emoji: '⛔' },
	{ shortcode: 'question', emoji: '❓' },
	{ shortcode: 'exclamation', emoji: '❗' },
	{ shortcode: 'bulb', emoji: '💡', aliases: ['idea'] },
	{ shortcode: 'memo', emoji: '📝', aliases: ['note', 'pencil'] },
	{ shortcode: 'pushpin', emoji: '📌', aliases: ['pin'] },
	{ shortcode: 'paperclip', emoji: '📎', aliases: ['attach'] },
	{ shortcode: 'link', emoji: '🔗' },
	{ shortcode: 'mag', emoji: '🔍', aliases: ['search'] },
	{ shortcode: 'lock', emoji: '🔒' },
	{ shortcode: 'key', emoji: '🔑' },
	{ shortcode: 'bell', emoji: '🔔', aliases: ['notification'] },
	{ shortcode: 'email', emoji: '📧', aliases: ['mail'] },
	{ shortcode: 'calendar', emoji: '📅', aliases: ['date'] },
	{ shortcode: 'chart_with_upwards_trend', emoji: '📈', aliases: ['growth', 'up'] },
	{ shortcode: 'chart_with_downwards_trend', emoji: '📉', aliases: ['down'] },
	{ shortcode: 'bar_chart', emoji: '📊' },
	{ shortcode: 'computer', emoji: '💻', aliases: ['laptop'] },
	{ shortcode: 'iphone', emoji: '📱', aliases: ['phone', 'mobile'] },
	{ shortcode: 'gear', emoji: '⚙️', aliases: ['settings'] },
	{ shortcode: 'wrench', emoji: '🔧', aliases: ['fix'] },
	{ shortcode: 'hammer', emoji: '🔨', aliases: ['build'] },
	{ shortcode: 'bug', emoji: '🐛' },
	{ shortcode: 'package', emoji: '📦' },
	{ shortcode: 'hourglass', emoji: '⌛', aliases: ['wait', 'time'] },
	{ shortcode: 'alarm_clock', emoji: '⏰' },
	{ shortcode: 'moneybag', emoji: '💰', aliases: ['money'] },
	{ shortcode: 'dollar', emoji: '💵', aliases: ['money'] },
	{ shortcode: 'credit_card', emoji: '💳' },
	{ shortcode: 'coffee', emoji: '☕' },
	{ shortcode: 'pizza', emoji: '🍕' },
	{ shortcode: 'beer', emoji: '🍺' },
	{ shortcode: 'beers', emoji: '🍻', aliases: ['cheers'] },
	{ shortcode: 'cake', emoji: '🍰' },
	{ shortcode: 'cookie', emoji: '🍪' },
	{ shortcode: 'apple', emoji: '🍎' },
	{ shortcode: 'taco', emoji: '🌮' },
	{ shortcode: 'sunny', emoji: '☀️', aliases: ['sun'] },
	{ shortcode: 'cloud', emoji: '☁️' },
	{ shortcode: 'rainbow', emoji: '🌈' },
	{ shortcode: 'umbrella', emoji: '☔', aliases: ['rain'] },
	{ shortcode: 'snowflake', emoji: '❄️', aliases: ['cold'] },
	{ shortcode: 'earth_africa', emoji: '🌍', aliases: ['world', 'globe'] },
	{ shortcode: 'seedling', emoji: '🌱', aliases: ['plant'] },
	{ shortcode: 'evergreen_tree', emoji: '🌲', aliases: ['tree'] },
	{ shortcode: 'rose', emoji: '🌹', aliases: ['flower'] },
	{ shortcode: 'dog', emoji: '🐶' },
	{ shortcode: 'cat', emoji: '🐱' },
	{ shortcode: 'unicorn', emoji: '🦄' },
	{ shortcode: 'penguin', emoji: '🐧' },
	{ shortcode: 'turtle', emoji: '🐢' },
	{ shortcode: 'snail', emoji: '🐌' },
	{ shortcode: 'bee', emoji: '🐝' },
	{ shortcode: 'butterfly', emoji: '🦋' },
	{ shortcode: 'eagle', emoji: '🦅' },
	{ shortcode: 'house', emoji: '🏠', aliases: ['home'] },
	{ shortcode: 'office', emoji: '🏢' },
	{ shortcode: 'car', emoji: '🚗' },
	{ shortcode: 'airplane', emoji: '✈️', aliases: ['plane', 'flight'] },
	{ shortcode: 'checkered_flag', emoji: '🏁', aliases: ['finish'] },
	{ shortcode: 'soccer', emoji: '⚽', aliases: ['football'] },
	{ shortcode: 'video_game', emoji: '🎮', aliases: ['game'] },
	{ shortcode: 'musical_note', emoji: '🎵', aliases: ['music'] },
	{ shortcode: 'headphones', emoji: '🎧' },
	{ shortcode: 'books', emoji: '📚' },
	{ shortcode: 'art', emoji: '🎨' },
	{ shortcode: 'tools', emoji: '🛠️' },
	{ shortcode: 'shield', emoji: '🛡️', aliases: ['security'] },
	{ shortcode: 'white_flag', emoji: '🏳️' },
	{ shortcode: 'red_circle', emoji: '🔴' },
	{ shortcode: 'large_blue_circle', emoji: '🔵' },
	{ shortcode: 'green_circle', emoji: '🟢' },
	{ shortcode: 'yellow_circle', emoji: '🟡' },
	{ shortcode: 'arrow_right', emoji: '➡️' },
	{ shortcode: 'arrow_left', emoji: '⬅️' },
	{ shortcode: 'arrow_up', emoji: '⬆️' },
	{ shortcode: 'arrow_down', emoji: '⬇️' },
	{ shortcode: 'repeat', emoji: '🔁', aliases: ['loop'] },
	{ shortcode: 'recycle', emoji: '♻️' },
]

/** How many rows the picker lists at once. */
export const EMOJI_MAX_RESULTS = 8

/** Fewest characters after the colon before the list opens ("::" and ":a" stay plain text). */
export const EMOJI_MIN_QUERY = 2

/**
 * Case-insensitive match on the shortcode and the aliases. Shortcodes that
 * start with the query come first, then shortcodes that contain it, then
 * alias matches, each group in list order. Only the typed text counts: a space
 * is not turned into an underscore.
 */
export function filterEmoji(
	query: string,
	items: readonly EmojiItem[] = EMOJI_ITEMS,
	limit = EMOJI_MAX_RESULTS,
): EmojiItem[] {
	const q = query.trim().toLowerCase()
	if (q.length < EMOJI_MIN_QUERY) return []
	const starts: EmojiItem[] = []
	const contains: EmojiItem[] = []
	const byAlias: EmojiItem[] = []
	for (const item of items) {
		if (item.shortcode.startsWith(q)) starts.push(item)
		else if (item.shortcode.includes(q)) contains.push(item)
		else if (item.aliases?.some((alias) => alias.includes(q))) byAlias.push(item)
	}
	return [...starts, ...contains, ...byAlias].slice(0, limit)
}

/** What the injected view gets on every suggestion update. */
export interface EmojiMenuState {
	query: string
	items: EmojiItem[]
	/** Caret rectangle for anchoring. Null when the decoration is not on screen. */
	clientRect: (() => DOMRect | null) | null
	/** Swap the typed ":query" for the emoji and close the list. */
	select: (item: EmojiItem) => void
	/** Close the list and keep the typed text, as Escape does. */
	dismiss: () => void
}

export interface EmojiMenuView {
	update: (state: EmojiMenuState) => void
	/** Return true when the view consumed the key. */
	onKeyDown: (event: KeyboardEvent) => boolean
	destroy: () => void
}

export interface EmojiSuggestionOptions {
	createView: (state: EmojiMenuState) => EmojiMenuView
	/** Fires once per inserted emoji, after it went in. */
	onEmojiPicked?: (shortcode: string) => void
}

export interface EmojiSuggestionStorage {
	/** Start of a colon the person dismissed; it stays closed until that colon goes. */
	dismissedFrom: number | null
}

const pluginKey = new PluginKey('emojiSuggestion')

function isInsideCode(state: EditorState, from: number): boolean {
	const $from = state.doc.resolve(from)
	return $from.parent.type.spec.code === true || $from.marks().some((m) => m.type.name === 'code')
}

function insertEmoji(editor: Editor, range: Range, item: EmojiItem) {
	editor.chain().focus().deleteRange(range).insertContent(item.emoji).run()
}

/**
 * Its own plugin key and storage name, so it sits next to the slash menu and
 * the mention extension in one editor without either closing the other.
 */
export const EmojiSuggestion = Extension.create<EmojiSuggestionOptions, EmojiSuggestionStorage>({
	name: 'emojiSuggestion',

	addOptions() {
		return {
			createView: () => {
				throw new Error('EmojiSuggestion needs a createView option')
			},
			onEmojiPicked: undefined,
		}
	},

	addStorage() {
		return { dismissedFrom: null }
	},

	onTransaction({ transaction }) {
		if (this.storage.dismissedFrom === null || !transaction.docChanged) return
		const from = transaction.mapping.map(this.storage.dismissedFrom)
		this.storage.dismissedFrom = from
		// The dismissed colon is gone: forget it, so a new ":" typed in the same
		// place opens the list again.
		const doc = this.editor.state.doc
		const stillThere = from < doc.content.size && doc.textBetween(from, from + 1, '\n') === ':'
		if (!stillThere) this.storage.dismissedFrom = null
	},

	addProseMirrorPlugins() {
		const { editor, storage, options } = this
		let view: EmojiMenuView | null = null

		const dismiss = (from: number) => {
			storage.dismissedFrom = from
			// An empty transaction re-runs the plugin's `allow` check, which now
			// refuses this colon and so closes the list.
			editor.view.dispatch(editor.state.tr)
		}

		return [
			Suggestion<EmojiItem>({
				editor,
				pluginKey,
				char: ':',
				// Start of a block or after whitespace: "12:30" and "https://" must not open it.
				allowedPrefixes: [' ', ' '],
				allowSpaces: false,
				allow: ({ state, range }) => {
					if (range.from === storage.dismissedFrom) return false
					return !isInsideCode(state, range.from)
				},
				items: ({ query }) => filterEmoji(query),
				command: ({ editor: e, range, props }) => insertEmoji(e, range, props),
				render: () => {
					const stateFor = (props: SuggestionProps<EmojiItem>): EmojiMenuState => ({
						query: props.query,
						items: props.items,
						clientRect: props.clientRect ?? null,
						select: (item) => {
							insertEmoji(editor, props.range, item)
							options.onEmojiPicked?.(item.shortcode)
						},
						dismiss: () => dismiss(props.range.from),
					})
					return {
						onStart: (props) => {
							// No match: nothing to show, and no empty box either.
							if (props.items.length === 0) return
							view = options.createView(stateFor(props))
						},
						onUpdate: (props) => {
							if (props.items.length === 0) {
								view?.destroy()
								view = null
								return
							}
							if (view) view.update(stateFor(props))
							else view = options.createView(stateFor(props))
						},
						onKeyDown: ({ event }) => view?.onKeyDown(event) ?? false,
						onExit: () => {
							view?.destroy()
							view = null
						},
					}
				},
			}),
		]
	},
})
