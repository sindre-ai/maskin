import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Spec 7 §5 long-press actions, built on the system context menu (blur, haptic, a preview of the
/// bubble clamped to six lines, 44pt rows). All messages: Reply · Copy · Pin/Unpin. Your newest:
/// Edit. Agent messages: Try again · Make it shorter · Good answer · Not right. No reaction strip:
/// the API carries no reactions. A top-level message also offers Reply in thread.
struct MessageMenuActions {
	var onReply: (() -> Void)?
	/// Opens (or starts) the thread under this message.
	var onThread: (() -> Void)?
	/// Add or take back one of the quick emoji; `reacted` are the ones you already used.
	var onReact: ((String) -> Void)?
	var reacted: Set<String> = []
	var onCopy: (() -> Void)?
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

	/// The row titles in order, for tests and accessibility.
	var titles: [String] {
		var out: [String] = []
		if onReply != nil { out.append("Reply") }
		if onThread != nil { out.append("Reply in thread") }
		if onCopy != nil { out.append("Copy") }
		if onPin != nil { out.append(isPinned ? "Unpin" : "Pin") }
		if onEdit != nil { out.append("Edit") }
		if onTryAgain != nil { out.append("Try again") }
		if onShorter != nil { out.append("Make it shorter") }
		if onGoodAnswer != nil { out.append("Good answer") }
		if onNotRight != nil { out.append("Not right") }
		if onRetrySend != nil { out.append("Retry") }
		if onDiscard != nil { out.append("Delete") }
		if onReadAloud != nil { out.append(readAloudTitle) }
		return out
	}
}

struct MessageMenuItems: View {
	let actions: MessageMenuActions

	var body: some View {
		if let onReply = actions.onReply {
			Button(action: onReply) { Label("Reply", systemImage: "arrowshape.turn.up.left") }
		}
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

/// The bubble as the menu shows it: the text clamped to six lines, in the bubble's own colours.
struct MessagePreview: View {
	let message: ChatMessage
	let isOwn: Bool

	var body: some View {
		Text(ChatPreviewText.plain(message.content).isEmpty ? "Attachment" : ChatPreviewText.plain(message.content))
			.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
			.lineSpacing(BubbleShape.lineSpacing)
			.foregroundStyle(isOwn ? MaskinSurface.onInverse : MaskinColor.ink2)
			.padding(.vertical, isOwn ? BubbleShape.myVertical : BubbleShape.theirVertical)
			.padding(.horizontal, BubbleShape.horizontal)
			.background(isOwn ? MaskinSurface.inverse : MaskinSurface.card)
			.clipShape(isOwn ? BubbleShape.mine : BubbleShape.agent)
			.padding(MaskinSpace.s4)
	}
}

extension View {
	/// Long-press (the system's 400ms-class press) opens the actions with a preview of the bubble.
	func messageContextMenu(_ message: ChatMessage, isOwn: Bool, actions: MessageMenuActions) -> some View {
		contextMenu {
			MessageMenuItems(actions: actions)
		} preview: {
			MessagePreview(message: message, isOwn: isOwn)
		}
	}
}
