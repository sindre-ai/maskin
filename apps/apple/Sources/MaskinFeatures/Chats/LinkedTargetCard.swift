import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The card for a linked target once it is known to deserve one; nothing while it is not. An object
/// link shows a placeholder while its lookup is out.
struct LinkedTargetCard: View {
	let target: LinkedTarget
	var defaultExpanded = false
	var onApproved: (_ title: String?, _ body: String) -> Void = { _, _ in }
	/// A draft's Skip: tells the agent not to send it. Nil draws no Skip button.
	var onSkipped: (() -> Void)?
	/// A person already skipped this draft (read from the chat), so the card says so after a reload.
	var skipped = false
	/// The question the agent posted with this draft, drawn inside the card in place of a second card.
	var askNote: DraftQuestionNote?
	/// An object with text is a card that edits it and moves its status: alone on its line, and the
	/// first one under a message. `chat` is the agent behind the message, told of an edit.
	var editable = false
	var chat: ObjectPatchChat?
	@Environment(\.linkedItems) private var store

	var body: some View {
		switch store?.item(for: target) {
		case .draft(let object, let preview)?:
			LinkedDraftCard(
				object: object, preview: preview, defaultExpanded: defaultExpanded, skippedInChat: skipped,
				askNote: askNote, onApproved: onApproved, onSkipped: onSkipped)
		case .file(let file)?:
			LinkedFileCard(file: file, defaultExpanded: defaultExpanded)
		case .object(let object)?:
			LinkedObjectCard(object: object, editable: editable, chat: chat)
		case .loop(let loop)?:
			LinkedLoopCard(loop: loop)
		case .trigger(let trigger)?:
			LinkedTriggerCard(trigger: trigger)
		case .deleted?:
			LinkedDeletedCard(kind: Self.deletedKind(of: target))
		case .otherWorkspace(let link)?:
			LinkedOtherWorkspaceCard(link: link)
		case .agent(let agent)?:
			LinkedAgentCard(agent: agent)
		case .chat(let chat)?:
			LinkedChatCard(chat: chat)
		case .chatUnavailable?:
			LinkedDeletedCard(kind: "chat", symbol: "message", text: "Chat not available")
		default:
			if target.kind != .file, store?.showsCard(target) == true { LinkedCardSkeleton() }
		}
	}

	/// "loop", "trigger" or "object": what the deleted card says was deleted.
	private static func deletedKind(of target: LinkedTarget) -> String {
		switch target.kind {
		case .loop: "loop"
		case .trigger: "trigger"
		case .object, .file, .agent, .chat: "object"
		}
	}
}
