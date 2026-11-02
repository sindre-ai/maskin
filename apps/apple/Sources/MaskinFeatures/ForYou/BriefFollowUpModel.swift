import MaskinCore
import Observation

/// One slide's follow-up chat: opens (or finds) the reader's chat with the Chief of Staff about the
/// slide, sends into it through the normal chat queue and exposes the exchange for the viewer's
/// panel. The viewer resets it on every slide change.
@MainActor
@Observable
final class BriefFollowUpModel {
	var text = ""
	/// A reason the question could not go out, shown under the panel.
	var notice: String?
	private(set) var conversationID: String?
	private(set) var isOpening = false
	private(set) var chat: ChatStore?
	private var firstID: String?

	/// The panel is showing: a question was sent, or is being sent.
	var isOpen: Bool { isOpening || firstID != nil }

	var exchange: [ChatMessage] {
		guard let chat else { return [] }
		return BriefFollowUp.exchange(in: chat.messages, from: firstID)
	}

	var isAwaitingReply: Bool { isOpening || BriefFollowUp.isAwaitingReply(exchange) }

	/// Sends `question` about `slide`. `makeChat` builds the chat store for the resolved thread.
	func ask(
		_ question: String, about slide: StoryCard, desk: ChiefOfStaffDesk?,
		makeChat: (ChiefOfStaffDesk, String) -> ChatStore
	) async {
		let body = question.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !body.isEmpty, !isOpening else { return }
		guard let desk else {
			notice = "This workspace has no Chief of Staff to message."
			return
		}
		isOpening = true
		notice = nil
		defer { isOpening = false }
		do {
			if chat == nil {
				let outcome = try await ChiefOfStaffThreads.open(
					aboutSlide: slide, conversations: desk.conversations)
				let store = makeChat(desk, outcome.conversation.id)
				store.isActive = true
				conversationID = outcome.conversation.id
				chat = store
				await store.start()
				let message: String
				if case .created = outcome { message = BriefFollowUp.firstMessage(body, about: slide) } else { message = body }
				try send(message, on: store)
			} else if let chat {
				try send(body, on: chat)
			}
			text = ""
		} catch is NotSent {
			// `send` already set the reason.
		} catch is ChiefOfStaffThreads.NoChiefOfStaff {
			notice = "This workspace has no Chief of Staff to message."
		} catch {
			notice = "Couldn't open the conversation. \(error.localizedDescription)"
		}
	}

	private struct NotSent: Error {}

	private func send(_ message: String, on store: ChatStore) throws {
		guard let id = store.send(message, metadata: nil) else {
			notice = store.notice
			throw NotSent()
		}
		if firstID == nil { firstID = id }
	}

	/// Leaves the slide: stops the chat's listeners and forgets the panel. The chat itself stays.
	func reset() {
		chat?.isActive = false
		chat?.stop()
		chat = nil
		firstID = nil
		conversationID = nil
		text = ""
		notice = nil
	}
}
