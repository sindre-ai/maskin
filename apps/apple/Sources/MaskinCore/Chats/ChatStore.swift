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

	public let conversationID: String
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
	/// Told after the server accepted a read cursor, so the list's unread badge clears too.
	@ObservationIgnored public var onMarkedRead: (@MainActor (String, Int) -> Void)?
	/// The agents' step-by-step trace (live and per finished turn). Nil: threads show only the
	/// one-line status. Set by the screen that builds the store.
	@ObservationIgnored public var trace: ActivityStore?
	/// Told after every successful session refresh (feeds the Live Activity).
	@ObservationIgnored public var onSessionsRefreshed: (@MainActor ([ChatAgentSession]) -> Void)?

	@ObservationIgnored let api: any ChatAPI
	@ObservationIgnored let queue: ChatSendQueue
	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private let pageSize: Int
	@ObservationIgnored private let spawnGrace: TimeInterval
	@ObservationIgnored private let staleSessionAfter: TimeInterval
	@ObservationIgnored private let pollInterval: Duration?
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var queueListener: Task<Void, Never>?
	@ObservationIgnored private var deliveryObserver: UUID?
	@ObservationIgnored private var poller: Task<Void, Never>?
	@ObservationIgnored private var syncing = false
	@ObservationIgnored private var syncQueued = false
	@ObservationIgnored private var syncQueuedFull = false
	@ObservationIgnored private var syncWaiters: [CheckedContinuation<Void, Never>] = []
	@ObservationIgnored private var readSent = 0
	/// A delivered message keeps the row id of the optimistic bubble, so SwiftUI never swaps it.
	@ObservationIgnored private var aliases: [Int: String] = [:]
	@ObservationIgnored private var deliveredClientIDs: Set<String> = []

	public init(
		conversationID: String, currentActorID: String, currentActorName: String,
		api: any ChatAPI, queue: ChatSendQueue, events: EventHub?, pageSize: Int = 50,
		spawnGrace: TimeInterval = 20, staleSessionAfter: TimeInterval = 20 * 60,
		pollInterval: Duration? = .seconds(5), cache: SnapshotCache? = nil,
		now: @escaping @Sendable () -> Date = { Date() }
	) {
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
		self.cache = cache
		self.now = now
		hydrateIfNeeded()
	}

	deinit {
		MainActor.assumeIsolated {
			listener?.cancel()
			queueListener?.cancel()
			poller?.cancel()
			if let deliveryObserver { queue.stopObservingDeliveries(deliveryObserver) }
		}
	}

	// MARK: - Derived

	public var participants: [ChatParticipant] { detail?.participants ?? [] }
	public var title: String { detail?.title ?? "Chat" }
	public var lastServerID: Int? { confirmed.last?.serverID }

	/// Server rows, then unconfirmed sends. Failed sends always show; a queued one is hidden once
	/// its confirmed twin is in the list.
	public var messages: [ChatMessage] {
		let rows = queue.pending(in: conversationID)
		var consumed: Set<Int> = []
		var shown: [ChatMessage] = []
		for row in rows {
			if case .failed = row.state {
				shown.append(row.asMessage(actorID: currentActorID, actorName: currentActorName))
				continue
			}
			if deliveredClientIDs.contains(row.id) { continue }
			if let twin = confirmedTwin(of: row, excluding: consumed) {
				consumed.insert(twin)
				continue
			}
			shown.append(row.asMessage(actorID: currentActorID, actorName: currentActorName))
		}
		return confirmed + shown
	}

	/// The confirmed row that is the server's copy of a queued send: mine, same text, and newer
	/// than anything I had seen when I sent it.
	private func confirmedTwin(of row: PendingChatSend, excluding consumed: Set<Int>) -> Int? {
		confirmed.first { message in
			guard let id = message.serverID, !consumed.contains(id) else { return false }
			return message.actorID == currentActorID && message.content == row.content
				&& id > (row.afterServerID ?? 0)
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

	/// Live agent sessions, one per agent (the newest), ignoring ones that have gone quiet.
	public func liveSessions(at date: Date? = nil) -> [ChatAgentSession] {
		let t = date ?? now()
		var seen: Set<String> = []
		return agentSessions.filter { session in
			guard session.status.isLive else { return false }
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
						await self.refreshSessions()
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
					if self.isActive, self.needsSessionPoll { await self.refreshSessions() }
				}
			}
		}
		await load()
	}

	public func stop() {
		listener?.cancel()
		listener = nil
		queueListener?.cancel()
		queueListener = nil
		if let deliveryObserver { queue.stopObservingDeliveries(deliveryObserver) }
		deliveryObserver = nil
		poller?.cancel()
		poller = nil
		trace?.stop()
	}

	/// Only poll sessions while something could change: an agent is running or a reply is due.
	private var needsSessionPoll: Bool {
		!liveSessions().isEmpty || awaitingReplySince != nil
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
		merge(entry.value.messages.map(\.message))
		hasEarlier = confirmed.count >= ChatCaching.threadMessageLimit
		phase = .loaded
		freshness.hydrated(from: entry.savedAt)
	}

	private func writeCache() {
		guard let cache, let detail else { return }
		let rows = confirmed.suffix(ChatCaching.threadMessageLimit).compactMap(ChatCaching.CachedMessage.init)
		cache.write(
			ChatCaching.ThreadSnapshot(detail: detail, messages: rows),
			ChatCaching.threadName(conversationID), version: ChatCaching.version)
	}

	public func load() async {
		hydrateIfNeeded()
		if confirmed.isEmpty { phase = .loading }
		do {
			async let detailTask = api.detail(conversationID: conversationID)
			async let pageTask = api.messages(
				conversationID: conversationID, beforeID: nil, afterID: nil, limit: pageSize)
			let (loadedDetail, page) = try await (detailTask, pageTask)
			detail = loadedDetail
			readSent = max(readSent, loadedDetail.lastReadMessageID ?? 0)
			mergeNewest(page)
			phase = .loaded
			freshness.refreshed(at: cache?.now() ?? now())
			writeCache()
			// Independent reads: run together so the working indicator and trace don't wait on
			// the actor list or the read receipt.
			async let read: Void = markReadIfNeeded()
			async let states: Void = refreshAgentStates()
			async let sessions: Void = refreshSessions()
			_ = await (read, states, sessions)
		} catch {
			// Cached or loaded rows stay on screen; only an empty thread shows the error.
			freshness.revalidateFailed()
			if confirmed.isEmpty { phase = .failed(Self.message(error)) }
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
				if let detail = await freshDetail {
					self.detail = detail
					readSent = max(readSent, detail.lastReadMessageID ?? 0)
				}
				freshness.refreshed(at: cache?.now() ?? now())
				writeCache()
				await markReadIfNeeded()
			} catch {
				freshness.revalidateFailed()
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
		agentSessions = sessions.sorted {
			($0.startedAt ?? .distantPast) > ($1.startedAt ?? .distantPast)
		}
		// Not awaited: fetching a finished turn's history must never delay the thread itself.
		Task { [trace, sessions = agentSessions] in await trace?.update(sessions: sessions) }
		onSessionsRefreshed?(agentSessions)
	}

	// MARK: - Send

	/// Queue a message. The bubble appears at once (it is read from the queue, which is on disk),
	/// and the outbox delivers it exactly once, now or when the network is back.
	@discardableResult
	public func send(_ text: String, metadata: ChatSendMetadata? = nil) -> String? {
		let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !content.isEmpty else { return nil }
		do {
			let pending = try queue.send(
				conversationID: conversationID, content: content, metadata: metadata,
				afterServerID: lastServerID)
			awaitingReplySince = now()
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
			guard deliveredClientIDs.insert(clientID).inserted else { return }
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

	public func removeParticipant(_ actorID: String) async {
		let before = detail
		detail?.participants.removeAll { $0.id == actorID }
		do {
			try await api.removeParticipant(conversationID: conversationID, actorID: actorID)
		} catch {
			detail = before
			notice = Self.message(error)
		}
	}

	/// Optimistic rename; rolled back if the server refuses.
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

	public func stopSession(_ id: String) async {
		do {
			try await api.stopSession(sessionID: id)
		} catch {
			notice = Self.message(error)
		}
		await refreshSessions()
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

	/// Advance the read cursor to the newest confirmed message. Never regresses, never repeats.
	/// Only while the thread is visible and the app is active.
	public func markReadIfNeeded() async {
		guard isActive, let last = lastServerID, last > readSent else { return }
		let previous = readSent
		readSent = last
		do {
			try await api.markRead(conversationID: conversationID, lastMessageID: last)
			detail?.unreadCount = 0
			onMarkedRead?(conversationID, last)
		} catch {
			readSent = previous
		}
	}

	// MARK: - Merging

	/// Fold in the newest page. When more than a page arrived since the last sync the page does
	/// not touch what we hold (a gap): drop the old rows and let `loadEarlier` page them back,
	/// rather than showing history with a hole in it.
	func mergeNewest(_ page: MessagePage) {
		let held = lastServerID
		let wasEmpty = confirmed.isEmpty
		if let held, page.hasMore, let first = page.messages.first?.serverID, first > held {
			confirmed = []
			hasEarlier = true
		}
		merge(page.messages)
		if wasEmpty { hasEarlier = page.hasMore }
	}

	/// Fold server rows into the confirmed list, ordered by server id however they arrive. A row
	/// already present is updated in place (keeping its row id), so SwiftUI never re-creates it.
	func merge(_ incoming: [ChatMessage]) {
		for var message in incoming {
			guard let serverID = message.serverID else { continue }
			if let index = confirmed.firstIndex(where: { $0.serverID == serverID }) {
				message.id = confirmed[index].id
				confirmed[index] = message
			} else {
				if let alias = aliases[serverID] { message.id = alias }
				confirmed.append(message)
			}
			if message.author == .agent, awaitingReplySince != nil,
				let sent = confirmed.last(where: { $0.actorID == currentActorID })?.serverID,
				serverID > sent
			{
				awaitingReplySince = nil
			}
		}
		confirmed.sort { ($0.serverID ?? 0) < ($1.serverID ?? 0) }
	}

	static func message(_ error: Error) -> String {
		if let http = error as? ChatsHTTPError { return http.message }
		return (error as? ChatsError)?.message ?? error.localizedDescription
	}
}
