import Foundation
import MaskinCore
import Observation

/// The one live call the app can have, owned by the shell rather than by any screen so it keeps
/// running when you leave the thread, switch tabs or lock the phone. The call lives in a chat
/// thread: the thread shows a banner and a control bar while it is active (`LiveCallViews`), and
/// every other screen shows a small pill that returns to it.
///
/// The call reads and writes through its own `ChatStore` for the conversation, not the thread's:
/// the thread's store stops when its screen goes away, and the call must not.
@MainActor
@Observable
final class LiveCallCenter {
	private(set) var current: LiveMeetingSession?
	/// A request is being resolved (finding the conversation, opening the chat).
	private(set) var isStarting = false
	/// Why a call could not start, shown once.
	var problem: String?
	/// The conversation whose thread is on screen right now, so the pill stays out of its way.
	var visibleConversationID: String?

	/// Opens a conversation's thread (set by the shell: selects the Chats tab and requests it).
	@ObservationIgnored var openConversation: (String) -> Void = { _ in }
	@ObservationIgnored private var ticker: Task<Void, Never>?

	var conversationID: String? { current?.chat.conversationID }

	/// A call in `conversationID`, if that is the one running.
	func session(for conversationID: String) -> LiveMeetingSession? {
		current?.chat.conversationID == conversationID ? current : nil
	}

	/// Start a call for `request`. If one is already running, go to it instead.
	func present(_ request: LiveMeetingRequest, environment: AppEnvironment) {
		if let current {
			if visibleConversationID != current.chat.conversationID {
				openConversation(current.chat.conversationID)
			}
			return
		}
		guard !isStarting else { return }
		isStarting = true
		problem = nil
		Task {
			defer { isStarting = false }
			do {
				let (id, lead, kind, navigate) = try await resolve(request, environment: environment)
				guard let chat = BriefingChat.chatStore(conversationID: id, environment: environment) else {
					throw BriefingChat.Failure(message: "Choose a workspace first.")
				}
				if navigate, visibleConversationID != id { openConversation(id) }
				await chat.start()
				let session = LiveMeetingSession(
					kind: kind, chat: chat, lead: lead, makePorts: LiveMeetingSession.devicePorts,
					realtime: Self.realtimeCall(
						with: lead, conversationID: id, environment: environment))
				current = session
				session.begin()
				startTicker()
			} catch {
				problem = (error as? BriefingChat.Failure)?.message ?? error.localizedDescription
			}
		}
	}

	/// Hang up. The thread (the conversation the call made) comes to the front if it is not already.
	func end() {
		guard let session = current else { return }
		let id = session.chat.conversationID
		session.end()
		session.chat.stop()
		ticker?.cancel()
		ticker = nil
		current = nil
		if visibleConversationID != id { openConversation(id) }
	}

	func toggleMute() { current?.toggleMute() }

	/// The OpenAI Realtime call with the lead agent. Nil when the lead isn't an agent; the call
	/// then runs as a dictated conversation.
	private static func realtimeCall(
		with lead: ChatParticipant, conversationID: String?, environment: AppEnvironment
	) -> RealtimeVoiceCall? {
		guard lead.kind == .agent else { return nil }
		return RealtimeVoiceCall(
			agentID: lead.id, agentName: lead.name, conversationID: conversationID,
			calls: URLSessionVoiceCalls(
				baseURL: environment.baseURL, clientSource: environment.clientSource,
				credentials: environment.auth.credentialsProvider),
			makeTransport: RealtimeVoiceCall.deviceTransport)
	}

	private func resolve(
		_ request: LiveMeetingRequest, environment: AppEnvironment
	) async throws -> (String, ChatParticipant, LiveMeetingKind, navigate: Bool) {
		switch request {
		case .thread(let chat, let lead): return (chat.conversationID, lead, .adHoc, false)
		case .conversation(let id, let lead): return (id, lead, .adHoc, false)
		case .chiefOfStaff:
			let (id, lead) = try await BriefingChat.resolve(environment: environment, oneToOne: true)
			return (id, lead, .adHoc, true)
		case .dailyBriefing:
			let (id, lead) = try await BriefingChat.resolve(environment: environment, oneToOne: false)
			return (id, lead, .dailyBriefing, true)
		}
	}

	/// Keeps the lock screen's elapsed time current while the call runs.
	private func startTicker() {
		ticker?.cancel()
		ticker = Task { [weak self] in
			while !Task.isCancelled {
				try? await Task.sleep(for: .seconds(1))
				guard let self, let session = self.current, session.isLive else { return }
				session.refreshNowPlaying()
			}
		}
	}
}
