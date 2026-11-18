import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Spec 7 §5 message actions, opened by a long-press on a message as a bottom sheet (the quick
/// reactions, then Reply in thread and Copy as tiles, then the rest in groups, Delete last). All
/// messages: Copy · Select text · Pin/Unpin. Your newest: Edit. Agent messages: Try again · Make it
/// shorter · Good answer · Not right. A top-level message also offers Reply in thread.
struct MessageMenuActions {
	/// Opens (or starts) the thread under this message.
	var onThread: (() -> Void)?
	/// Add or take back one of the quick emoji; `reacted` are the ones you already used.
	var onReact: ((String) -> Void)?
	var reacted: Set<String> = []
	var onCopy: (() -> Void)?
	/// Opens the message's text in a sheet where single words can be selected.
	var onSelectText: (() -> Void)?
	/// Opens the agent that wrote this message. An agent's words have no avatar or name row to
	/// tap, so the long-press menu is how every one of them reaches the agent's page.
	var onOpenAgent: (() -> Void)?
	var openAgentTitle = "Open agent"
	var onPin: (() -> Void)?
	var isPinned = false
	var onEdit: (() -> Void)?
	var onTryAgain: (() -> Void)?
	var onShorter: (() -> Void)?
	var onGoodAnswer: (() -> Void)?
	var onNotRight: (() -> Void)?
	var onRetrySend: (() -> Void)?
	var onDiscard: (() -> Void)?
	var onReadAloud: (() -> Void)?
	var readAloudTitle = "Read aloud"
	var feedback: MessageOverride.Feedback?

	/// The rows in order, each with its own identity, so a title is only a label: an agent whose
	/// name happens to read like an action ("Copy") cannot be mistaken for that action.
	var entries: [(item: MessageMenuItem, title: String)] {
		var out: [(MessageMenuItem, String)] = []
		if onThread != nil { out.append((.thread, "Reply in thread")) }
		if onCopy != nil { out.append((.copy, "Copy")) }
		if onSelectText != nil { out.append((.selectText, "Select text")) }
		if onOpenAgent != nil { out.append((.openAgent, openAgentTitle)) }
		if onPin != nil { out.append((.pin, isPinned ? "Unpin" : "Pin")) }
		if onEdit != nil { out.append((.edit, "Edit")) }
		if onTryAgain != nil { out.append((.tryAgain, "Try again")) }
		if onShorter != nil { out.append((.shorter, "Make it shorter")) }
		if onGoodAnswer != nil { out.append((.goodAnswer, "Good answer")) }
		if onNotRight != nil { out.append((.notRight, "Not right")) }
		if onRetrySend != nil { out.append((.retrySend, "Retry")) }
		if onDiscard != nil { out.append((.discard, "Delete")) }
		if onReadAloud != nil { out.append((.readAloud, readAloudTitle)) }
		return out
	}

	/// The row titles in order, for tests and accessibility.
	var titles: [String] { entries.map(\.title) }

	/// Whether the menu has anything to show (the reaction row is not one of `entries`).
	var hasItems: Bool { !entries.isEmpty || onReact != nil }

	/// The two large tiles at the top of the sheet: the main actions, when the message offers them.
	var tiles: [(item: MessageMenuItem, title: String)] {
		entries.filter { $0.item == .thread || $0.item == .copy }
	}

	/// The rest of the rows, in groups drawn with a thin line between them. Delete and Retry are
	/// the last group; an empty group never leaves a stray line.
	var groups: [[(item: MessageMenuItem, title: String)]] {
		let tiled = Set(tiles.map(\.item))
		let rest = entries.filter { !tiled.contains($0.item) }
		let groupOf: (MessageMenuItem) -> Int = { item in
			switch item {
			case .selectText, .openAgent, .pin, .edit, .readAloud: return 0
			case .tryAgain, .shorter, .goodAnswer, .notRight: return 1
			case .retrySend, .discard: return 2
			case .thread, .copy: return 0
			}
		}
		return (0...2).map { g in rest.filter { groupOf($0.item) == g } }.filter { !$0.isEmpty }
	}

	/// Runs the action behind a row.
	func run(_ item: MessageMenuItem) {
		switch item {
		case .thread: onThread?()
		case .copy: onCopy?()
		case .selectText: onSelectText?()
		case .openAgent: onOpenAgent?()
		case .pin: onPin?()
		case .edit: onEdit?()
		case .tryAgain: onTryAgain?()
		case .shorter: onShorter?()
		case .goodAnswer: onGoodAnswer?()
		case .notRight: onNotRight?()
		case .retrySend: onRetrySend?()
		case .discard: onDiscard?()
		case .readAloud: onReadAloud?()
		}
	}
}

/// What a long-press menu row does, independent of the words on it.
enum MessageMenuItem: Hashable {
	case thread, copy, selectText, openAgent, pin, edit, tryAgain, shorter, goodAnswer, notRight, retrySend,
		discard, readAloud
}

/// The long-press sheet: a grab handle, the quick reactions, two tiles, then rows with an icon and
/// a label in groups. What a person chose runs once the sheet has closed, so an action that opens
/// another sheet or screen (Select text, Edit, Reply in thread) is not fighting this one.
struct MessageActionSheet: View {
	let actions: MessageMenuActions
	let onChoose: (MessageMenuChoice) -> Void

	var body: some View {
		ScrollView {
			VStack(spacing: MaskinSpace.s7) {
				if actions.onReact != nil { reactionRow }
				if !actions.tiles.isEmpty { tileRow }
				ForEach(Array(actions.groups.enumerated()), id: \.offset) { index, group in
					if index > 0 || !actions.tiles.isEmpty || actions.onReact != nil {
						Rectangle().fill(MaskinSurface.separator).frame(height: 1)
					}
					VStack(spacing: 0) {
						ForEach(group, id: \.item) { entry in row(entry.item, entry.title) }
					}
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.top, MaskinSpace.s9)
			.padding(.bottom, MaskinSpace.s12)
		}
		#if os(iOS)
		.presentationDetents([.medium, .large])
		.presentationDragIndicator(.visible)
		.presentationCornerRadius(MaskinRadius.card2xl)
		.presentationBackground(MaskinSurface.card)
		#endif
	}

	private var reactionRow: some View {
		HStack(spacing: 0) {
			ForEach(MessageReaction.quick, id: \.self) { emoji in
				let reacted = actions.reacted.contains(emoji)
				Button { onChoose(.react(emoji)) } label: {
					Text(emoji)
						.maskinSymbol(MaskinFontSize.t24)
						.frame(width: MaskinSpace.touchMin + MaskinSpace.s3, height: MaskinSpace.touchMin + MaskinSpace.s3)
						.background(reacted ? MaskinSurface.fillStrong : MaskinSurface.fill, in: Circle())
						.overlay { if reacted { Circle().stroke(MaskinColor.ink4, lineWidth: 1.5) } }
				}
				.buttonStyle(.plain)
				.accessibilityLabel(reacted ? "Remove \(emoji)" : "React \(emoji)")
				.frame(maxWidth: .infinity)
			}
		}
	}

	private var tileRow: some View {
		HStack(spacing: MaskinSpace.s7) {
			ForEach(actions.tiles, id: \.item) { entry in
				Button { onChoose(.item(entry.item)) } label: {
					VStack(spacing: MaskinSpace.s4) {
						Image(systemName: Self.symbol(entry.item, actions: actions))
							.maskinSymbol(MaskinFontSize.t24)
						Text(entry.title).maskinText(.subhead).fontWeight(.semibold)
					}
					.foregroundStyle(MaskinColor.ink)
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin * 2)
					.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				}
				.buttonStyle(.plain)
			}
		}
	}

	private func row(_ item: MessageMenuItem, _ title: String) -> some View {
		let destructive = item == .discard
		return Button { onChoose(.item(item)) } label: {
			HStack(spacing: MaskinSpace.s9) {
				Image(systemName: Self.symbol(item, actions: actions))
					.maskinSymbol(MaskinFontSize.t18)
					.frame(width: MaskinSpace.s13)
				Text(title).maskinText(.body)
				Spacer(minLength: 0)
			}
			.foregroundStyle(destructive ? MaskinColor.danger : MaskinColor.ink)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
	}

	static func symbol(_ item: MessageMenuItem, actions: MessageMenuActions) -> String {
		switch item {
		case .thread: "bubble.left.and.text.bubble.right"
		case .copy: "doc.on.doc"
		case .selectText: "text.cursor"
		case .openAgent: "person.crop.circle"
		case .pin: actions.isPinned ? "pin.slash" : "pin"
		case .edit: "pencil"
		case .tryAgain, .retrySend: "arrow.clockwise"
		case .shorter: "text.alignleft"
		case .goodAnswer: actions.feedback == .good ? "hand.thumbsup.fill" : "hand.thumbsup"
		case .notRight: actions.feedback == .notRight ? "hand.thumbsdown.fill" : "hand.thumbsdown"
		case .discard: "trash"
		case .readAloud: "speaker.wave.2"
		}
	}
}

/// What a person picked in the sheet.
enum MessageMenuChoice: Equatable {
	case item(MessageMenuItem)
	case react(String)
}

private struct MessageActionSheetModifier: ViewModifier {
	let actions: MessageMenuActions
	@State private var showing = false
	@State private var chosen: MessageMenuChoice?

	func body(content: Content) -> some View {
		if actions.hasItems {
			content
				// Only a held press opens the sheet; a tap on a link or a card goes straight through.
				.onLongPressGesture(minimumDuration: 0.4) {
					MaskinHaptics.play(.medium)
					showing = true
				}
				.sheet(isPresented: $showing, onDismiss: runChoice) {
					MessageActionSheet(actions: actions) { choice in
						chosen = choice
						showing = false
					}
				}
		} else {
			content
		}
	}

	private func runChoice() {
		guard let choice = chosen else { return }
		chosen = nil
		switch choice {
		case .item(let item): actions.run(item)
		case .react(let emoji): actions.onReact?(emoji)
		}
	}
}

extension View {
	/// A long-press on the message opens the action sheet. Words are selected from its Select text row.
	func messageActionSheet(actions: MessageMenuActions) -> some View {
		modifier(MessageActionSheetModifier(actions: actions))
	}
}
