import Foundation
import Observation

/// What the wrist's conversation with the Chief of Staff decides, kept out of the views so it is
/// testable.
public enum WatchConversation {
	/// The agent's answer to the message sent when the thread's newest server id was `baseline`:
	/// the newest message from `agentID` after it. nil until one has arrived.
	public static func answer(in messages: [ChatMessage], after baseline: Int?, from agentID: String)
		-> ChatMessage?
	{
		messages.last {
			$0.kind == "message" && $0.author == .agent && $0.actorID == agentID
				&& ($0.serverID ?? 0) > (baseline ?? 0)
		}
	}

	/// The pill under Home's microphone: how many decisions wait.
	public static func pill(count: Int) -> String {
		switch count {
		case ..<1: "All clear"
		case 1: "1 needs you"
		default: "\(count) need you"
		}
	}

	/// An answer that asks the wearer something is followed by quick replies.
	public static func asksQuestion(_ text: String) -> Bool {
		text.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("?")
	}

	/// The label over the answer: what the speaker is doing, or why it is not.
	public static func stateLabel(speaking: Bool, muted: Bool, speechAllowed: Bool) -> String {
		if !speechAllowed { return "TEXT ONLY" }
		if muted { return "MUTED" }
		return speaking ? "SPEAKING" : "DONE"
	}

	/// One line on what an agent behind the scenes is doing: the session's own words when it has
	/// them, else a plain word for its state.
	public static func statusLine(activity: String?, presence: ChatAgentPresence) -> String {
		if let activity = activity?.trimmingCharacters(in: .whitespacesAndNewlines), !activity.isEmpty {
			return activity
		}
		switch presence {
		case .working: return "Working"
		case .typing: return "Writing the answer"
		case .replying: return "Reading your message"
		}
	}
}

/// One open thread with the Chief of Staff.
public struct WatchConversationThread {
	public let chat: ChatStore
	public let chiefID: String

	public init(chat: ChatStore, chiefID: String) {
		self.chat = chat
		self.chiefID = chiefID
	}
}

/// The wearer asks, the Chief of Staff answers. One thread ("Watch"), found or created on the first
/// question. The question goes out as the wearer's own message and the answer is the Chief of
/// Staff's next one; nothing here pretends to answer.
@MainActor
@Observable
public final class WatchConversationStore {
	public enum Phase: Equatable, Sendable {
		case idle
		case thinking
		case answered
		case failed(String)
	}

	public struct SignedOut: Error {}

	public private(set) var phase: Phase = .idle
	/// What the wearer said, as sent.
	public private(set) var heard = ""
	public private(set) var answer: ChatMessage?
	public private(set) var thread: WatchConversationThread?

	@ObservationIgnored private let opener: @MainActor () async throws -> WatchConversationThread
	@ObservationIgnored private let timeout: Duration
	@ObservationIgnored private let pollEvery: Duration
	@ObservationIgnored private var task: Task<Void, Never>?

	public init(
		timeout: Duration = .seconds(90), pollEvery: Duration = .milliseconds(600),
		opener: @escaping @MainActor () async throws -> WatchConversationThread
	) {
		self.timeout = timeout
		self.pollEvery = pollEvery
		self.opener = opener
	}

	/// A store that opens the signed-in actor's "Watch" thread with the Chief of Staff.
	public static func live(environment: AppEnvironment) -> WatchConversationStore {
		WatchConversationStore {
			guard let workspace = environment.workspaceId else { throw SignedOut() }
			let session = environment.auth.session
			let api = APIChatsSource(client: environment.client, workspaceID: workspace)
			let conversations = ConversationsStore(api: api, events: nil)
			let outcome = try await ChiefOfStaffThreads.openWatchThread(conversations: conversations)
			guard let chief = conversations.actors.first(where: ChiefOfStaffThreads.isChiefOfStaff)
			else { throw ChiefOfStaffThreads.NoChiefOfStaff() }
			let chat = ChatStore(
				conversationID: outcome.conversation.id, currentActorID: session?.actorId ?? "",
				currentActorName: session?.name ?? "You", api: api,
				queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
				pollInterval: .seconds(2), cache: environment.snapshotCache)
			return WatchConversationThread(chat: chat, chiefID: chief.id)
		}
	}

	/// The question is typed or dictated but the phone line is down: it sits in the outbox and goes
	/// out when the connection is back.
	public var isWaitingToSend: Bool {
		guard let last = thread?.chat.messages.last(where: { $0.author == .human }) else { return false }
		if case .waiting = last.status { return true }
		return false
	}

	/// Ask the Chief of Staff. A question in flight is dropped: the newest one wins.
	public func ask(_ text: String) {
		let spoken = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !spoken.isEmpty else { return }
		task?.cancel()
		heard = spoken
		answer = nil
		phase = .thinking
		task = Task { await run(spoken) }
	}

	/// Back to the start: nothing asked, nothing shown.
	public func reset() {
		task?.cancel()
		task = nil
		phase = .idle
		heard = ""
		answer = nil
	}

	/// Leaving the conversation stops listening to the thread.
	public func stop() {
		reset()
		thread?.chat.stop()
		thread = nil
	}

	private func run(_ spoken: String) async {
		let thread: WatchConversationThread
		do {
			thread = try await open()
		} catch is SignedOut {
			phase = .failed("Sign in to ask.")
			return
		} catch is ChiefOfStaffThreads.NoChiefOfStaff {
			phase = .failed("No Chief of Staff in this workspace.")
			return
		} catch {
			if !Task.isCancelled { phase = .failed("Can't reach Maskin.") }
			return
		}
		let baseline = thread.chat.lastServerID
		guard thread.chat.send(spoken) != nil else {
			phase = .failed("Couldn't send that.")
			return
		}
		let deadline = ContinuousClock.now.advanced(by: timeout)
		while !Task.isCancelled {
			if let reply = WatchConversation.answer(
				in: thread.chat.messages, after: baseline, from: thread.chiefID)
			{
				answer = reply
				phase = .answered
				return
			}
			if ContinuousClock.now >= deadline {
				phase = .failed("No answer yet. Try again.")
				return
			}
			try? await Task.sleep(for: pollEvery)
		}
	}

	private func open() async throws -> WatchConversationThread {
		if let thread { return thread }
		let opened = try await opener()
		await opened.chat.start()
		thread = opened
		return opened
	}
}
