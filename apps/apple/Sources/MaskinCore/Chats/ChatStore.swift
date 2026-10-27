import Foundation
import MaskinAPI
import Observation

/// One open conversation: paged history, durable optimistic send, live updates from the event
/// hub, read state, and "an agent is working" status.
///
/// Message model (matches the backend): every message has an integer id that only grows.
/// Agent replies are not token-streamed over the wire. A turn's text lands as one message when
/// the agent finishes, announced by a `conversation` event (ids only, so the store refetches).
/// What the user sees between sending and that reply comes from the conversation's agent
/// sessions (`GET /api/sessions?conversation_id=`), not a guess.
///
/// `messages` is the server's rows (by id) followed by sends the server has not confirmed yet.
/// Those come from the `ChatSendQueue`, so they survive the app being killed, and they vanish
/// from the list the moment their confirmed twin is in `confirmed` (no ghost, no duplicate).
@MainActor
@Observable
public final class ChatStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	/// Immutable, so safe to read from any isolation (e.g. `LiveMeetingRequest.id`).
	nonisolated public let conversationID: String
	public let currentActorID: String
	public let currentActorName: String

	public private(set) var detail: ConversationSummary?
	/// What the server has, oldest first by server id.
	public private(set) var confirmed: [ChatMessage] = []
	public private(set) var phase: Phase = .idle
	/// Cache vs. network, for an optional "Updated …" line. A failed refresh never blanks the thread.
	public private(set) var freshness = Freshness()
	public private(set) var hasEarlier = false
	public private(set) var isLoadingEarlier = false
	public private(set) var agentStates: [String: ChatActor.AgentState] = [:]
	/// Everyone in the workspace (for the `@` picker and for naming a mentioned actor).
	public private(set) var workspaceActors: [ChatActor] = []
	/// Agent runs for this conversation, newest first.
	public private(set) var agentSessions: [ChatAgentSession] = []
	/// Set right after a send until a reply lands or the spawn grace runs out.
	public private(set) var awaitingReplySince: Date?
	public var notice: String?
	/// The conversation list said something newer exists than the cached page on screen, and the
	/// first network merge has not landed yet. The thread shows a small "Loading new messages…".
	public private(set) var isCatchingUp = false
	/// Why the newest messages could not be fetched while older ones (a cached page) are on
	/// screen. Without it a failed refresh looks like a thread that simply has nothing newer.
	public private(set) var syncProblem: String?
	/// Where the reader's read cursor stood when the thread opened. Fixed for the visit, so the
	/// "new" divider stays put after the thread marks itself read.
	public private(set) var openedReadCursor: Int?
	/// True while the thread is on screen AND the app is active; read state only advances then.
	public var isActive = true {
		didSet {
			guard isActive, !oldValue else { return }
			Task {
				await sync(full: true)
				await refreshSessions()
			}
		}
	}
	/// False while the reader is parked above the newest message (a thread opened on its NEW
	/// divider, or scrolled up). Read state only advances at the bottom, so a chat left half-read
	/// keeps its unread badge in the list.
	public var isAtBottom = true
	/// True once the read cursor this visit opened with is known (from the saved thread or the
	/// server), so the thread can choose its opening position once instead of correcting it later.
	public private(set) var openPositionKnown = false
	/// True once the newest messages came from the server this visit. A saved thread knows its read
	/// cursor but not what arrived since, so choosing the opening position from it alone opens on
	/// the old bottom and the new messages then land below the fold.
	public private(set) var serverConfirmed = false
	/// The newest message the reader has scrolled past; read state advances to it while they are
	/// still above the bottom. Only the thread view feeds it.
	public private(set) var seenThrough = 0
	/// False until the thread has chosen its opening position: rows that happen to be on screen
	/// while it is still hidden at the bottom have not been read.
	public var countsSeen = false
	@ObservationIgnored private var seenTask: Task<Void, Never>?
	/// Told after the server accepted a read cursor, so the list's unread badge clears too.
	@ObservationIgnored public var onMarkedRead: (@MainActor (String, Int) -> Void)?
	/// The agents' step-by-step trace (live and per finished turn). Nil: threads show only the
	/// one-line status. Set by the screen that builds the store.
	@ObservationIgnored public var trace: ActivityStore?
	/// Told after every successful session refresh (feeds the Live Activity).
	@ObservationIgnored public var onSessionsRefreshed: (@MainActor ([ChatAgentSession]) -> Void)?
	/// The flow this conversation belongs to, when the opener knows it (the API does not link a
	/// conversation to a loop yet). Drives the flow-channel nav bar.
	public var flowContext: ChatFlowContext?
	/// Per-message UI state the server has no field for (versions, stopped, feedback), by row id.
	public private(set) var overrides: [String: MessageOverride] = [:]
	/// The one pinned message of this chat, by server id. Kept on this device (`ChatPinStoring`).
	public private(set) var pinnedMessageServerID: Int?
	/// Agents whose reply the user stopped before it finished, until they speak again.
	public private(set) var stoppedAgentIDs: Set<String> = []
	@ObservationIgnored private let pinStore: any ChatPinStoring

	@ObservationIgnored let api: any ChatAPI
	@ObservationIgnored let queue: ChatSendQueue
	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private let pageSize: Int
	/// The list's `lastMessageAt` for this conversation when the thread was opened, if known.
	@ObservationIgnored private let knownLastMessageAt: Date?
	@ObservationIgnored private let spawnGrace: TimeInterval
	@ObservationIgnored private let staleSessionAfter: TimeInterval
	/// Sessions the reader stopped, and when. The server's stop only tears the sandbox down for a
	/// remote session; its row keeps saying `running` until a later settle, so a refresh straight
	/// after Stop would show the same "working" state and Stop would look like it did nothing.
	/// For `stopGrace` the session is treated as stopped; past it, the server's word wins again.
	@ObservationIgnored private var stopRequested: [String: Date] = [:]
	@ObservationIgnored private let stopGrace: TimeInterval = 90
	@ObservationIgnored private let pollInterval: Duration?
	@ObservationIgnored private let retryDelays: [Duration]
	@ObservationIgnored private var retryTask: Task<Void, Never>?
@ObservationIgnored nonisolated(unsafe) private var listener: Task<Void, Never>?
	@ObservationIgnored nonisolated(unsafe) private var queueListener: Task<Void, Never>?
	@ObservationIgnored nonisolated(unsafe) private var deliveryObserver: UUID?
	@ObservationIgnored nonisolated(unsafe) private var poller: Task<Void, Never>?
	@ObservationIgnored private var syncing = false
	@ObservationIgnored private var syncQueued = false
	@ObservationIgnored private var syncQueuedFull = false
	/// Session events arrive in bursts (an agent's activity ticks several times a second): they
	/// are folded into one trailing re-read after this pause, never one read each.
	@ObservationIgnored var sessionEventCoalesce: Duration = .milliseconds(750)
	@ObservationIgnored private var sessionEventTask: Task<Void, Never>?
	@ObservationIgnored private var sessionEventNeedsSync = false
	@ObservationIgnored private var syncWaiters: [CheckedContinuation<Void, Never>] = []
	@ObservationIgnored private var readSent = 0
	/// A delivered message keeps the row id of the optimistic bubble, so SwiftUI never swaps it.
	@ObservationIgnored private var aliases: [Int: String] = [:]
	/// The server id each delivered send got, by client id.
	@ObservationIgnored private var deliveredServerIDs: [String: Int] = [:]
	/// What this store sent, by client id, until the server's copy is in `confirmed`. The queue only
	/// knows a send until the outbox drops it, which can be a moment before the confirmed copy is in
	/// the thread (or, if the delivery hand-off is skipped, long before): in that window the bubble
	/// would be in neither list and blink out. This keeps it on screen until its twin is here.
	private var sentRows: [String: PendingChatSend] = [:]
	/// A send nobody has confirmed after this long stops being drawn as "sending".
	private static let sentRowLifetime: TimeInterval = 90

	public init(
		conversationID: String, currentActorID: String, currentActorName: String,
		api: any ChatAPI, queue: ChatSendQueue, events: EventHub?, pageSize: Int = 50,
		spawnGrace: TimeInterval = 20, staleSessionAfter: TimeInterval = 20 * 60,
		pollInterval: Duration? = .seconds(5), cache: SnapshotCache? = nil,
		retryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(15)],
		knownLastMessageAt: Date? = nil,
		pinStore: any ChatPinStoring = UserDefaultsChatPinStore(),
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.knownLastMessageAt = knownLastMessageAt
		self.pinStore = pinStore
		pinnedMessageServerID = pinStore.pinnedMessageID(conversationID: conversationID)
		self.conversationID = conversationID
		self.currentActorID = currentActorID
		self.currentActorName = currentActorName
		self.api = api
		self.queue = queue
		self.events = events
		self.pageSize = min(max(pageSize, 1), ChatLimits.maxMessagesPage)
		self.spawnGrace = spawnGrace
		self.staleSessionAfter = staleSessionAfter
		self.pollInterval = pollInterval
		self.retryDelays = retryDelays
		self.cache = cache
		self.now = now
		hydrateIfNeeded()
	}

	/// `deinit` may run on any thread: cancel the (thread-safe) task handles directly and hop to the
	/// main actor to unregister from the queue, whose observer table is main-actor state.
	deinit {
		listener?.cancel()
		queueListener?.cancel()
		poller?.cancel()
		if let id = deliveryObserver {
			let queue = queue
			Task { @MainActor in queue.stopObservingDeliveries(id) }
		}
	}

	// MARK: - Derived

	public var participants: [ChatParticipant] { detail?.participants ?? [] }
	public var title: String { detail?.title ?? "Chat" }
	public var lastServerID: Int? { confirmed.last?.serverID }

	/// The main timeline: server rows then unconfirmed sends, without thread replies (those live
	/// in their thread) unless the author also sent them to the chat.
	public var messages: [ChatMessage] { allMessages.filter(\.showsInTimeline) }

	/// Server rows, then unconfirmed sends, thread replies included. Failed sends always show; a
	/// queued one is hidden once its confirmed twin is in the list.
	public var allMessages: [ChatMessage] {
		var rows = queue.pending(in: conversationID)
		let queued = Set(rows.map(\.id))
		let current = now()
		rows += sentRows.values.filter {
			!queued.contains($0.id) && current.timeIntervalSince($0.createdAt) < Self.sentRowLifetime
		}
		rows.sort { $0.createdAt < $1.createdAt }
		var consumed: Set<Int> = []
		var shown: [ChatMessage] = []
		for row in rows {
			if case .failed = row.state {
				shown.append(row.asMessage(actorID: currentActorID, actorName: currentActorName))
				continue
			}
			// Hidden only once the server's copy is actually in the list (under this row's id, or as
			// a twin), never merely because a delivery was announced.
			if isConfirmed(row) { continue }
			if let twin = confirmedTwin(of: row, excluding: consumed) {
				consumed.insert(twin)
				continue
			}
			shown.append(row.asMessage(actorID: currentActorID, actorName: currentActorName))
		}
		return confirmed + shown
	}

	/// How far a server timestamp may trail the device clock and still count as "after the send".
	private static let twinClockSkew: TimeInterval = 120

	/// The confirmed row that is the server's copy of a queued send: mine, same text, and newer
	/// than anything I had seen when I sent it. A send made before the thread had loaded (the
	/// Chief of Staff sheet sends its opening message on appear) saw nothing, so an earlier
	/// identical message of mine would match it and hide the queued bubble; for those the
	/// copy must also have been created no earlier than the send.
	private func confirmedTwin(of row: PendingChatSend, excluding consumed: Set<Int>) -> Int? {
		confirmed.first { message in
			guard let id = message.serverID, !consumed.contains(id) else { return false }
			guard message.actorID == currentActorID, message.content == row.content,
				id > (row.afterServerID ?? 0)
			else { return false }
			if row.afterServerID == nil, let created = message.createdAt,
				created < row.createdAt.addingTimeInterval(-Self.twinClockSkew)
			{
				return false
			}
			return true
		}?.serverID
	}

	/// Question messages that a later human message already answered.
	public var answeredQuestionIDs: Set<Int> {
		Set(messages.compactMap(\.answeredQuestionID))
	}

	/// For each answered question (by its message id): what was picked.
	public var questionAnswerIndex: [Int: [ChatQuestionAnswer.Answer]] {
		var index: [Int: [ChatQuestionAnswer.Answer]] = [:]
		for message in messages {
			if let id = message.answeredQuestionID, index[id] == nil { index[id] = message.questionAnswers }
		}
		return index
	}

	/// For each card a person answered (by the card's message id): how. Read from every message,
	/// since the answer itself is hidden from the timeline.
	public var cardAnswerIndex: [Int: ChatCardAnswer.Outcome] {
		var index: [Int: ChatCardAnswer.Outcome] = [:]
		for message in allMessages {
			if let answer = message.cardAnswer, index[answer.messageID] == nil {
				index[answer.messageID] = answer.outcome
			}
		}
		return index
	}

	/// A name for an actor id: someone in the conversation, else anyone in the workspace. Nil when
	/// it can't be resolved (callers omit it; a raw id is never shown).
	public func displayName(for actorID: String) -> String? {
		if actorID == currentActorID { return currentActorName }
		return participants.first { $0.id == actorID }?.name
			?? workspaceActors.first { $0.id == actorID }?.participant.name
	}

	public func participant(for actorID: String) -> ChatParticipant {
		participants.first { $0.id == actorID }
			?? workspaceActors.first { $0.id == actorID }?.participant
			?? ChatParticipant(id: actorID, name: "An agent", kind: .agent)
	}

	/// Live agent sessions, one per agent (the newest), ignoring ones that have gone quiet and ones
	/// that are only waiting for the next message (`isIdle`).
	public func liveSessions(at date: Date? = nil) -> [ChatAgentSession] {
		let t = date ?? now()
		return runningSessions(at: t).filter { !isIdle($0, at: t) }
	}

	/// An interactive session stays `running` between turns, so its status alone can't say whether
	/// the agent is working. It is idle when its newest traced turn has finished, nothing is
	/// awaited from it, and no one has written to the chat since that turn began (a message
	/// newer than the turn gets `spawnGrace` for the next turn to show up). Without a loaded trace
	/// nothing is known, so the session counts as working.
	public func isIdle(_ session: ChatAgentSession, at date: Date? = nil) -> Bool {
		let t = date ?? now()
		guard awaitingReplySince == nil else { return false }
		guard let turns = trace?.turnsBySession[session.id],
			let last = turns.max(by: { $0.messageID < $1.messageID })
		else { return finalOutputIsNewest(of: session, at: t) }
		guard !last.isRunning else { return false }
		let newerFromOthers = messages.contains { message in
			guard message.kind == "message", message.actorID != session.actorID else { return false }
			guard message.serverID == nil || (message.serverID ?? 0) > last.messageID else { return false }
			guard let created = message.createdAt else { return message.serverID == nil }
			return t.timeIntervalSince(created) < spawnGrace
		}
		return !newerFromOthers
	}

	/// No trace to read: the agent's `final_output` message being newer than anything anyone else
	/// wrote means its last turn is over. Mirrors the web, which keys off that message.
	private func finalOutputIsNewest(of session: ChatAgentSession, at t: Date) -> Bool {
		guard let last = messages.last(where: { $0.kind == "message" }) else { return false }
		return last.actorID == session.actorID && last.serverID != nil && last.isFinalOutput
	}

	/// Sessions that are open but between turns, kept so the user can still end one.
	public func idleSessions(at date: Date? = nil) -> [ChatAgentSession] {
		let t = date ?? now()
		return runningSessions(at: t).filter { $0.status == .running && isIdle($0, at: t) }
	}

	private func runningSessions(at t: Date) -> [ChatAgentSession] {
		var seen: Set<String> = []
		return agentSessions.filter { session in
			guard session.status.isLive else { return false }
			if let stopped = stopRequested[session.id], t.timeIntervalSince(stopped) < stopGrace { return false }
			if let touched = session.updatedAt ?? session.startedAt,
				t.timeIntervalSince(touched) > staleSessionAfter
			{
				return false
			}
			return seen.insert(session.actorID).inserted
		}
	}

	/// The newest session of an agent that stopped without finishing: paused (resumable) or
	/// failed. Only shown while nothing of theirs is running.
	public func stalledSession() -> ChatAgentSession? {
		guard liveSessions().isEmpty else { return nil }
		guard let latest = agentSessions.first else { return nil }
		guard latest.status == .paused else { return nil }
		return latest
	}

	/// Agents to show a "working" row for. Real running sessions win. Right after a send, before
	/// the backend has created a session, every agent participant is shown for `spawnGrace`.
	public func workingAgents(at date: Date? = nil) -> [ChatParticipant] {
		let live = liveSessions(at: date)
		if !live.isEmpty {
			return live.map { participant(for: $0.actorID) }
		}
		guard let since = awaitingReplySince, (date ?? now()).timeIntervalSince(since) < spawnGrace
		else { return [] }
		return participants.filter { $0.kind == .agent && $0.id != currentActorID }
	}

	/// What a working agent is doing right now, when the session says.
	public func activity(for agentID: String) -> String? {
		liveSessions().first { $0.actorID == agentID }?.currentActivity.flatMap { $0.isEmpty ? nil : $0 }
	}

	/// A reply is still owed: the user just sent something, or the newest message is not from an
	/// agent. A chat session stays `running` between turns, so session status alone cannot say
	/// whether a turn is in flight. Locks the versions pager and decides the `Stopped` marker.
	public var replyInFlight: Bool {
		if awaitingReplySince != nil { return true }
		guard let last = confirmed.last(where: { $0.kind == "message" }) else { return false }
		return last.author != .agent
	}

	// MARK: - Presence (typing / replying / working)

	/// What an agent is doing right now, from its live session and the trace's current step: a
	/// text or thinking step means it is composing (typing), a tool step means it is working on a
	/// task, and a session with no step yet (or the spawn grace right after a send) means it has the
	/// message but has not started answering (replying).
	public func presence(of agentID: String, at date: Date? = nil) -> ChatAgentPresence? {
		if let session = liveSessions(at: date).first(where: { $0.actorID == agentID }) {
			if let turn = trace?.liveTurn(sessionID: session.id) {
				guard let step = turn.steps.last(where: \.isRunning) else { return .typing }
				switch step.kind {
				case .text, .thinking: return .typing
				case .toolUse, .error: return .working
				}
			}
			return session.status == .running ? .working : .replying
		}
		if workingAgents(at: date).contains(where: { $0.id == agentID }) { return .replying }
		return nil
	}

	/// Every agent with a presence, as the nav bar and indicators want them.
	public func presences(at date: Date? = nil) -> [(agent: ChatParticipant, presence: ChatAgentPresence)] {
		var seen: Set<String> = []
		return (liveSessions(at: date).map(\.actorID) + workingAgents(at: date).map(\.id))
			.filter { seen.insert($0).inserted }
			.compactMap { id in presence(of: id, at: date).map { (participant(for: id), $0) } }
	}

	/// Agents composing a reply right now (the dots bubble).
	public func typingAgents(at date: Date? = nil) -> [ChatParticipant] {
		presences(at: date).filter { $0.presence == .typing }.map(\.agent)
	}

	/// Partial reply text while an agent's turn is open. The API delivers a reply as one message
	/// when the turn ends and the activity feed carries one-line step labels only, so there is no
	/// token stream to read yet; the bubble shows its caret over this once the backend streams.
	public func liveReplyDraft(for agentID: String) -> String? { nil }

	/// Who has read one of your messages: the agent whose session picked it up, else the first
	/// agent that answered after it. Nil until then (`Sent`).
	public func readBy(_ message: ChatMessage) -> String? {
		guard message.actorID == currentActorID, let id = message.serverID else { return nil }
		if let session = agentSessions.first(where: { $0.messageID == id }) {
			return participant(for: session.actorID).name
		}
		if let reply = confirmed.first(where: { $0.author == .agent && ($0.serverID ?? 0) > id }) {
			return participants.first { $0.id == reply.actorID }?.name ?? reply.actorName
		}
		return nil
	}

	// MARK: - Pinned message

	public var pinnedMessage: ChatMessage? {
		guard let id = pinnedMessageServerID else { return nil }
		return confirmed.first { $0.serverID == id }
	}

	public func isPinned(_ message: ChatMessage) -> Bool {
		message.serverID != nil && message.serverID == pinnedMessageServerID
	}

	/// One pinned message per chat; pinning another replaces it. Only a confirmed message can be
	/// pinned (a pending one has no stable id).
	public func pin(_ message: ChatMessage) {
		guard let id = message.serverID else { return }
		pinnedMessageServerID = id
		pinStore.setPinnedMessageID(id, conversationID: conversationID)
	}

	public func unpin() {
		pinnedMessageServerID = nil
		pinStore.setPinnedMessageID(nil, conversationID: conversationID)
	}

	// MARK: - Overrides (versions, feedback)

	public func override(for messageID: String) -> MessageOverride {
		overrides[messageID] ?? MessageOverride()
	}

	private func update(_ messageID: String, _ change: (inout MessageOverride) -> Void) {
		var value = overrides[messageID] ?? MessageOverride()
		change(&value)
		overrides[messageID] = value.isEmpty ? nil : value
	}

	/// Record another answer for an agent message and show it. Nothing calls this in production
	/// yet: regenerating an answer as a *version* of the same message needs a revision endpoint the
	/// API does not have (`retryAgent` posts a fresh message instead).
	public func addVersion(_ text: String, to messageID: String) {
		guard let message = messages.first(where: { $0.id == messageID }) else { return }
		update(messageID) { value in
			if value.versions.isEmpty { value.versions = [message.content] }
			value.versions.append(text)
			value.versionIndex = value.versions.count - 1
		}
	}

	/// Step between versions; locked while a reply is still on its way.
	public func selectVersion(_ index: Int, of messageID: String) {
		guard !replyInFlight else { return }
		update(messageID) { value in
			guard value.versions.indices.contains(index) else { return }
			value.versionIndex = index
		}
	}

	/// "Good answer" / "Not right", kept on this device: the API has no message feedback yet.
	public func setFeedback(_ feedback: MessageOverride.Feedback?, on messageID: String) {
		update(messageID) { $0.feedback = feedback }
	}

	/// "Make it shorter": the API has no regenerate-with-instruction call, so this asks in the
	/// chat the way a person would, quoting the answer. The shorter reply lands as a new message.
	@discardableResult
	public func askForShorter(_ message: ChatMessage) -> String? {
		send(ChatQuote.make(author: message.actorName, content: message.content) + "Make it shorter")
	}


	// MARK: - Loading

	public func start() async {
		if listener == nil, let events {
			let stream = events.subscribe()
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .reconnected:
						await self.sync(full: true)
						await self.refreshSessions()
					case .event(let event) where event.entityType == .conversation && event.entityId == self.conversationID:
						await self.sync(full: event.action == "message_updated")
						await self.refreshSessions()
					case .event(let event) where event.entityType == .actor || event.entityType == .session:
						// A handed-off session's row lives on its message: re-read the page only when
						// one of THIS thread's sessions changed, never for the workspace's other work.
						self.noteSessionEvent(rereadsThread: event.entityType == .session && self.ownsSpawnedSession(event.entityId))
					case .event:
						break
					}
				}
			}
		}
		if deliveryObserver == nil {
			// Take the server's copy in the same step the queue confirms the send, before the
			// outbox drops its entry; the stream below then finds it already applied.
			deliveryObserver = queue.observeDeliveries { [weak self] clientID, message in
				self?.apply(.delivered(clientID: clientID, message: message))
			}
		}
		if queueListener == nil {
			let stream = queue.events()
			queueListener = Task { [weak self] in
				for await event in stream {
					guard let self else { return }
					self.apply(event)
				}
			}
		}
		if poller == nil, let interval = pollInterval {
			poller = Task { [weak self] in
				while !Task.isCancelled {
					try? await Task.sleep(for: interval)
					guard let self, !Task.isCancelled else { return }
					// Not gated on `isActive`: the app is "inactive" (not backgrounded) behind Control
					// Center, a screen recording or a system sheet, and the thread is still on screen.
					if self.needsSessionPoll {
						// Messages normally arrive on the event stream. While a reply is owed, also ask for
						// what is newer than the last row held (cheap, `after_id`), so a stream that
						// dropped or stalled can't leave the reader looking at a frozen thread.
						await self.sync(full: self.hasLiveSpawnedSession)
						await self.refreshSessions()
					}
				}
			}
		}
		await load()
	}

	public func stop() {
		seenTask?.cancel()
		seenTask = nil
		listener?.cancel()
		listener = nil
		queueListener?.cancel()
		queueListener = nil
		if let deliveryObserver { queue.stopObservingDeliveries(deliveryObserver) }
		deliveryObserver = nil
		poller?.cancel()
		poller = nil
		sessionEventTask?.cancel()
		sessionEventTask = nil
		retryTask?.cancel()
		retryTask = nil
		trace?.stop()
	}

	/// Only poll sessions while something could change: an agent is running or a reply is due.
	private var needsSessionPoll: Bool {
		!runningSessions(at: now()).isEmpty || awaitingReplySince != nil || hasLiveSpawnedSession
	}

	/// A handoff row is still queued or working: its state only reaches us through the messages.
	private var hasLiveSpawnedSession: Bool {
		confirmed.contains { $0.spawnedSessions.contains { $0.isLive } }
	}

	private func ownsSpawnedSession(_ id: String?) -> Bool {
		guard let id else { return false }
		return confirmed.contains { $0.spawnedSessions.contains { $0.id == id } }
	}

	/// Fold a burst of session/actor events into one trailing pass.
	private func noteSessionEvent(rereadsThread: Bool) {
		sessionEventNeedsSync = sessionEventNeedsSync || rereadsThread
		guard sessionEventTask == nil else { return }
		let pause = sessionEventCoalesce
		sessionEventTask = Task { [weak self] in
			try? await Task.sleep(for: pause)
			guard let self, !Task.isCancelled else { return }
			let reread = self.sessionEventNeedsSync
			self.sessionEventNeedsSync = false
			self.sessionEventTask = nil
			if reread { await self.sync(full: true) }
			await self.refreshSessions()
		}
	}

	/// First frame from disk: the newest page of this thread, before any network call.
	func hydrateIfNeeded() {
		guard phase == .idle, confirmed.isEmpty,
			let entry = cache?.read(
				ChatCaching.ThreadSnapshot.self, ChatCaching.threadName(conversationID),
				version: ChatCaching.version),
			entry.value.detail.id == conversationID
		else { return }
		detail = entry.value.detail
		readSent = max(readSent, entry.value.detail.lastReadMessageID ?? 0)
		if openedReadCursor == nil { openedReadCursor = entry.value.detail.lastReadMessageID }
		openPositionKnown = true
		merge(entry.value.messages.map(\.message))
		hasEarlier = confirmed.count >= ChatCaching.threadMessageLimit
		phase = .loaded
		freshness.hydrated(from: entry.savedAt)
		if let latest = knownLastMessageAt, let newest = confirmed.last?.createdAt,
			latest.timeIntervalSince(newest) > Self.gapTolerance
		{
			isCatchingUp = true
		}
	}

	private func writeCache() {
		guard let cache, let detail else { return }
		let rows = confirmed.suffix(ChatCaching.threadMessageLimit).compactMap(ChatCaching.CachedMessage.init)
		cache.write(
			ChatCaching.ThreadSnapshot(detail: detail, messages: rows),
			ChatCaching.threadName(conversationID), version: ChatCaching.version)
	}

	public func load() async {
		if await attemptLoad() { return }
		scheduleRetry()
	}

	/// Try again a few times after a failed load: a thread opened on a bad moment (a dropped
	/// connection, a request cancelled by a re-render) must not stay on its cached page.
	private func scheduleRetry() {
		guard retryTask == nil, !retryDelays.isEmpty else { return }
		let delays = retryDelays
		retryTask = Task { [weak self] in
			for delay in delays {
				try? await Task.sleep(for: delay)
				guard let self, !Task.isCancelled else { return }
				if await self.attemptLoad() { break }
			}
			self?.retryTask = nil
		}
	}

	/// How far behind the conversation's latest message the thread may be before it re-reads.
	private static let gapTolerance: TimeInterval = 5

	/// The conversation says something newer exists than the newest message held: read the
	/// newest page once more rather than leave the reader on an older view of the thread.
	private func closeGapIfBehind() async {
		func isBehind() -> Bool {
			guard let latest = detail?.lastMessageAt, let newest = confirmed.last?.createdAt else { return false }
			return latest.timeIntervalSince(newest) > Self.gapTolerance
		}
		if isBehind() { await sync(full: true) }
	}

	@discardableResult
	private func attemptLoad() async -> Bool {
		hydrateIfNeeded()
		if confirmed.isEmpty { phase = .loading }
		do {
			async let detailTask = api.detail(conversationID: conversationID)
			async let pageTask = api.messages(
				conversationID: conversationID, beforeID: nil, afterID: nil, limit: pageSize)
			// The messages are what the reader is waiting for. With a header already (cache) paint
			// them the moment they arrive; the detail read only refreshes the read cursor.
			let page = try await pageTask
			let hadDetail = detail != nil
			var loadedDetail: ConversationSummary?
			if hadDetail {
				syncProblem = nil
				mergeNewest(page)
				phase = .loaded
				isCatchingUp = false
				loadedDetail = try? await detailTask
			} else {
				loadedDetail = try await detailTask
				syncProblem = nil
				mergeNewest(page)
				phase = .loaded
				isCatchingUp = false
			}
			if let loadedDetail {
				detail = loadedDetail
				if openedReadCursor == nil { openedReadCursor = loadedDetail.lastReadMessageID }
				openPositionKnown = true
				readSent = max(readSent, loadedDetail.lastReadMessageID ?? 0)
			}
			serverConfirmed = true
			freshness.refreshed(at: cache?.now() ?? now())
			writeCache()
			// Independent reads: run together so the working indicator and trace don't wait on
			// the actor list or the read receipt.
			async let read: Void = markReadIfNeeded()
			async let states: Void = refreshAgentStates()
			async let sessions: Void = refreshSessions()
			_ = await (read, states, sessions)
			await closeGapIfBehind()
			return true
		} catch {
			// A cancelled request is the view going away, not the server failing.
			if error is CancellationError || Task.isCancelled { return false }
			freshness.revalidateFailed()
			isCatchingUp = false
			if confirmed.isEmpty {
				phase = .failed(Self.message(error))
			} else {
				// Cached rows stay on screen, but say they may be out of date.
				syncProblem = Self.message(error)
			}
			return false
		}
	}

	public func loadEarlier() async {
		guard hasEarlier, !isLoadingEarlier, let oldest = confirmed.first?.serverID else { return }
		isLoadingEarlier = true
		defer { isLoadingEarlier = false }
		do {
			let page = try await api.messages(
				conversationID: conversationID, beforeID: oldest, afterID: nil, limit: pageSize)
			merge(page.messages)
			hasEarlier = page.hasMore
		} catch {
			notice = Self.message(error)
		}
	}

	/// Pull-to-refresh: everything, and wait for it.
	public func refresh() async {
		await sync(full: true)
		await refreshAgentStates()
		await refreshSessions()
	}

	/// Pull what changed. Incremental (`after_id`) for new messages; `full` re-reads the newest
	/// page so edits and anything missed during a reconnect are picked up. Bursts coalesce into
	/// one trailing pass, and every caller returns only after the pass that covers its request.
	public func sync(full: Bool = false) async {
		if syncing {
			syncQueued = true
			syncQueuedFull = syncQueuedFull || full
			await withCheckedContinuation { syncWaiters.append($0) }
			return
		}
		syncing = true
		var wantFull = full
		repeat {
			syncQueued = false
			let thisPassFull = wantFull || syncQueuedFull
			syncQueuedFull = false
			do {
				let page: MessagePage
				// The detail read doesn't depend on the page; fetch it alongside.
				async let freshDetail = try? api.detail(conversationID: conversationID)
				if thisPassFull || lastServerID == nil {
					page = try await api.messages(
						conversationID: conversationID, beforeID: nil, afterID: nil, limit: pageSize)
				} else {
					page = try await api.messages(
						conversationID: conversationID, beforeID: nil, afterID: lastServerID, limit: pageSize)
				}
				mergeNewest(page)
				isCatchingUp = false
				if let detail = await freshDetail {
					if self.detail != detail { self.detail = detail }
					readSent = max(readSent, detail.lastReadMessageID ?? 0)
				}
				syncProblem = nil
				freshness.refreshed(at: cache?.now() ?? now())
				writeCache()
				await markReadIfNeeded()
			} catch {
				freshness.revalidateFailed()
				isCatchingUp = false
				if !(error is CancellationError), !Task.isCancelled, !confirmed.isEmpty {
					syncProblem = Self.message(error)
				}
			}
			wantFull = false
		} while syncQueued
		syncing = false
		let waiters = syncWaiters
		syncWaiters = []
		for waiter in waiters { waiter.resume() }
	}

	public func refreshAgentStates() async {
		guard let actors = try? await api.actors() else { return }
		var states: [String: ChatActor.AgentState] = [:]
		for a in actors where a.participant.kind == .agent { states[a.id] = a.agentState }
		agentStates = states
		workspaceActors = actors
	}

	public func refreshSessions() async {
		guard let sessions = try? await api.sessions(conversationID: conversationID) else { return }
		let sorted = sessions.sorted {
			($0.startedAt ?? .distantPast) > ($1.startedAt ?? .distantPast)
		}
		if sorted != agentSessions { agentSessions = sorted }
		// Not awaited: fetching a finished turn's history must never delay the thread itself.
		Task { [trace, sessions = agentSessions] in await trace?.update(sessions: sessions) }
		onSessionsRefreshed?(agentSessions)
	}

	// MARK: - Send

	/// Queue a message. The bubble appears at once (it is read from the queue, which is on disk),
	/// and the outbox delivers it exactly once, now or when the network is back.
	@discardableResult
	public func send(
		_ text: String, metadata: ChatSendMetadata? = nil, thread: ChatSendThread? = nil
	) -> String? {
		let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !content.isEmpty else { return nil }
		do {
			let pending = try queue.send(
				conversationID: conversationID, content: content, metadata: metadata,
				afterServerID: lastServerID, thread: thread)
			sentRows[pending.id] = pending
			awaitingReplySince = now()
			// Asking again lifts the "Stopped" marker: a new answer is on its way.
			stoppedAgentIDs = []
			return "local-\(pending.id)"
		} catch {
			notice = "Couldn't queue that message."
			return nil
		}
	}

	/// Retry a failed send (the row id is `local-<clientID>`).
	public func retrySend(_ id: String) {
		queue.retry(Self.clientID(of: id))
		awaitingReplySince = now()
	}

	/// Drop a message that never reached the server.
	public func discard(_ id: String) {
		sentRows[Self.clientID(of: id)] = nil
		if !queue.discard(Self.clientID(of: id)) {
			notice = "That message is already being sent."
		}
	}

	private static func clientID(of rowID: String) -> String {
		rowID.hasPrefix("local-") ? String(rowID.dropFirst("local-".count)) : rowID
	}

	private func apply(_ event: ChatSendEvent) {
		switch event {
		case .delivered(let clientID, let message):
			guard message.conversationID == conversationID, let serverID = message.serverID else { return }
			// Already applied inline by the delivery observer; the stream repeats it.
			guard deliveredServerIDs[clientID] == nil else { return }
			deliveredServerIDs[clientID] = serverID
			aliases[serverID] = "local-\(clientID)"
			merge([message])
			awaitingReplySince = now()
			Task {
				await markReadIfNeeded()
				await refreshAgentStates()
				await refreshSessions()
			}
		case .failed:
			break
		}
	}

	/// Ask the agents to answer again. `messageID` is the human message the reply belongs to
	/// (the web retries the triggering message; for a failed agent reply that is the message
	/// just before it).
	public func retryAgent(for message: ChatMessage) async {
		let target: Int?
		if message.author == .agent {
			target = confirmed.last(where: { ($0.serverID ?? 0) < (message.serverID ?? 0) && $0.author == .human })?.serverID
		} else {
			target = message.serverID
		}
		guard let target else { return }
		do {
			try await api.retry(
				conversationID: conversationID, messageID: target,
				agentID: message.author == .agent ? message.actorID : nil)
			awaitingReplySince = now()
		} catch {
			notice = Self.message(error)
		}
	}

	/// Answer an agent's question. Posts the ordinary chat message the web posts: the text repeats
	/// each question with the pick (what the agent reads), and `question_answer` pairs it to the
	/// question for the UI. Goes through the outbox like any send, so it survives being offline.
	@discardableResult
	public func answer(question message: ChatMessage, picks: [Int: [String]]) -> String? {
		guard let questionID = message.serverID, !answeredQuestionIDs.contains(questionID) else { return nil }
		let items = message.questions
		let answers = items.compactMap { item -> ChatQuestionAnswer.Answer? in
			guard let picked = picks[item.index], !picked.isEmpty else { return nil }
			return .init(header: item.header, selected: picked)
		}
		guard answers.count == items.count, !items.isEmpty else { return nil }
		let content = items.map { item in
			"**\(item.header)** \u{2014} \(item.question)\n\((picks[item.index] ?? []).joined(separator: ", "))"
		}.joined(separator: "\n\n")
		return send(
			content,
			metadata: ChatSendMetadata(
				questionAnswer: ChatQuestionAnswer(questionMessageID: questionID, answers: answers)))
	}

	// MARK: - Participants, title, sessions

	public func addParticipants(_ ids: [String]) async {
		guard !ids.isEmpty else { return }
		do {
			try await api.addParticipants(conversationID: conversationID, actorIDs: ids)
			if let detail = try? await api.detail(conversationID: conversationID) { self.detail = detail }
		} catch {
			notice = Self.message(error)
		}
	}

	@discardableResult
	public func removeParticipant(_ actorID: String) async -> Bool {
		let before = detail
		detail?.participants.removeAll { $0.id == actorID }
		do {
			try await api.removeParticipant(conversationID: conversationID, actorID: actorID)
			return true
		} catch {
			detail = before
			notice = Self.message(error)
			return false
		}
	}

	/// Optimistic rename; rolled back if the server refuses.
	/// Replace the text of one of your own messages. The new text shows at once; if the server
	/// refuses it the old text comes back with a notice.
	public func edit(_ id: String, to text: String) async {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty, trimmed.count <= ChatLimits.maxMessageLength,
			let index = confirmed.firstIndex(where: { $0.id == id }),
			confirmed[index].canEdit(by: currentActorID), let serverID = confirmed[index].serverID,
			trimmed != confirmed[index].content
		else { return }
		let before = confirmed[index]
		confirmed[index].content = trimmed
		confirmed[index].editedAt = now()
		do {
			let saved = try await api.edit(conversationID: conversationID, messageID: serverID, content: trimmed)
			merge([saved])
		} catch {
			if let current = confirmed.firstIndex(where: { $0.id == id }) { confirmed[current] = before }
			notice = Self.message(error)
		}
	}

	public func rename(to title: String) async {
		let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty, trimmed != detail?.title else { return }
		let before = detail?.title
		detail?.title = trimmed
		do {
			try await api.rename(conversationID: conversationID, title: trimmed)
		} catch {
			if let before { detail?.title = before }
			notice = Self.message(error)
		}
	}

	/// Stop an agent mid-turn. Its reply, if one was owed, shows as `Stopped` until it speaks again.
	public func stopSession(_ id: String) async {
		let agentID = agentSessions.first { $0.id == id }?.actorID
		do {
			try await api.stopSession(sessionID: id)
			if let agentID, replyInFlight || liveSessions().contains(where: { $0.id == id }) {
				stoppedAgentIDs.insert(agentID)
			}
			stopRequested[id] = now()
			// The agent is no longer expected to answer: no spawn-grace "working" row either.
			awaitingReplySince = nil
		} catch {
			notice = Self.message(error)
		}
		await refreshSessions()
	}

	/// Stop whatever is live: the composer's Stop button ends every running turn in the chat.
	public func stopLiveSessions() async {
		for session in liveSessions() where session.status == .running {
			await stopSession(session.id)
		}
	}

	public func resumeSession(_ id: String) async {
		do {
			try await api.resumeSession(sessionID: id)
			awaitingReplySince = now()
		} catch {
			notice = Self.message(error)
		}
		await refreshSessions()
	}

	// MARK: - Read state

	/// Advance the read cursor. At the bottom that is the newest confirmed message; above it, the
	/// newest message the reader has scrolled past (`noteSeen`). Never regresses, never repeats.
	/// Only while the thread is visible and the app is active.
	public func markReadIfNeeded() async {
		guard isActive, let last = lastServerID else { return }
		var target = isAtBottom ? last : min(last, seenThrough)
		// Past the last message the reader can still scroll to there is nothing left to read: their
		// own messages and thread replies (shown in their thread, not here) are never scrolled past.
		if target < last, !timelineHasUnseen(after: target) { target = last }
		guard target > readSent else { return }
		let previous = readSent
		readSent = target
		do {
			try await api.markRead(conversationID: conversationID, lastMessageID: target)
			detail?.lastReadMessageID = target
			if target >= last {
				detail?.unreadCount = 0
				onMarkedRead?(conversationID, last)
			}
			// The saved thread must carry the new cursor, or the next open shows NEW over read messages.
			writeCache()
		} catch {
			readSent = previous
		}
	}

	/// Whether the main timeline still holds a message from someone else after `cursor`.
	func timelineHasUnseen(after cursor: Int) -> Bool {
		messages.contains { ($0.serverID ?? 0) > cursor && $0.actorID != currentActorID }
	}

	/// The reader has scrolled past message `serverID`: read state follows a moment later, so a
	/// long thread reads down as it is read instead of staying unread until the very end.
	public func noteSeen(_ serverID: Int) {
		guard countsSeen, serverID > seenThrough else { return }
		seenThrough = serverID
		seenTask?.cancel()
		seenTask = Task { [weak self] in
			try? await Task.sleep(for: .milliseconds(350))
			if Task.isCancelled { return }
			await self?.markReadIfNeeded()
		}
	}

	// MARK: - Reactions

	/// Add or take back your `emoji` on a message. The chip changes at once; if the server refuses,
	/// it goes back and the notice says why.
	public func toggleReaction(_ emoji: String, on message: ChatMessage) async {
		guard let serverID = message.serverID,
			let index = confirmed.firstIndex(where: { $0.serverID == serverID })
		else { return }
		let before = confirmed[index].reactions
		let adding = !(before.first { $0.emoji == emoji }?.reactedByMe ?? false)
		confirmed[index].reactions = MessageReaction.toggling(
			emoji, in: before, me: ChatParticipant(id: currentActorID, name: currentActorName, kind: .human))
		do {
			try await api.react(conversationID: conversationID, messageID: serverID, emoji: emoji, add: adding)
		} catch {
			// Roll back only if nothing newer replaced the row meanwhile.
			if let now = confirmed.firstIndex(where: { $0.serverID == serverID }) {
				confirmed[now].reactions = before
			}
			notice = Self.message(error)
		}
	}

	// MARK: - Threads

	/// The highest reply id the reader has opened each thread past, so a pill reads "read" the
	/// moment the thread is opened rather than after the server round trip.
	public private(set) var threadReadThrough: [Int: Int] = [:]

	/// The replies of one thread, oldest first, unconfirmed ones last.
	public func replies(to rootID: Int) -> [ChatMessage] {
		allMessages.filter { $0.threadRootID == rootID && !$0.isHiddenFromChat }
	}

	/// What the pill under a root says: the server's summary plus replies that arrived since.
	public func threadSummary(for root: ChatMessage) -> ThreadSummary? {
		guard let rootID = root.serverID else { return nil }
		return ThreadSummary.current(
			base: root.thread, rootAuthor: participant(for: root.actorID),
			replies: confirmed.filter { $0.threadRootID == rootID }, currentActorID: currentActorID,
			readThrough: threadReadThrough[rootID])
	}

	/// Fetch every reply of a thread and fold them in (a root opened from the Threads list, or one
	/// whose replies are older than the page held).
	public func loadThread(_ rootID: Int) async {
		do {
			merge(try await api.threadReplies(conversationID: conversationID, rootID: rootID))
		} catch {
			notice = Self.message(error)
		}
	}

	/// Reply inside a thread. `to` is who the reply is for: they are mentioned, which is what makes
	/// an agent answer. Returns the local row id, nil when the text is empty.
	@discardableResult
	public func reply(
		_ text: String, in rootID: Int, to recipient: ChatParticipant?, alsoInChannel: Bool,
		metadata extra: ChatSendMetadata? = nil
	) -> String? {
		var metadata = extra
		if let recipient {
			metadata = ChatSendMetadata(
				mentions: [recipient.id], questionAnswer: extra?.questionAnswer,
				hiddenFromChat: extra?.hiddenFromChat, cardAnswer: extra?.cardAnswer)
		}
		return send(
			text, metadata: metadata, thread: ChatSendThread(rootID: rootID, alsoInChannel: alsoInChannel))
	}

	/// The reader has the thread open: everything in it counts as read.
	public func markThreadRead(_ rootID: Int) async {
		guard let newest = confirmed.last(where: { $0.threadRootID == rootID })?.serverID,
			newest > (threadReadThrough[rootID] ?? 0)
		else { return }
		threadReadThrough[rootID] = newest
		try? await api.markThreadRead(conversationID: conversationID, rootID: rootID, lastMessageID: newest)
	}

	// MARK: - Merging

	/// Fold in the newest page. When more than a page arrived since the last sync the page does
	/// not touch what we hold (a gap): drop the old rows and let `loadEarlier` page them back,
	/// rather than showing history with a hole in it.
	func mergeNewest(_ page: MessagePage) {
		let held = lastServerID
		let wasEmpty = confirmed.isEmpty
		var base = confirmed
		if let held, page.hasMore, let first = page.messages.first?.serverID, first > held {
			base = []
			hasEarlier = true
		}
		publish(merged(page.messages, into: base))
		if wasEmpty { hasEarlier = page.hasMore }
	}

	/// Fold server rows into the confirmed list, ordered by server id however they arrive. A row
	/// already present is updated in place (keeping its row id), so SwiftUI never re-creates it.
	func merge(_ incoming: [ChatMessage]) {
		publish(merged(incoming, into: confirmed))
	}

	/// Publish only a real change: re-reading an unchanged thread must not make the view rebuild.
	private func publish(_ result: (rows: [ChatMessage], clearsReply: Bool)) {
		if result.clearsReply { awaitingReplySince = nil }
		if result.rows != confirmed { confirmed = result.rows }
		pruneSentRows()
	}

	/// The server's copy of this send is in the list: under the bubble's own id, or by the server id
	/// the delivery reported.
	private func isConfirmed(_ row: PendingChatSend) -> Bool {
		let delivered = deliveredServerIDs[row.id]
		return confirmed.contains { $0.id == "local-\(row.id)" || (delivered != nil && $0.serverID == delivered) }
	}

	/// Forget sends whose confirmed copy has arrived.
	private func pruneSentRows() {
		guard !sentRows.isEmpty else { return }
		var consumed: Set<Int> = []
		for (id, row) in sentRows.sorted(by: { $0.value.createdAt < $1.value.createdAt }) {
			if isConfirmed(row) {
				sentRows[id] = nil
			} else if let twin = confirmedTwin(of: row, excluding: consumed) {
				consumed.insert(twin)
				sentRows[id] = nil
			}
		}
	}

	private func merged(_ incoming: [ChatMessage], into base: [ChatMessage]) -> (rows: [ChatMessage], clearsReply: Bool) {
		var rows = base
		var clears = false
		for var message in incoming {
			guard let serverID = message.serverID else { continue }
			if let index = rows.firstIndex(where: { $0.serverID == serverID }) {
				message.id = rows[index].id
				rows[index] = message
			} else {
				if let alias = aliases[serverID] { message.id = alias }
				rows.append(message)
				// A fresh answer lifts the agent's "Stopped" marker; a re-read of old rows does not.
				if message.author == .agent {
					stoppedAgentIDs.remove(message.actorID)
					// It answered after the Stop, so its session is live again: no stop grace.
					for session in agentSessions where session.actorID == message.actorID {
						stopRequested[session.id] = nil
					}
				}
			}
			if message.author == .agent, awaitingReplySince != nil,
				let sent = rows.last(where: { $0.actorID == currentActorID })?.serverID,
				serverID > sent
			{
				clears = true
			}
		}
		rows.sort { ($0.serverID ?? 0) < ($1.serverID ?? 0) }
		return (rows, clears)
	}

	static func message(_ error: Error) -> String {
		if let http = error as? ChatsHTTPError { return http.message }
		return (error as? ChatsError)?.message ?? error.localizedDescription
	}
}
