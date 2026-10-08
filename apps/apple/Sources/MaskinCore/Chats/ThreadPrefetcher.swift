import Foundation

/// Keeps the on-disk copy of the few chats most likely to be opened next fresh, so a tap paints
/// the newest messages from disk instead of the last page saved the previous time the thread
/// was open (and then jumping when the network answers).
///
/// It fetches the newest page and the detail of a conversation (the same two reads
/// `ChatStore.load` makes) and writes them as the same `ChatCaching.ThreadSnapshot` entry
/// `ChatStore.hydrateIfNeeded` reads. It never marks anything read, builds no `ChatStore`, and
/// starts no pollers. Existing endpoints only.
@MainActor
public final class ThreadPrefetcher {
	/// How many conversations one pass may fetch.
	public static let defaultLimit = 5
	/// Recent conversations whose snapshot is inspected per pass (a cache read decodes JSON).
	private static let inspectLimit = 12

	private let api: any ChatAPI
	private let cache: SnapshotCache
	private let limit: Int
	private let debounce: Duration
	private let pageSize: Int
	private var pending: Task<Void, Never>?
	private var inFlight: [String: Task<Void, Never>] = [:]
	/// `lastMessageAt` each conversation was last fetched for, so an unchanged one is not refetched.
	private var fetchedFor: [String: Date] = [:]
	private var latest: [ConversationSummary] = []
	private var generation = 0
	/// Conversations with a thread on screen; their own store keeps their cache current.
	public var isOpen: @MainActor (String) -> Bool = { _ in false }

	public init(
		api: any ChatAPI, cache: SnapshotCache, limit: Int = ThreadPrefetcher.defaultLimit,
		debounce: Duration = .milliseconds(600), pageSize: Int = 50
	) {
		self.api = api
		self.cache = cache
		self.limit = max(limit, 0)
		self.debounce = debounce
		self.pageSize = min(max(pageSize, 1), ChatLimits.maxMessagesPage)
	}

	/// The conversation list just loaded or changed. Bursts coalesce into one pass.
	public func listChanged(_ conversations: [ConversationSummary]) {
		latest = conversations
		pending?.cancel()
		let delay = debounce
		pending = Task { [weak self] in
			if delay > .zero { try? await Task.sleep(for: delay) }
			guard !Task.isCancelled, let self else { return }
			await self.runPass()
		}
	}

	/// Sign-out or workspace switch: stop everything and forget what was fetched.
	public func cancelAll() {
		generation += 1
		pending?.cancel()
		pending = nil
		for task in inFlight.values { task.cancel() }
		inFlight = [:]
		fetchedFor = [:]
		latest = []
	}

	/// Run the selected fetches and wait for them (tests; the app uses `listChanged`).
	public func runPass() async {
		let picked = selection()
		let tasks = picked.compactMap { start($0) }
		for task in tasks { await task.value }
	}

	// MARK: - Selection

	/// The conversations worth fetching, most recent first: not archived, and either unread with
	/// nothing cached, or newer in the list than the newest cached message.
	func selection() -> [ConversationSummary] {
		Self.candidates(
			latest, limit: limit, newestCached: { [cache] id in
				cache.read(
					ChatCaching.ThreadSnapshot.self, ChatCaching.threadName(id),
					version: ChatCaching.version
				).map { CacheState.cached($0.value.messages.last?.createdAt) } ?? CacheState.missing
			}
		).filter { inFlight[$0.id] == nil && !isOpen($0.id) && fetchedFor[$0.id] != $0.lastMessageAt }
	}

	enum CacheState: Equatable {
		case missing
		case cached(Date?)
	}

	static func candidates(
		_ conversations: [ConversationSummary], limit: Int, tolerance: TimeInterval = 5,
		newestCached: (String) -> CacheState
	) -> [ConversationSummary] {
		let recent = conversations.filter { !$0.archived && $0.lastMessageAt != nil }
			.sorted { ($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast) }
			.prefix(inspectLimit)
		var picked: [ConversationSummary] = []
		for conversation in recent {
			guard picked.count < limit, let last = conversation.lastMessageAt else { break }
			switch newestCached(conversation.id) {
			case .missing:
				if conversation.unreadCount > 0 { picked.append(conversation) }
			case .cached(let newest):
				guard let newest else {
					picked.append(conversation)
					continue
				}
				if last.timeIntervalSince(newest) > tolerance { picked.append(conversation) }
			}
		}
		return picked
	}

	// MARK: - Fetching

	private func start(_ conversation: ConversationSummary) -> Task<Void, Never>? {
		guard inFlight[conversation.id] == nil else { return nil }
		let id = conversation.id
		let mine = generation
		let task = Task { [weak self] in
			guard let self else { return }
			await self.fetch(conversation, generation: mine)
		}
		inFlight[id] = task
		return task
	}

	private func fetch(_ conversation: ConversationSummary, generation mine: Int) async {
		let id = conversation.id
		defer { if mine == generation { inFlight[id] = nil } }
		do {
			async let detailTask = api.detail(conversationID: id)
			async let pageTask = api.messages(
				conversationID: id, beforeID: nil, afterID: nil, limit: pageSize)
			let (detail, page) = try await (detailTask, pageTask)
			// The user may have switched workspace or signed out while this was in flight.
			guard mine == generation, !Task.isCancelled, !isOpen(id) else { return }
			write(detail: detail, page: page, id: id)
			fetchedFor[id] = conversation.lastMessageAt
		} catch {
			// Best effort: the thread loads normally when opened.
		}
	}

	private func write(detail: ConversationSummary, page: MessagePage, id: String) {
		let name = ChatCaching.threadName(id)
		let rows = page.messages.suffix(ChatCaching.threadMessageLimit)
			.compactMap(ChatCaching.CachedMessage.init)
		guard let newest = rows.last?.serverID else { return }
		// Never move a snapshot backwards (a thread may have written a newer one meanwhile).
		if let existing = cache.read(
			ChatCaching.ThreadSnapshot.self, name, version: ChatCaching.version),
			let held = existing.value.messages.last?.serverID, held >= newest
		{
			return
		}
		cache.write(
			ChatCaching.ThreadSnapshot(detail: detail, messages: Array(rows)), name,
			version: ChatCaching.version)
	}
}
