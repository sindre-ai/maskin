import Foundation
import MaskinAPI

#if canImport(CoreSpotlight) && !os(tvOS)
	import CoreSpotlight
#endif

// Production wiring for `IntentsService`: Keychain session, the generated client behind the
// existing API adapters, the durable chat outbox, an on-disk memory and the Spotlight index.

// MARK: - Backend

/// Network side of the intents. Reuses the Chats / Agents adapters so generated operation names
/// stay private to them.
public struct APIIntentsBackend: IntentsBackend {
	private let agentsSource: APIAgentsSource
	private let chatsSource: APIChatsSource

	public init(client: Client, workspaceID: String) {
		agentsSource = APIAgentsSource(client: client, workspaceID: workspaceID)
		chatsSource = APIChatsSource(client: client, workspaceID: workspaceID)
	}

	public func agents() async throws -> [IntentAgent] {
		try await agentsSource.agents().map { IntentAgent(id: $0.id, name: $0.name, role: $0.role) }
	}

	public func conversations(offset: Int) async throws -> [ConversationSummary] {
		try await chatsSource.list(
			archived: false, pinnedOnly: false, unreadOnly: false,
			limit: ChatLimits.maxConversationsPage, offset: offset
		).conversations
	}

	public func startConversation(
		agentID: String, title: String, message: String, idempotencyKey: String
	) async throws -> ConversationSummary {
		try await chatsSource.create(
			title: title, participantIDs: [agentID], initialMessage: message,
			idempotencyKey: idempotencyKey)
	}

	public func run(agentID: String, prompt: String?, idempotencyKey: String) async throws {
		_ = try await agentsSource.run(agentID: agentID, prompt: prompt, idempotencyKey: idempotencyKey)
	}
}

// MARK: - Memory

/// Agents and thread links, in one small JSON file keyed by (actor, workspace) so another account
/// or workspace can never read them. Application Support, excluded from nothing sensitive: agent
/// names and conversation ids only, no message text.
public final class FileIntentsMemory: IntentsMemoryStoring, @unchecked Sendable {
	private let fileURL: URL
	private let lock = NSLock()

	public init(fileURL: URL = FileIntentsMemory.defaultFileURL()) { self.fileURL = fileURL }

	public static func defaultFileURL(fileManager: FileManager = .default) -> URL {
		let base =
			(try? fileManager.url(
				for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
			?? fileManager.temporaryDirectory
		return base.appendingPathComponent("Maskin", isDirectory: true)
			.appendingPathComponent("intents-memory.json")
	}

	private func key(_ scope: IntentScope) -> String { "\(scope.actorId)|\(scope.workspaceId)" }

	private func readAll() -> [String: IntentsMemory] {
		guard let data = try? Data(contentsOf: fileURL) else { return [:] }
		return (try? JSONDecoder().decode([String: IntentsMemory].self, from: data)) ?? [:]
	}

	public func load(_ scope: IntentScope) -> IntentsMemory {
		lock.withLock { readAll()[key(scope)] ?? IntentsMemory() }
	}

	public func save(_ memory: IntentsMemory, for scope: IntentScope) {
		lock.withLock {
			var all = readAll()
			all[key(scope)] = memory
			guard let data = try? JSONEncoder().encode(all) else { return }
			try? FileManager.default.createDirectory(
				at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
			try? data.write(to: fileURL, options: .atomic)
		}
	}

	public func clear() {
		lock.withLock { try? FileManager.default.removeItem(at: fileURL) }
	}
}

// MARK: - Queue

/// Hands an "Ask" message to the same durable chat outbox the Chats screen uses.
///
/// When the app has attached its environment (`IntentsHost.attach`), the message goes into the
/// app's own `ChatsRuntime` queue: one outbox, one writer. Otherwise (an extension, or an intent
/// that ran before the app finished launching) it is appended to the signed-in actor's outbox
/// file and sent from a standalone outbox, exactly like `OutboxDecisionQueue` does for
/// notification actions. Either way the message is on disk before this returns.
public struct OutboxIntentsQueue: IntentsMessageQueueing {
	private let session: @Sendable () -> StoredSession?
	private let baseURL: URL
	private let clientSource: String
	private let directory: URL?

	public init(
		baseURL: URL, clientSource: String, directory: URL? = nil,
		session: @escaping @Sendable () -> StoredSession?
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.directory = directory
		self.session = session
	}

	public func enqueue(conversationID: String, content: String) async throws {
		guard let stored = session(), let workspace = stored.workspaceId else {
			throw IntentsError.notSignedIn
		}
		let baseURL = baseURL
		let clientSource = clientSource
		let directory = directory
		try await MainActor.run {
			if let environment = IntentsHost.environment, environment.auth.session?.actorId == stored.actorId {
				try ChatsRuntime.shared(environment: environment)
					.queue.send(conversationID: conversationID, content: content)
				return
			}
			let client = MaskinClient.make(
				serverURL: baseURL, clientSource: clientSource,
				credentials: { MaskinCredentials(apiKey: stored.apiKey, workspaceId: workspace) })
			let outbox = Outbox(
				fileURL: ChatsRuntime.outboxFileURL(actorId: stored.actorId, directory: directory),
				executor: ChatSendExecutor(
					api: APIChatsSource(client: client, workspaceID: workspace), onDelivered: { _, _ in }),
				workspaceId: { workspace })
			let queue = ChatSendQueue(outbox: outbox)
			try queue.send(conversationID: conversationID, content: content)
		}
	}
}

/// What the app tells the intents about itself, so an intent that runs inside the app process
/// shares its stores instead of opening a second writer on the same files.
@MainActor
public enum IntentsHost {
	public private(set) static weak var environment: AppEnvironment?
	public static func attach(environment: AppEnvironment) { self.environment = environment }
}

// MARK: - Spotlight

/// Indexes agents so typing a name in Spotlight finds them. The unique id is `agent:<id>`;
/// `SpotlightAgentLink` turns a tapped result back into a thread.
public struct SpotlightAgentIndex: IntentsIndexing {
	public static let domain = "io.maskin.agents"

	public init() {}

	public func replaceAll(with agents: [IntentAgent], workspaceId: String) async {
		#if canImport(CoreSpotlight) && !os(tvOS)
			let index = CSSearchableIndex.default()
			let items = agents.map { agent -> CSSearchableItem in
				let attributes = CSSearchableItemAttributeSet(contentType: .item)
				attributes.title = agent.name
				attributes.contentDescription = agent.role
				attributes.keywords = ["Maskin", "agent", agent.name]
				return CSSearchableItem(
					uniqueIdentifier: SpotlightAgentLink.identifier(agentID: agent.id),
					domainIdentifier: Self.domain, attributeSet: attributes)
			}
			try? await index.deleteSearchableItems(withDomainIdentifiers: [Self.domain])
			if !items.isEmpty { try? await index.indexSearchableItems(items) }
		#endif
	}

	public func removeAll() async {
		#if canImport(CoreSpotlight) && !os(tvOS)
			try? await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [Self.domain])
		#endif
	}
}

public enum SpotlightAgentLink {
	static let prefix = "agent:"
	public static func identifier(agentID: String) -> String { prefix + agentID }
	/// The agent id behind a Spotlight result, or `nil` for anything that isn't one of ours.
	public static func agentID(fromIdentifier id: String) -> String? {
		guard id.hasPrefix(prefix) else { return nil }
		let rest = String(id.dropFirst(prefix.count))
		return DeepLink.isSafeID(rest) ? rest : nil
	}
}

// MARK: - Assembly

extension IntentsService {
	/// The service the app's intents use. `baseURL` is the API origin from Info.plist.
	public static func live(baseURL: URL, clientSource: String = "ios") -> IntentsService {
		let secrets = KeychainSecretStore()
		let session: @Sendable () -> StoredSession? = {
			guard let data = try? secrets.read() else { return nil }
			return try? JSONDecoder().decode(StoredSession.self, from: data)
		}
		return IntentsService(
			session: session,
			backend: { stored in
				let client = MaskinClient.make(
					serverURL: baseURL, clientSource: clientSource,
					credentials: {
						MaskinCredentials(apiKey: stored.apiKey, workspaceId: stored.workspaceId)
					})
				return APIIntentsBackend(client: client, workspaceID: stored.workspaceId ?? "")
			},
			queue: OutboxIntentsQueue(baseURL: baseURL, clientSource: clientSource, session: session),
			memory: FileIntentsMemory(), index: SpotlightAgentIndex(),
			needs: { await WidgetSnapshotLoader.live(baseURL: baseURL).load() })
	}
}
