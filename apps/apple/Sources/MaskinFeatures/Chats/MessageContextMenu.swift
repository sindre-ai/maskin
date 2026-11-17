import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Spec 7 §5 message actions, opened from the "More" button beside the bubble (a long-press on the
/// words selects them instead). All messages: Copy · Pin/Unpin. Your newest: Edit. Agent messages:
/// Try again · Make it shorter · Good answer · Not right. No reaction strip: the API carries no
/// reactions. A top-level message also offers Reply in thread.
struct MessageMenuActions {
	/// Opens (or starts) the thread under this message.
	var onThread: (() -> Void)?
	/// Add or take back one of the quick emoji; `reacted` are the ones you already used.
	var onReact: ((String) -> Void)?
	var reacted: Set<String> = []
	var onCopy: (() -> Void)?
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

	/// Runs the action behind a row.
	func run(_ item: MessageMenuItem) {
		switch item {
		case .thread: onThread?()
		case .copy: onCopy?()
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
	case thread, copy, openAgent, pin, edit, tryAgain, shorter, goodAnswer, notRight, retrySend,
		discard, readAloud
}

struct MessageMenuItems: View {
	let actions: MessageMenuActions

	var body: some View {
		if let onReact = actions.onReact {
			Menu {
				ForEach(MessageReaction.quick, id: \.self) { emoji in
					Button { onReact(emoji) } label: {
						Text(actions.reacted.contains(emoji) ? "\(emoji)  ✓" : emoji)
					}
				}
			} label: {
				Label("React", systemImage: "face.smiling")
			}
		}
		if let onThread = actions.onThread {
			Button(action: onThread) { Label("Reply in thread", systemImage: "bubble.left.and.text.bubble.right") }
		}
		if let onCopy = actions.onCopy {
			Button(action: onCopy) { Label("Copy", systemImage: "doc.on.doc") }
		}
		if let onOpenAgent = actions.onOpenAgent {
			Button(action: onOpenAgent) { Label(actions.openAgentTitle, systemImage: "person.crop.circle") }
		}
		if let onPin = actions.onPin {
			Button(action: onPin) {
				Label(actions.isPinned ? "Unpin" : "Pin", systemImage: actions.isPinned ? "pin.slash" : "pin")
			}
		}
		if let onEdit = actions.onEdit {
			Button(action: onEdit) { Label("Edit", systemImage: "pencil") }
		}
		if actions.onTryAgain != nil || actions.onShorter != nil {
			Divider()
		}
		if let onTryAgain = actions.onTryAgain {
			Button(action: onTryAgain) { Label("Try again", systemImage: "arrow.clockwise") }
		}
		if let onShorter = actions.onShorter {
			Button(action: onShorter) { Label("Make it shorter", systemImage: "text.alignleft") }
		}
		if let onGoodAnswer = actions.onGoodAnswer {
			Button(action: onGoodAnswer) {
				Label("Good answer", systemImage: actions.feedback == .good ? "hand.thumbsup.fill" : "hand.thumbsup")
			}
		}
		if let onNotRight = actions.onNotRight {
			Button(action: onNotRight) {
				Label("Not right", systemImage: actions.feedback == .notRight ? "hand.thumbsdown.fill" : "hand.thumbsdown")
			}
		}
		if actions.onRetrySend != nil || actions.onDiscard != nil {
			Divider()
		}
		if let onRetrySend = actions.onRetrySend {
			Button(action: onRetrySend) { Label("Retry", systemImage: "arrow.clockwise") }
		}
		if let onDiscard = actions.onDiscard {
			Button(role: .destructive, action: onDiscard) { Label("Delete", systemImage: "trash") }
		}
		if let onReadAloud = actions.onReadAloud {
			Divider()
			Button(action: onReadAloud) { Label(actions.readAloudTitle, systemImage: "speaker.wave.2") }
		}
	}
}

/// The "More" button beside a bubble. It opens the message menu, so a long-press on the words is
/// free to select them.
struct MessageMoreButton: View {
	let actions: MessageMenuActions

	var body: some View {
		Menu {
			MessageMenuItems(actions: actions)
		} label: {
			Image(systemName: "ellipsis")
				.maskinSymbol(MaskinFontSize.t14, weight: .semibold)
				.foregroundStyle(MaskinColor.ink4)
				.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
				.contentShape(Rectangle())
		}
		.accessibilityLabel("More")
	}
}

extension View {
	/// Puts the "More" button beside the bubble (before it for your own, after it for theirs), and
	/// leaves the bubble's own words to the system's long-press selection.
	@ViewBuilder
	func messageMoreMenu(actions: MessageMenuActions, isOwn: Bool) -> some View {
		if actions.hasItems {
			HStack(alignment: .top, spacing: 0) {
				if isOwn { MessageMoreButton(actions: actions) }
				self
				if !isOwn { MessageMoreButton(actions: actions) }
			}
		} else {
			self
		}
	}
}
