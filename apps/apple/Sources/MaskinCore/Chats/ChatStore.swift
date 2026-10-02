import Foundation
import MaskinAPI
import Observation

/// One open conversation: paged history, optimistic send with a stable idempotency key, live
/// updates from the event hub, read state, and "an agent is working" status.
///
/// Message model (matches the backend): every message has an integer id that only grows.
/// Agent replies are not token-streamed over the wire. A turn's text lands as one message when
/// the agent finishes, announced by a `conversation` event. What the user sees between sending
/// and that reply is `workingAgents`: the participants that are running, or all agent
/// participants for a while after a send. The list stays ordered by id however events arrive.
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
	/// Oldest first: confirmed messages by server id, then messages still being sent.
	public private(set) var messages: [ChatMessage] = []
	public private(set) var phase: Phase = .idle
	public private(set) var hasEarlier = false
	public private(set) var isLoadingEarlier = false
	public private(set) var agentStates: [String: ChatActor.AgentState] = [:]
	/// Agents the user is waiting on, newest send first. Cleared when a reply lands.
	public private(set) var awaitingReplySince: Date?
	public var notice: String?
	/// Set while the thread is on screen; read state only advances then.
	public var isActive = true {
		didSet { if isActive && !oldValue { Task { await markReadIfNeeded() } } }
	}
	/// Told after the server accepted a read cursor, so the list's unread badge clears too.
	@ObservationIgnored public var onMarkedRead: (@MainActor (String, Int) -> Void)?

	@ObservationIgnored private let api: any ChatAPI
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private let makeKey: @Sendable () -> String
	@ObservationIgnored private let pageSize: Int
	@ObservationIgnored private let replyWindow: TimeInterval
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var syncing = false
	@ObservationIgnored private var syncQueued = false
	@ObservationIgnored private var readSent = 0
	@ObservationIgnored private var inFlight: Set<String> = []

	public init(
		conversationID: String, currentActorID: String, currentActorName: String,
		api: any ChatAPI, events: EventHub?, pageSize: Int = 50, replyWindow: TimeInterval = 180,
		now: @escaping @Sendable () -> Date = { Date() },
		makeKey: @escaping @Sendable () -> String = { IdempotencyKey.make() }
	) {
		self.conversationID = conversationID
		self.currentActorID = currentActorID
		self.currentActorName = currentActorName
		self.api = api
		self.events = events
		self.pageSize = pageSize
		self.replyWindow = replyWindow
		self.now = now
		self.makeKey = makeKey
	}

	// MARK: - Derived

	public var participants: [ChatParticipant] { detail?.participants ?? [] }
	public var title: String { detail?.title ?? "Chat" }
	public var lastServerID: Int? { messages.compactMap(\.serverID).max() }

	/// Agents to show a "working" row for. Running agents win; otherwise, shortly after a send,
	/// every agent participant (the backend is routing the message to them).
	public func workingAgents(at date: Date? = nil) -> [ChatParticipant] {
		let agents = participants.filter { $0.kind == .agent && $0.id != currentActorID }
		let running = agents.filter { agentStates[$0.id] == .running }
		if !running.isEmpty { return running }
		guard let since = awaitingReplySince, (date ?? now()).timeIntervalSince(since) < replyWindow
		else { return [] }
		return agents
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
					case .event(let event) where event.entityType == .conversation && event.entityId == self.conversationID:
						await self.sync(full: event.action == "message_updated")
					case .event(let event) where event.entityType == .actor:
						await self.refreshAgentStates()
					case .event:
						break
					}
				}
			}
		}
		await load()
	}

	public func stop() {
		listener?.cancel()
		listener = nil
	}

	public func load() async {
		if messages.isEmpty { phase = .loading }
		do {
			async let detailTask = api.detail(conversationID: conversationID)
			async let pageTask = api.messages(
				conversationID: conversationID, beforeID: nil, afterID: nil, limit: pageSize)
			let (loadedDetail, page) = try await (detailTask, pageTask)
			detail = loadedDetail
			readSent = max(readSent, loadedDetail.lastReadMessageID ?? 0)
			merge(page.messages)
			hasEarlier = page.hasMore
			phase = .loaded
			await markReadIfNeeded()
			await refreshAgentStates()
		} catch {
			if messages.isEmpty { phase = .failed(Self.message(error)) } else { notice = Self.message(error) }
		}
	}

	public func loadEarlier() async {
		guard hasEarlier, !isLoadingEarlier, let oldest = messages.compactMap(\.serverID).min() else { return }
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

	/// Pull what changed. Incremental (`after_id`) for new messages; `full` re-reads the newest
	/// page so edits and anything missed during a reconnect are picked up. Bursts coalesce.
	public func sync(full: Bool = false) async {
		if syncing {
			syncQueued = true
			return
		}
		syncing = true
		defer { syncing = false }
		var wantFull = full
		repeat {
			syncQueued = false
			do {
				let page: MessagePage
				if wantFull || lastServerID == nil {
					page = try await api.messages(
						conversationID: conversationID, beforeID: nil, afterID: nil, limit: pageSize)
				} else {
					page = try await api.messages(
						conversationID: conversationID, beforeID: nil, afterID: lastServerID, limit: pageSize)
				}
				merge(page.messages)
				if let detail = try? await api.detail(conversationID: conversationID) {
					self.detail = detail
					readSent = max(readSent, detail.lastReadMessageID ?? 0)
				}
				await markReadIfNeeded()
			} catch {
				notice = Self.message(error)
			}
			wantFull = false
		} while syncQueued
	}

	public func refreshAgentStates() async {
		guard let actors = try? await api.actors() else { return }
		var states: [String: ChatActor.AgentState] = [:]
		for a in actors where a.participant.kind == .agent { states[a.id] = a.agentState }
		agentStates = states
	}

	// MARK: - Send

	/// Send a message. The bubble appears immediately; on failure it stays with a failed state
	/// and `retrySend` reuses the same idempotency key, so a lost response never double-posts.
	@discardableResult
	public func send(_ text: String) -> String? {
		let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !content.isEmpty else { return nil }
		let key = makeKey()
		let pending = ChatMessage(
			id: "local-\(key)", conversationID: conversationID, actorID: currentActorID,
			actorName: currentActorName, author: .human, content: content, createdAt: now(),
			status: .sending, idempotencyKey: key)
		messages.append(pending)
		reorder()
		Task { await deliver(pending.id) }
		return pending.id
	}

	public func retrySend(_ id: String) {
		guard let index = messages.firstIndex(where: { $0.id == id }), messages[index].isFailed else { return }
		messages[index].status = .sending
		Task { await deliver(id) }
	}

	/// Drop a message that never reached the server.
	public func discard(_ id: String) {
		guard let m = messages.first(where: { $0.id == id }), m.isPending else { return }
		messages.removeAll { $0.id == id }
	}

	/// Awaitable form of the delivery, for tests and callers that need completion.
	public func deliver(_ id: String) async {
		guard let message = messages.first(where: { $0.id == id }), message.isPending,
			let key = message.idempotencyKey, inFlight.insert(id).inserted
		else { return }
		defer { inFlight.remove(id) }
		do {
			let saved = try await api.send(
				conversationID: conversationID, content: message.content, idempotencyKey: key)
			confirm(localID: id, with: saved)
			awaitingReplySince = now()
			Task { await self.refreshAgentStates() }
		} catch {
			if let index = messages.firstIndex(where: { $0.id == id }) {
				messages[index].status = .failed(Self.message(error))
			}
		}
	}

	/// Ask the agents to answer again. `messageID` is the human message the reply belongs to
	/// (the web retries the triggering message; for a failed agent reply that is the message
	/// just before it).
	public func retryAgent(for message: ChatMessage) async {
		let target: Int?
		if message.author == .agent {
			target = messages.last(where: { ($0.serverID ?? 0) < (message.serverID ?? 0) && $0.author == .human })?.serverID
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

	public func addParticipants(_ ids: [String]) async {
		guard !ids.isEmpty else { return }
		do {
			try await api.addParticipants(conversationID: conversationID, actorIDs: ids)
			if let detail = try? await api.detail(conversationID: conversationID) { self.detail = detail }
		} catch {
			notice = Self.message(error)
		}
	}

	// MARK: - Read state

	/// Advance the read cursor to the newest confirmed message. Never regresses, never repeats.
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

	/// Fold server rows into the list. A row already present (by server id) is updated in place,
	/// so ids stay stable; an incoming row that matches a message we are still sending (its
	/// response lost the race with the event) adopts that row instead of duplicating it.
	func merge(_ incoming: [ChatMessage]) {
		for message in incoming {
			guard let serverID = message.serverID else { continue }
			if let index = messages.firstIndex(where: { $0.serverID == serverID }) {
				var updated = message
				updated.id = messages[index].id
				messages[index] = updated
			} else {
				messages.append(message)
			}
			if message.author == .agent, awaitingReplySince != nil,
				let sent = messages.last(where: { $0.actorID == currentActorID && $0.serverID != nil })?.serverID,
				serverID > sent
			{
				awaitingReplySince = nil
			}
		}
		reorder()
	}

	private func confirm(localID: String, with saved: ChatMessage) {
		guard let serverID = saved.serverID else { return }
		if messages.contains(where: { $0.serverID == serverID }) {
			// The event-driven refetch already inserted this message: keep that one.
			messages.removeAll { $0.id == localID }
		} else if let index = messages.firstIndex(where: { $0.id == localID }) {
			var confirmed = saved
			confirmed.id = localID
			messages[index] = confirmed
		}
		reorder()
		Task { await markReadIfNeeded() }
	}

	private func reorder() {
		let confirmed = messages.filter { !$0.isPending }.sorted { ($0.serverID ?? 0) < ($1.serverID ?? 0) }
		let pending = messages.filter(\.isPending).sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
		messages = confirmed + pending
	}

	static func message(_ error: Error) -> String {
		(error as? ChatsError)?.message ?? error.localizedDescription
	}
}
