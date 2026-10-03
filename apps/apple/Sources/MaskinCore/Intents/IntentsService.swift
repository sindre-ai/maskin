import Foundation

// The logic behind Siri / Shortcuts / Spotlight, with no AppIntents import. The `AppIntent`
// types (see `MaskinIntents.swift`) are thin shells over `IntentsService`, so everything that can
// go wrong is unit-tested here against stubs.
//
// PROCESS-INDEPENDENT: the service reads the signed-in session from the shared Keychain and talks
// to the API itself. It needs nothing from the running app (no stores, no EventHub), so the same
// code serves an intent that runs in the app process and one hosted by an extension.

/// An agent as the intents see it: just enough to pick it and to say its name.
public struct IntentAgent: Codable, Hashable, Sendable, Identifiable {
	public var id: String
	public var name: String
	public var role: String

	public init(id: String, name: String, role: String = "Agent") {
		self.id = id
		self.name = name
		self.role = role
	}
}

/// Whose data a cache entry belongs to.
public struct IntentScope: Hashable, Sendable {
	public var actorId: String
	public var workspaceId: String
	public init(actorId: String, workspaceId: String) {
		self.actorId = actorId
		self.workspaceId = workspaceId
	}
}

/// What the intents remember between runs so they work offline: the agent list (for the picker)
/// and which conversation is the direct thread with each agent (so "Ask" can queue a message
/// without a round trip).
public struct IntentsMemory: Codable, Sendable, Equatable {
	public var agents: [IntentAgent] = []
	/// agent id to the direct conversation with that agent.
	public var threads: [String: String] = [:]
	public init(agents: [IntentAgent] = [], threads: [String: String] = [:]) {
		self.agents = agents
		self.threads = threads
	}
}

public protocol IntentsMemoryStoring: Sendable {
	func load(_ scope: IntentScope) -> IntentsMemory
	func save(_ memory: IntentsMemory, for scope: IntentScope)
	func clear()
}

/// What the intents need from the network.
public protocol IntentsBackend: Sendable {
	func agents() async throws -> [IntentAgent]
	/// The first page of the caller's active conversations.
	func conversations() async throws -> [ConversationSummary]
	/// Creates a conversation with one agent and sends `message` as its first turn.
	func startConversation(
		agentID: String, title: String, message: String, idempotencyKey: String
	) async throws -> ConversationSummary
	func run(agentID: String, prompt: String?, idempotencyKey: String) async throws
}

/// Puts a message in the durable send queue (the same outbox the Chats screen uses).
public protocol IntentsMessageQueueing: Sendable {
	func enqueue(conversationID: String, content: String) async throws
}

/// Tells Spotlight about the agents. A no-op where CoreSpotlight is unavailable.
public protocol IntentsIndexing: Sendable {
	func replaceAll(with agents: [IntentAgent], workspaceId: String) async
	func removeAll() async
}

public enum IntentsError: Error, Equatable, Sendable {
	case notSignedIn
	case emptyMessage
	case messageTooLong
	case unknownAgent
	/// Needs the network (first message to an agent, running an agent) and there is none.
	case offline(String)
	case failed(String)

	/// What Siri says / the Shortcuts banner shows. Plain words, no ids.
	public var message: String {
		switch self {
		case .notSignedIn: "Open Maskin and sign in first."
		case .emptyMessage: "There's nothing to send. Say what you want to ask."
		case .messageTooLong: "That message is too long to send."
		case .unknownAgent: "I couldn't find that agent in this workspace."
		case .offline(let what): what
		case .failed(let reason): reason
		}
	}
}

public enum AskOutcome: Equatable, Sendable {
	/// Handed to the durable queue; it goes out now if online, otherwise when the connection is back.
	case queued(conversationID: String)
	/// A brand-new conversation was created with the message as its first turn.
	case started(conversationID: String)

	public var conversationID: String {
		switch self {
		case .queued(let id), .started(let id): id
		}
	}
}

public struct IntentsService: Sendable {
	public typealias SessionProvider = @Sendable () -> StoredSession?
	public typealias NeedsLoader = @Sendable () async -> WidgetState

	private let session: SessionProvider
	private let backend: @Sendable (StoredSession) -> any IntentsBackend
	private let queue: any IntentsMessageQueueing
	private let memory: any IntentsMemoryStoring
	private let index: any IntentsIndexing
	private let needs: NeedsLoader
	private let makeKey: @Sendable () -> String

	public init(
		session: @escaping SessionProvider,
		backend: @escaping @Sendable (StoredSession) -> any IntentsBackend,
		queue: any IntentsMessageQueueing, memory: any IntentsMemoryStoring,
		index: any IntentsIndexing, needs: @escaping NeedsLoader,
		makeKey: @escaping @Sendable () -> String = { UUID().uuidString }
	) {
		self.session = session
		self.backend = backend
		self.queue = queue
		self.memory = memory
		self.index = index
		self.needs = needs
		self.makeKey = makeKey
	}

	// MARK: What needs me

	/// A short summary of what is waiting on the user, from the same feed the For You tab and
	/// the widgets read.
	public func whatNeedsMe() async -> NeedsMeSummary {
		NeedsMeSummary(state: await needs().resolved(at: Date()))
	}

	// MARK: Agents

	/// Cached agents first (instant, works offline); the network refreshes the cache and the
	/// Spotlight index when it answers. Signed out: nothing, and the cache and index are wiped.
	public func agents(refresh: Bool = true) async -> [IntentAgent] {
		guard let session = signedIn() else {
			memory.clear()
			await index.removeAll()
			return []
		}
		let scope = scope(of: session)
		var stored = memory.load(scope)
		if refresh || stored.agents.isEmpty, let fresh = try? await backend(session).agents() {
			stored.agents = fresh.sorted {
				$0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
			}
			// Drop thread links to agents that no longer exist.
			let ids = Set(stored.agents.map(\.id))
			stored.threads = stored.threads.filter { ids.contains($0.key) }
			memory.save(stored, for: scope)
			await index.replaceAll(with: stored.agents, workspaceId: scope.workspaceId)
		}
		return stored.agents
	}

	/// The agents whose id is in `ids`, in the order asked. Cache only: resolving a saved
	/// Shortcut must not wait for the network.
	public func agents(ids: [String]) async -> [IntentAgent] {
		let all = await agents(refresh: false)
		return ids.compactMap { id in all.first { $0.id == id } }
	}

	public func agents(matching query: String) async -> [IntentAgent] {
		let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
		let all = await agents()
		guard !needle.isEmpty else { return all }
		return all.filter { $0.name.localizedCaseInsensitiveContains(needle) }
	}

	// MARK: Ask

	/// Sends `message` to `agentID`. Goes through the durable chat queue whenever the direct
	/// thread is known (so it works offline); the very first message to an agent has to create the
	/// conversation, which needs the network.
	@discardableResult
	public func ask(agentID: String, message: String) async throws -> AskOutcome {
		let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty else { throw IntentsError.emptyMessage }
		guard text.count <= ChatLimits.maxMessageLength else { throw IntentsError.messageTooLong }
		let session = try requireSession()
		let scope = scope(of: session)
		var stored = memory.load(scope)
		guard let agent = stored.agents.first(where: { $0.id == agentID }) else {
			throw IntentsError.unknownAgent
		}

		if stored.threads[agentID] == nil,
			let found = try? await directThread(with: agent, session: session)
		{
			stored.threads[agentID] = found
			memory.save(stored, for: scope)
		}
		if let thread = stored.threads[agentID] {
			do {
				try await queue.enqueue(conversationID: thread, content: text)
			} catch {
				throw IntentsError.failed("Couldn't save that message. Open Maskin and try again.")
			}
			return .queued(conversationID: thread)
		}

		// No thread yet: create one. This is the only part that cannot be deferred.
		do {
			let created = try await backend(session).startConversation(
				agentID: agentID, title: agent.name, message: text, idempotencyKey: makeKey())
			stored.threads[agentID] = created.id
			memory.save(stored, for: scope)
			return .started(conversationID: created.id)
		} catch {
			throw Self.classify(
				error,
				offline:
					"You're offline. Starting a first conversation with \(agent.name) needs a connection.",
				fallback: "Couldn't start a conversation with \(agent.name).")
		}
	}

	/// Where "open this agent's thread" goes: the `maskin://<ws>/chats/<id>` link, or `nil` when
	/// there is no direct thread yet.
	public func threadLink(agentID: String) async -> DeepLink? {
		guard let session = signedIn(), let workspace = session.workspaceId else { return nil }
		let scope = scope(of: session)
		var stored = memory.load(scope)
		if stored.threads[agentID] == nil, let agent = stored.agents.first(where: { $0.id == agentID }),
			let found = try? await directThread(with: agent, session: session)
		{
			stored.threads[agentID] = found
			memory.save(stored, for: scope)
		}
		return stored.threads[agentID].map { DeepLink.chat(workspaceId: workspace, id: $0) }
	}

	// MARK: Run

	public func run(agentID: String, prompt: String?) async throws {
		let session = try requireSession()
		let trimmed = prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
		let name = memory.load(scope(of: session)).agents.first { $0.id == agentID }?.name ?? "the agent"
		do {
			try await backend(session).run(
				agentID: agentID, prompt: trimmed?.isEmpty == false ? trimmed : nil,
				idempotencyKey: makeKey())
		} catch {
			throw Self.classify(
				error, offline: "You're offline. Running \(name) needs a connection.",
				fallback: (error as? AgentsError)?.message ?? "Couldn't run \(name).")
		}
	}

	// MARK: Internals

	private func signedIn() -> StoredSession? {
		guard let stored = session(), !stored.apiKey.isEmpty, let ws = stored.workspaceId, !ws.isEmpty
		else { return nil }
		return stored
	}

	private func requireSession() throws -> StoredSession {
		guard let stored = signedIn() else { throw IntentsError.notSignedIn }
		return stored
	}

	private func scope(of session: StoredSession) -> IntentScope {
		IntentScope(actorId: session.actorId, workspaceId: session.workspaceId ?? "")
	}

	/// The conversation that is exactly "me and this agent". Newest first, as the list returns it.
	private func directThread(with agent: IntentAgent, session: StoredSession) async throws -> String? {
		let rows = try await backend(session).conversations()
		return Self.directThread(in: rows, agentID: agent.id, me: session.actorId)
	}

	static func directThread(in rows: [ConversationSummary], agentID: String, me: String) -> String? {
		rows.first { row in
			!row.archived && row.participants.count == 2
				&& Set(row.participants.map(\.id)) == [me, agentID]
		}?.id
	}

	static func classify(_ error: any Error, offline: String, fallback: String) -> IntentsError {
		if let known = error as? IntentsError { return known }
		if let url = error as? URLError {
			switch url.code {
			case .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost,
				.cannotFindHost, .dataNotAllowed:
				return .offline(offline)
			default: break
			}
		}
		if let http = error as? ChatsHTTPError, http.status == 401 { return .notSignedIn }
		return .failed(fallback)
	}
}
