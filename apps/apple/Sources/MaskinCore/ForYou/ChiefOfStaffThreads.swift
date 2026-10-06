import Foundation

/// The three questions a For You card offers under its composer. They are plain text sent as the
/// reader's own message: the real agent answers, nothing here pretends to.
public enum ForYouQuickQuestions {
	public static func chips(for card: ForYouCard) -> [String] {
		if let decision = card.decision {
			let why = decision.recommended.map { "Why \($0.label)?" } ?? "Why is this needed?"
			return [why, "What if I wait?", "Explain this simply"]
		}
		return ["Summarise this", "What do you need from me?", "Explain this simply"]
	}
}

/// Finds or opens the reader's conversation with the Chief of Staff about one card's object, so a
/// reply or quick question from For You lands in a real chat the agent answers in.
@MainActor
public enum ChiefOfStaffThreads {
	public enum Outcome: Equatable {
		/// A new conversation, already carrying the first message.
		case created(ConversationSummary)
		/// A conversation from an earlier reply about the same object; the caller sends into it.
		case existing(ConversationSummary)

		public var conversation: ConversationSummary {
			switch self {
			case .created(let c), .existing(let c): c
			}
		}
	}

	public struct NoChiefOfStaff: Error, Equatable {}

	public static func isChiefOfStaff(_ actor: ChatActor) -> Bool {
		actor.isSystem && actor.participant.kind == .agent && actor.participant.name == "Chief of Staff"
	}

	/// "About: <object>": what the sheet header shows and what finds the thread again.
	public static func title(for card: ForYouCard) -> String {
		"About: \(card.objectTitle?.trimmed.nonEmpty ?? card.headline)"
	}

	/// The first message of a new thread names the object, since the agent reads only the text.
	public static func firstMessage(_ text: String, about card: ForYouCard) -> String {
		let subject = card.objectTitle?.trimmed.nonEmpty ?? card.headline
		return "Re: \(subject)\n\n\(text)"
	}

	/// The thread to send into. A new one is created empty: the caller sends the first message
	/// through the chat store, so attachments and @mentions travel the same way as in Chats.
	/// `alsoInvite` are the actors @-tagged in the message; they join a new thread.
	public static func open(
		about card: ForYouCard, alsoInvite: [String] = [], conversations: ConversationsStore
	) async throws -> Outcome {
		await conversations.loadActors()
		guard let chief = conversations.actors.first(where: isChiefOfStaff) else { throw NoChiefOfStaff() }
		await conversations.refresh()
		let title = title(for: card)
		if let found = conversations.conversations.first(where: {
			$0.title == title && !$0.archived && $0.participants.contains { $0.id == chief.id }
		}) {
			return .existing(found)
		}
		let invited = alsoInvite.filter { $0 != chief.id }
		let created = try await conversations.create(
			title: title, participantIDs: [chief.id] + invited, firstMessage: nil)
		return .created(created)
	}
}

/// What For You's cards share for talking to the Chief of Staff: one composer model per card, the
/// conversation list used to find the thread, and the thread currently open in the pop-up sheet.
@MainActor
@Observable
public final class ChiefOfStaffDesk {
	public struct Pending: Equatable {
		public var text: String
		public var metadata: ChatSendMetadata?
	}

	/// The open pop-up: which thread, which card it is about, and the message still to send.
	public struct Presented: Identifiable, Equatable {
		public var conversationID: String
		public var card: ForYouCard
		public var pending: Pending?
		public var id: String { conversationID }
	}

	public private(set) var presented: Presented?
	public private(set) var isOpening = false
	public var notice: String?

	/// The conversation list and uploader belong to one workspace; they are rebuilt (and every
	/// card draft dropped) when the reader switches workspace, since the runtime outlives that.
	@ObservationIgnored private let workspaceId: () -> String?
	@ObservationIgnored private let make: (String) -> (ConversationsStore, (any ChatFileUploading)?)
	@ObservationIgnored private var current: (workspace: String, store: ConversationsStore, uploader: (any ChatFileUploading)?)?
	@ObservationIgnored public let selfActorID: String
	@ObservationIgnored private var composers: [String: ChatComposerModel] = [:]

	public init(
		workspaceId: @escaping () -> String?,
		make: @escaping (String) -> (ConversationsStore, (any ChatFileUploading)?), selfActorID: String
	) {
		self.workspaceId = workspaceId
		self.make = make
		self.selfActorID = selfActorID
	}

	/// A desk fixed to one workspace, for tests and previews.
	public convenience init(
		conversations: ConversationsStore, uploader: (any ChatFileUploading)?, selfActorID: String
	) {
		self.init(workspaceId: { "w" }, make: { _ in (conversations, uploader) }, selfActorID: selfActorID)
	}

	public var conversations: ConversationsStore {
		let workspace = workspaceId() ?? ""
		if let current, current.workspace == workspace { return current.store }
		let (store, uploader) = make(workspace)
		if current != nil {
			composers = [:]
			presented = nil
		}
		current = (workspace, store, uploader)
		return store
	}

	/// The card's own draft. Kept across re-renders, so typing survives the feed refreshing.
	public func composer(for card: ForYouCard) -> ChatComposerModel {
		if let existing = composers[card.id] { return existing }
		let model = {
			_ = conversations
			return ChatComposerModel(uploader: current?.uploader, selfActorID: selfActorID)
		}()
		composers[card.id] = model
		return model
	}

	/// People and agents the `@` picker offers: everyone in the workspace but the reader.
	public func suggestions(for query: String, excluding taken: Set<String> = []) -> [ChatParticipant] {
		let q = query.lowercased()
		return conversations.actors.map(\.participant)
			.filter { $0.id != selfActorID && !taken.contains($0.id) }
			.filter { q.isEmpty || $0.name.lowercased().hasPrefix(q)
				|| ($0.name.split(separator: " ").first.map { $0.lowercased().hasPrefix(q) } ?? false) }
			.prefix(5).map { $0 }
	}

	/// Sends what is in the card's composer to the Chief of Staff and opens the pop-up. Nothing
	/// here touches the card's decision: a message is never a choice.
	public func submit(card: ForYouCard) async {
		let model = composer(for: card)
		guard let (text, metadata) = model.take() else { return }
		await open(card: card, text: text, metadata: metadata) {
			// Give the words back rather than lose them.
			model.text = text
		}
	}

	/// A quick-question chip: the question goes as the reader's message.
	public func ask(_ question: String, card: ForYouCard) async {
		await open(card: card, text: question, metadata: nil) {}
	}

	private func open(
		card: ForYouCard, text: String, metadata: ChatSendMetadata?, restore: () -> Void
	) async {
		guard !isOpening else { restore(); return }
		isOpening = true
		defer { isOpening = false }
		do {
			let outcome = try await ChiefOfStaffThreads.open(
				about: card, alsoInvite: metadata?.mentions ?? [], conversations: conversations)
			let body: String
			if case .created = outcome { body = ChiefOfStaffThreads.firstMessage(text, about: card) } else { body = text }
			presented = Presented(
				conversationID: outcome.conversation.id, card: card,
				pending: Pending(text: body, metadata: metadata))
		} catch is ChiefOfStaffThreads.NoChiefOfStaff {
			restore()
			notice = "This workspace has no Chief of Staff to message."
		} catch {
			restore()
			notice = "Couldn't open the conversation. \(ChatStore.message(error))"
		}
	}

	/// The message waiting to be sent into the open thread, handed over once.
	public func takePending() -> Pending? {
		guard var current = presented, let pending = current.pending else { return nil }
		current.pending = nil
		presented = current
		return pending
	}

	public func dismiss() { presented = nil }
}
