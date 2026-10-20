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
	private let lock = NSLock()
	private var directoryPrepared = false

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
		lock.lock()
		defer { lock.unlock() }
		let url = fileURL(for: key)
		guard let data = try? Data(contentsOf: url) else {
			SyncLog.cache.debug("miss name=\(key.name, privacy: .public) reason=absent")
			return nil
		}
		let decoder = Self.decoder()
		guard let header = try? decoder.decode(Header.self, from: data) else {
			discard(url, name: key.name, reason: "corrupt")
			return nil
		}
		guard header.format == Self.format, header.version == version else {
			discard(url, name: key.name, reason: "version")
			return nil
		}
		if now().timeIntervalSince(header.savedAt) > limits.maxAge {
			discard(url, name: key.name, reason: "expired")
			return nil
		}
		guard let envelope = try? decoder.decode(Envelope<Value>.self, from: data) else {
			discard(url, name: key.name, reason: "decode")
			return nil
		}
		// Touch for LRU. Failure is harmless.
		try? fileManager.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)
		SyncLog.cache.debug("hit name=\(key.name, privacy: .public) bytes=\(data.count)")
		return Entry(value: envelope.value, savedAt: envelope.savedAt)
	}

	/// Store `value`. Atomic; replaces any previous entry. Silently drops values over the
	/// per-entry bound or when the disk refuses (a cache must never break a screen).
	public func write<Value: Codable & Sendable>(_ value: Value, key: Key, version: Int) {
		lock.lock()
		defer { lock.unlock() }
		let envelope = Envelope(
			format: Self.format, version: version, savedAt: now(), value: value)
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
		let url = fileURL(for: key)
		do {
			try fileManager.createDirectory(
				at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
			try data.write(to: url, options: Self.writeOptions)
			// Stamp with the cache's clock so LRU/age eviction agree with `savedAt`.
			try? fileManager.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)
		} catch {
			SyncLog.cache.error("write failed name=\(key.name, privacy: .public)")
			return
		}
		evictIfNeeded()
	}

	public func remove(_ key: Key) {
		lock.lock()
		defer { lock.unlock() }
		try? fileManager.removeItem(at: fileURL(for: key))
	}

	// MARK: Clearing

	/// Everything one actor cached (sign-out).
	public func clear(actorId: String) {
		lock.lock()
		defer { lock.unlock() }
		try? fileManager.removeItem(at: actorDirectory(actorId))
		SyncLog.cache.info("clear actor=\(SyncLog.shortHash(actorId), privacy: .public)")
	}

	/// Everything cached for one workspace, across actors (workspace deleted).
	public func clear(workspaceId: String) {
		lock.lock()
		defer { lock.unlock() }
		let prefix = Self.hash(workspaceId) + "."
		for file in allFiles() where file.lastPathComponent.hasPrefix(prefix) {
			try? fileManager.removeItem(at: file)
		}
		SyncLog.cache.info("clear workspace=\(SyncLog.shortHash(workspaceId), privacy: .public)")
	}

	/// Remove everything this cache stored.
	public func clearAll() {
		lock.lock()
		defer { lock.unlock() }
		try? fileManager.removeItem(at: directory)
		directoryPrepared = false
		SyncLog.cache.info("clear all")
	}

	/// Sign-out: remove the default cache directory entirely. Static so it works even when no
	/// store or `DiskCache` instance exists yet in this launch.
	public static func clearAll(fileManager: FileManager = .default) {
		try? fileManager.removeItem(at: defaultDirectory(fileManager: fileManager))
		SyncLog.cache.info("clear all (static)")
	}

	// MARK: Inspection (tests, diagnostics)

	/// Total bytes on disk.
	public var totalBytes: Int {
		lock.lock()
		defer { lock.unlock() }
		return allFiles().reduce(0) { $0 + size(of: $1) }
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
		guard !directoryPrepared else { return }
		try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
		var values = URLResourceValues()
		values.isExcludedFromBackup = true
		var url = directory
		try? url.setResourceValues(values)
		directoryPrepared = true
	}

	private func discard(_ url: URL, name: String, reason: String) {
		try? fileManager.removeItem(at: url)
		SyncLog.cache.notice("discard name=\(name, privacy: .public) reason=\(reason, privacy: .public)")
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

	/// Drop expired entries, then least-recently-used ones until under the total bound.
	private func evictIfNeeded() {
		var files = allFiles().map { (url: $0, bytes: size(of: $0), used: modified($0)) }
		let cutoff = now().addingTimeInterval(-limits.maxAge)
		for file in files where file.used < cutoff {
			try? fileManager.removeItem(at: file.url)
			SyncLog.cache.info("evict reason=age")
		}
		files.removeAll { $0.used < cutoff }
		var total = files.reduce(0) { $0 + $1.bytes }
		guard total > limits.maxTotalBytes else { return }
		for file in files.sorted(by: { $0.used < $1.used }) {
			guard total > limits.maxTotalBytes else { break }
			try? fileManager.removeItem(at: file.url)
			total -= file.bytes
			SyncLog.cache.info("evict reason=size")
		}
	}
}
