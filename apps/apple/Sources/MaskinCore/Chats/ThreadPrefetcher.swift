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
	/// How many of them are in flight at once. Each is two requests, and the pass lands right after the
	/// list loads, while the feed, the event stream and the user's first taps want the connection too.
	private static let concurrency = 2
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
		let mine = generation
		let picked = await selection()
		var rest = picked[...]
		while !rest.isEmpty, mine == generation {
			let batch = rest.prefix(Self.concurrency)
			rest = rest.dropFirst(batch.count)
			// A conversation another pass is already fetching still counts: wait for that fetch, so
			// this returns only once everything it was asked about has been written.
			let tasks = batch.compactMap { start($0) ?? inFlight[$0.id] }
			for task in tasks { await task.value }
		}
		// `selection()` leaves out a conversation another pass is already fetching, so its fetch is
		// not one of ours; wait for those too, so this returns only once the cache is current.
		for task in Array(inFlight.values) { await task.value }
	}

	// MARK: - Selection

	/// The conversations worth fetching, most recent first: not archived, and either unread with
	/// nothing cached, or newer in the list than the newest cached message.
	///
	/// Finding out what is cached means decoding each candidate's snapshot (50 messages of JSON), so
	/// the reads run off the main actor and the result is filtered against live state afterwards.
	func selection() async -> [ConversationSummary] {
		let inspected = Self.recent(latest)
		let disk = cache.disk
		let keys: [(id: String, key: DiskCache.Key)] = inspected.compactMap { conversation in
			cache.resolvedKey(ChatCaching.threadName(conversation.id)).map { (conversation.id, $0) }
		}
		let newest = await Task.detached(priority: .utility) {
			var found: [String: CacheState] = [:]
			for (id, key) in keys {
				found[id] =
					disk.read(ChatCaching.ThreadSnapshot.self, key: key, version: ChatCaching.version)
					.map { CacheState.cached($0.value.messages.last?.createdAt) } ?? .missing
			}
			return found
		}.value
		return Self.candidates(latest, limit: limit, newestCached: { newest[$0] ?? .missing })
			.filter { inFlight[$0.id] == nil && !isOpen($0.id) && fetchedFor[$0.id] != $0.lastMessageAt }
	}

	enum CacheState: Equatable, Sendable {
		case missing
		case cached(Date?)
	}

	/// The recent, unarchived conversations a pass looks at, newest activity first.
	static func recent(_ conversations: [ConversationSummary]) -> [ConversationSummary] {
		Array(
			conversations.filter { !$0.archived && $0.lastMessageAt != nil }
				.sorted { ($0.activityDate ?? .distantPast) > ($1.activityDate ?? .distantPast) }
				.prefix(inspectLimit))
	}

	static func candidates(
		_ conversations: [ConversationSummary], limit: Int, tolerance: TimeInterval = 5,
		newestCached: (String) -> CacheState
	) -> [ConversationSummary] {
		var picked: [ConversationSummary] = []
		for conversation in recent(conversations) {
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
			await write(detail: detail, page: page, id: id)
			guard mine == generation else { return }
			fetchedFor[id] = conversation.lastMessageAt
		} catch {
			// Best effort: the thread loads normally when opened.
		}
	}

	private func write(detail: ConversationSummary, page: MessagePage, id: String) async {
		let rows = page.messages.suffix(ChatCaching.threadMessageLimit)
			.compactMap(ChatCaching.CachedMessage.init)
		guard let newest = rows.last?.serverID,
			let key = cache.resolvedKey(ChatCaching.threadName(id))
		else { return }
		let snapshot = ChatCaching.ThreadSnapshot(detail: detail, messages: Array(rows))
		let disk = cache.disk
		// Decoding the snapshot already on disk and encoding the new one is not main-actor work.
		await Task.detached(priority: .utility) {
			// Never move a snapshot backwards (a thread may have written a newer one meanwhile).
			if let existing = disk.read(
				ChatCaching.ThreadSnapshot.self, key: key, version: ChatCaching.version),
				let held = existing.value.messages.last?.serverID, held >= newest
			{
				return
			}
			disk.write(snapshot, key: key, version: ChatCaching.version)
		}.value
	}
}
