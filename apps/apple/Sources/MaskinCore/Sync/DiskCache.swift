import CryptoKit
import Foundation

/// A small, generic, versioned on-disk cache so the app opens on the user's last-known real data
/// instead of an empty spinner (stale-while-revalidate; see `Sync/README.md`).
///
/// PRIVACY STANCE
/// - Holds only what a screen already shows (lists, summaries). NEVER credentials, API keys, or
///   message bodies beyond a screen's own snippet. Stores decide what to put in; this type has no
///   way to know, so stores must cache view-sized snapshots, not raw API payloads.
/// - Keyed by (actorId, workspaceId, name). Each actor gets a separate directory named by a
///   one-way hash, so actor A's entries are structurally unreachable when actor B reads, and a
///   hostile id can never escape the cache directory.
/// - Lives under Application Support (not Caches, which the system may purge mid-session, and not
///   iCloud-backed: the directory is excluded from backup). Files use
///   complete-until-first-user-authentication protection where the platform supports it.
/// - `clear(actorId:)`, `clear(workspaceId:)` and the static `clearAll()` exist for sign-out and
///   workspace deletion.
///
/// ROBUSTNESS: every entry carries a schema `version`. A version mismatch, a corrupt file, an
/// expired entry or a decode failure discards the entry and reports a miss; nothing here throws
/// into a caller or crashes.
public final class DiskCache: @unchecked Sendable {
	public struct Key: Hashable, Sendable {
		public var actorId: String
		/// `nil` for actor-level entries such as the workspace list.
		public var workspaceId: String?
		public var name: String

		public init(actorId: String, workspaceId: String? = nil, name: String) {
			self.actorId = actorId
			self.workspaceId = workspaceId
			self.name = name
		}
	}

	public struct Entry<Value: Sendable>: Sendable {
		public var value: Value
		/// When it was written (the data's age, not the app's).
		public var savedAt: Date
	}

	public struct Limits: Sendable, Equatable {
		/// Entries older than this are discarded on read and evicted on write.
		public var maxAge: TimeInterval
		/// Total size bound; the least-recently-used entries are evicted past it.
		public var maxTotalBytes: Int
		/// One entry larger than this is not stored at all.
		public var maxEntryBytes: Int

		public init(
			maxAge: TimeInterval = 14 * 24 * 3600, maxTotalBytes: Int = 24 * 1024 * 1024,
			maxEntryBytes: Int = 4 * 1024 * 1024
		) {
			self.maxAge = maxAge
			self.maxTotalBytes = maxTotalBytes
			self.maxEntryBytes = maxEntryBytes
		}

		public static let `default` = Limits()
	}

	/// Where the cache lives by default: `Application Support/Maskin/Cache`.
	public static func defaultDirectory(fileManager: FileManager = .default) -> URL {
		let base =
			(try? fileManager.url(
				for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
			?? fileManager.temporaryDirectory
		return base.appendingPathComponent("Maskin", isDirectory: true)
			.appendingPathComponent("Cache", isDirectory: true)
	}

	/// The process-wide cache stores use unless one is injected.
	public static let shared = DiskCache()

	private struct Header: Codable {
		var format: Int
		var version: Int
		var savedAt: Date
	}

	private struct Envelope<Value: Codable>: Codable {
		var format: Int
		var version: Int
		var savedAt: Date
		var value: Value
	}

	/// Bump to invalidate every file ever written (envelope layout change).
	private static var format: Int { 1 }
	private static let fileExtension = "cache"

	private let directory: URL
	private let fileManager: FileManager
	private let limits: Limits
	private let now: @Sendable () -> Date
	/// Guards the small in-memory state below. Never held across file I/O. A condition so that a
	/// read can wait for the queued writes to its own file and be woken when they land.
	private let lock = NSCondition()
	/// Writes (encode plus atomic file write), removals and clears run here, in order, off the caller's
	/// thread. Stores are `@MainActor`, so doing this inline cost a frame per cache write. Nothing
	/// slow but a write sits on this queue: eviction has its own, so a clear or a discard never
	/// waits behind a directory scan.
	private let ioQueue = DispatchQueue(label: "io.maskin.diskcache", qos: .utility)
	/// Eviction (the directory scans) and LRU write-backs. Kept apart from `ioQueue` so a scan can
	/// never sit in front of a write, and reads never wait for it at all.
	private let evictionQueue = DispatchQueue(label: "io.maskin.diskcache.eviction", qos: .utility)
	private var directoryPrepared = false
	/// File path -> number of writes queued but not yet on disk. A read of such a path waits until
	/// they land (and only those: not other files' writes, not eviction), so a write is always
	/// visible to the next read of the same key.
	private var pendingWrites: [String: Int] = [:]
	/// When each file was last read this process. Eviction orders by this (or the file's own
	/// modification date, whichever is later), so a read counts as a use without a `setAttributes`
	/// syscall on the reading thread.
	private var lastUsed: [String: Date] = [:]
	/// When a read's use was last written back to the file, so relaunches keep a sane LRU order.
	private var lastPersistedUse: [String: Date] = [:]
	/// Sum of the sizes of every cache file, once known; nil until the first full scan. Lets a write
	/// skip the directory scan unless the bound is actually in danger.
	private var knownTotal: Int?
	private var lastAgeSweep: Date?
	/// Bumped whenever `knownTotal` is invalidated (a clear, a removal). A scan that started before
	/// the bump must not publish its result.
	private var generation = 0
	/// True while a scan runs. Writes that land meanwhile add their size change to `deltaDuringScan`,
	/// which the scan folds into the total it publishes.
	private var scanning = false
	private var deltaDuringScan = 0

	public init(
		directory: URL? = nil, fileManager: FileManager = .default, limits: Limits = .default,
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.directory = directory ?? Self.defaultDirectory(fileManager: fileManager)
		self.fileManager = fileManager
		self.limits = limits
		self.now = now
	}

	// MARK: Read / write

	/// The cached value for `key`, or nil on a miss, a different `version`, an expired entry or
	/// any decode failure (those are deleted so they are not retried).
	public func read<Value: Codable & Sendable>(
		_ type: Value.Type, key: Key, version: Int
	) -> Entry<Value>? {
		let url = fileURL(for: key)
		// A write to this very file is still queued: let it land so the read sees it.
		awaitPendingWrites(at: url.path)
		guard let data = try? Data(contentsOf: url) else {
			SyncLog.cache.debug("miss name=\(key.name, privacy: .public) reason=absent")
			return nil
		}
		let decoder = Self.decoder()
		// One decode on the hot path. The header is only decoded to say WHY a file was unusable.
		guard let envelope = try? decoder.decode(Envelope<Value>.self, from: data) else {
			guard let header = try? decoder.decode(Header.self, from: data) else {
				discard(url, name: key.name, reason: "corrupt", observed: data)
				return nil
			}
			discard(url, name: key.name, reason: Self.reason(for: header, version: version, limits: limits, now: now()), observed: data)
			return nil
		}
		guard envelope.format == Self.format, envelope.version == version else {
			discard(url, name: key.name, reason: "version", observed: data)
			return nil
		}
		if now().timeIntervalSince(envelope.savedAt) > limits.maxAge {
			discard(url, name: key.name, reason: "expired", observed: data)
			return nil
		}
		noteUse(of: url)
		SyncLog.cache.debug("hit name=\(key.name, privacy: .public) bytes=\(data.count)")
		return Entry(value: envelope.value, savedAt: envelope.savedAt)
	}

	/// Store `value`. Atomic; replaces any previous entry. Silently drops values over the
	/// per-entry bound or when the disk refuses (a cache must never break a screen).
	///
	/// Returns immediately: the encode and the file write happen on a background queue, and any
	/// later read, removal or clear of the same cache is ordered after it. Use `flush()` to wait.
	public func write<Value: Codable & Sendable>(_ value: Value, key: Key, version: Int) {
		let url = fileURL(for: key)
		let savedAt = now()
		lock.lock()
		pendingWrites[url.path, default: 0] += 1
		lock.unlock()
		ioQueue.async { [self] in
			defer { writeFinished(at: url.path) }
			let envelope = Envelope(
				format: Self.format, version: version, savedAt: savedAt, value: value)
			guard let data = try? Self.encoder().encode(envelope) else {
				SyncLog.cache.error("encode failed name=\(key.name, privacy: .public)")
				return
			}
			guard data.count <= limits.maxEntryBytes else {
				SyncLog.cache.notice(
					"skip name=\(key.name, privacy: .public) reason=too-large bytes=\(data.count)")
				return
			}
			prepareDirectory()
			let previous = size(of: url)
			do {
				try fileManager.createDirectory(
					at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
				try data.write(to: url, options: Self.writeOptions)
				// Stamp with the cache's clock so LRU/age eviction agree with `savedAt`.
				try? fileManager.setAttributes([.modificationDate: savedAt], ofItemAtPath: url.path)
			} catch {
				SyncLog.cache.error("write failed name=\(key.name, privacy: .public)")
				return
			}
			lock.lock()
			lastUsed[usageKey(url)] = nil
			lastPersistedUse[usageKey(url)] = nil
			if let total = knownTotal { knownTotal = total - previous + data.count }
			if scanning { deltaDuringScan += data.count - previous }
			lock.unlock()
			evictionQueue.async { [self] in evictIfNeeded() }
		}
	}

	public func remove(_ key: Key) {
		let url = fileURL(for: key)
		ioQueue.sync {
			try? fileManager.removeItem(at: url)
			forget(path: usageKey(url))
		}
	}

	/// Blocks until every write queued so far is on disk and the eviction it triggered has run.
	/// Reads, removals and clears already order themselves after queued writes; this is for tests and
	/// for code that inspects the files.
	public func flush() {
		ioQueue.sync {}
		evictionQueue.sync {}
	}

	// MARK: Clearing

	/// Everything one actor cached (sign-out).
	public func clear(actorId: String) {
		ioQueue.sync {
			try? fileManager.removeItem(at: actorDirectory(actorId))
			resetKnownState()
		}
		SyncLog.cache.info("clear actor=\(SyncLog.shortHash(actorId), privacy: .public)")
	}

	/// Everything cached for one workspace, across actors (workspace deleted).
	public func clear(workspaceId: String) {
		ioQueue.sync {
			let prefix = Self.hash(workspaceId) + "."
			for file in allFiles() where file.lastPathComponent.hasPrefix(prefix) {
				try? fileManager.removeItem(at: file)
			}
			resetKnownState()
		}
		SyncLog.cache.info("clear workspace=\(SyncLog.shortHash(workspaceId), privacy: .public)")
	}

	/// Remove everything this cache stored.
	public func clearAll() {
		ioQueue.sync {
			try? fileManager.removeItem(at: directory)
			lock.lock()
			directoryPrepared = false
			lock.unlock()
			resetKnownState()
		}
		SyncLog.cache.info("clear all")
	}

	/// Sign-out: remove the default cache directory entirely. Static so it works even when no
	/// store or `DiskCache` instance exists yet in this launch.
	public static func clearAll(fileManager: FileManager = .default) {
		// Queued writes of the previous account must land (and then be deleted) before the directory
		// goes, or one could recreate a file after sign-out.
		shared.flush()
		try? fileManager.removeItem(at: defaultDirectory(fileManager: fileManager))
		shared.ioQueue.sync { shared.resetKnownState() }
		SyncLog.cache.info("clear all (static)")
	}

	// MARK: Inspection (tests, diagnostics)

	/// Total bytes on disk.
	public var totalBytes: Int {
		flush()
		return evictionQueue.sync { allFiles().reduce(0) { $0 + size(of: $1) } }
	}

	// MARK: Internals

	private static var writeOptions: Data.WritingOptions {
		#if os(iOS) || os(watchOS) || os(tvOS)
			return [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
		#else
			return [.atomic]
		#endif
	}

	private static func encoder() -> JSONEncoder {
		let e = JSONEncoder()
		e.dateEncodingStrategy = .secondsSince1970
		return e
	}

	private static func decoder() -> JSONDecoder {
		let d = JSONDecoder()
		d.dateDecodingStrategy = .secondsSince1970
		return d
	}

	static func hash(_ value: String) -> String {
		String(SyncLog.hex(SHA256.hash(data: Data(value.utf8))).prefix(32))
	}

	private func actorDirectory(_ actorId: String) -> URL {
		directory.appendingPathComponent(Self.hash(actorId), isDirectory: true)
	}

	/// `<actor-hash>/<workspace-hash|_>.<name-hash>.cache`
	private func fileURL(for key: Key) -> URL {
		let workspace = key.workspaceId.map(Self.hash) ?? "_"
		return actorDirectory(key.actorId).appendingPathComponent(
			"\(workspace).\(Self.hash(key.name)).\(Self.fileExtension)")
	}

	private func prepareDirectory() {
		lock.lock()
		let prepared = directoryPrepared
		lock.unlock()
		guard !prepared else { return }
		try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
		var values = URLResourceValues()
		values.isExcludedFromBackup = true
		var url = directory
		try? url.setResourceValues(values)
		lock.lock()
		directoryPrepared = true
		lock.unlock()
	}

	/// Blocks until no write to `path` is queued or running. Writes to other files do not matter.
	private func awaitPendingWrites(at path: String) {
		lock.lock()
		while (pendingWrites[path] ?? 0) > 0 { lock.wait() }
		lock.unlock()
	}

	private func writeFinished(at path: String) {
		lock.lock()
		defer { lock.unlock() }
		let left = (pendingWrites[path] ?? 1) - 1
		pendingWrites[path] = left > 0 ? left : nil
		lock.broadcast()
	}

	private func resetKnownState() {
		lock.lock()
		knownTotal = nil
		lastAgeSweep = nil
		lastUsed = [:]
		lastPersistedUse = [:]
		generation += 1
		lock.unlock()
	}

	/// How a file is named in the recency tables. Not `url.path`: the URL a write builds
	/// (`/var/folders/...`) and the one a directory listing returns (`/private/var/folders/...`)
	/// spell the same file differently, so a read's recency was recorded under a key the eviction
	/// scan never looked up, and the entry just read could be evicted as the least recently used.
	private func usageKey(_ url: URL) -> String {
		url.deletingLastPathComponent().lastPathComponent + "/" + url.lastPathComponent
	}

	private func forget(path: String) {
		lock.lock()
		lastUsed[path] = nil
		lastPersistedUse[path] = nil
		knownTotal = nil
		generation += 1
		lock.unlock()
	}

	/// Why a file that decoded as a header but not as an envelope (or failed a check) is unusable.
	private static func reason(for header: Header, version: Int, limits: Limits, now: Date) -> String {
		if header.format != format || header.version != version { return "version" }
		if now.timeIntervalSince(header.savedAt) > limits.maxAge { return "expired" }
		return "decode"
	}

	/// Remove an unusable file, so it is not retried. Only if it is still the bytes that were judged
	/// unusable: a fresh write may have replaced it in the meantime. Synchronous (it is the rare
	/// path: a version bump, corruption, expiry), so the next read of the key sees it gone.
	private func discard(_ url: URL, name: String, reason: String, observed: Data) {
		SyncLog.cache.notice("discard name=\(name, privacy: .public) reason=\(reason, privacy: .public)")
		ioQueue.sync { [self] in
			guard let current = try? Data(contentsOf: url), current == observed else { return }
			try? fileManager.removeItem(at: url)
			forget(path: usageKey(url))
		}
	}

	/// A read is a use. Recorded in memory immediately; written back to the file (so the order survives
	/// a relaunch) at most once a minute per file, on the queue.
	private func noteUse(of url: URL) {
		let stamp = now()
		lock.lock()
		lastUsed[usageKey(url)] = stamp
		let persisted = lastPersistedUse[usageKey(url)]
		let due = persisted.map { stamp.timeIntervalSince($0) >= 60 } ?? true
		if due { lastPersistedUse[usageKey(url)] = stamp }
		lock.unlock()
		guard due else { return }
		evictionQueue.async { [self] in
			try? fileManager.setAttributes([.modificationDate: stamp], ofItemAtPath: url.path)
		}
	}

	private func allFiles() -> [URL] {
		guard
			let actors = try? fileManager.contentsOfDirectory(
				at: directory, includingPropertiesForKeys: nil)
		else { return [] }
		var files: [URL] = []
		for actor in actors {
			let inside =
				(try? fileManager.contentsOfDirectory(at: actor, includingPropertiesForKeys: nil)) ?? []
			files += inside.filter { $0.pathExtension == Self.fileExtension }
		}
		return files
	}

	private func size(of url: URL) -> Int {
		((try? fileManager.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? 0
	}

	private func modified(_ url: URL) -> Date {
		((try? fileManager.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date)
			?? .distantPast
	}

	/// Keeps the cache inside its bounds. Runs on `evictionQueue`, so it is one scan at a time and
	/// never in front of a read or a write. A full scan is a syscall pair per file, so it only
	/// happens when it can matter: the first time (to learn the total), when the tracked total
	/// passes the bound, or hourly to expire old entries.
	private func evictIfNeeded() {
		let stamp = now()
		lock.lock()
		let sweepDue = lastAgeSweep.map { stamp.timeIntervalSince($0) >= 3600 } ?? true
		if let total = knownTotal, total <= limits.maxTotalBytes, !sweepDue {
			lock.unlock()
			return
		}
		scanning = true
		deltaDuringScan = 0
		let startedAt = generation
		lock.unlock()

		let listed = allFiles().map { url in (url: url, bytes: size(of: url), modified: modified(url)) }
		// Read the recency table only after the listing. Taken before it, a read that happened while
		// the scan was walking the directory was missing from the copy, and the file it had just
		// read could be evicted as the least recently used.
		lock.lock()
		let used = lastUsed
		lock.unlock()
		var files = listed.map { file in
			(
				url: file.url, bytes: file.bytes,
				used: max(file.modified, used[usageKey(file.url)] ?? .distantPast)
			)
		}
		let cutoff = stamp.addingTimeInterval(-limits.maxAge)
		for file in files where file.used < cutoff {
			try? fileManager.removeItem(at: file.url)
			SyncLog.cache.info("evict reason=age")
		}
		files.removeAll { $0.used < cutoff }
		var sum = files.reduce(0) { $0 + $1.bytes }
		if sum > limits.maxTotalBytes {
			for file in files.sorted(by: { $0.used < $1.used }) {
				guard sum > limits.maxTotalBytes else { break }
				try? fileManager.removeItem(at: file.url)
				sum -= file.bytes
				SyncLog.cache.info("evict reason=size")
			}
		}
		lock.lock()
		scanning = false
		// A clear or removal during the scan makes its count stale: leave the total unknown.
		if generation == startedAt {
			knownTotal = max(0, sum + deltaDuringScan)
			lastAgeSweep = stamp
		}
		lock.unlock()
	}
}
