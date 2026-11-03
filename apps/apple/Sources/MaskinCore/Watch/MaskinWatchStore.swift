import Foundation
import Observation

/// Where the watch gets a fresh snapshot when it can reach the network on its own (the same
/// `ForYouStore`/`LoopsStore` data the iPhone uses). Protocol-injected so the store tests without
/// a server.
public protocol WatchSnapshotSource: Sendable {
	func fetch() async throws -> WatchSnapshot
}

/// The last snapshot the watch drew, kept so a cold launch offline still has something to show.
public protocol WatchSnapshotStorage: Sendable {
	func load() -> WatchSnapshot?
	func save(_ snapshot: WatchSnapshot)
}

public final class InMemoryWatchSnapshotStorage: WatchSnapshotStorage, @unchecked Sendable {
	private let lock = NSLock()
	private var snapshot: WatchSnapshot?
	public init(_ snapshot: WatchSnapshot? = nil) { self.snapshot = snapshot }
	public func load() -> WatchSnapshot? { lock.withLock { snapshot } }
	public func save(_ snapshot: WatchSnapshot) { lock.withLock { self.snapshot = snapshot } }
}

/// One small JSON file in Application Support. A missing or unreadable file is a cache miss.
public struct FileWatchSnapshotStorage: WatchSnapshotStorage {
	public let fileURL: URL
	public init(fileURL: URL = Self.defaultFileURL()) { self.fileURL = fileURL }

	public static func defaultFileURL(fileManager: FileManager = .default) -> URL {
		let base =
			fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
			?? fileManager.temporaryDirectory
		return base.appendingPathComponent("watch-snapshot.json")
	}

	public func load() -> WatchSnapshot? {
		guard let data = try? Data(contentsOf: fileURL) else { return nil }
		return WatchSnapshot(context: [WatchSnapshot.contextKey: data])
	}

	public func save(_ snapshot: WatchSnapshot) {
		guard let data = snapshot.context()[WatchSnapshot.contextKey] as? Data else { return }
		try? FileManager.default.createDirectory(
			at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
		try? data.write(to: fileURL, options: .atomic)
	}
}

/// What the watch shows: the newest snapshot from either the paired iPhone (WatchConnectivity) or
/// the watch's own network read, falling back to the cached one offline. `@MainActor @Observable`
/// like every store; views only read it.
@MainActor
@Observable
public final class MaskinWatchStore {
	public enum Origin: Sendable, Equatable { case none, cache, phone, network }

	public private(set) var snapshot: WatchSnapshot?
	public private(set) var origin: Origin = .none
	/// The last network read failed; what is on screen is the newest we have, not live data.
	public private(set) var isOffline = false

	@ObservationIgnored private let source: (any WatchSnapshotSource)?
	@ObservationIgnored private let storage: any WatchSnapshotStorage
	@ObservationIgnored private let onChange: @MainActor (WatchSnapshot) -> Void

	public init(
		source: (any WatchSnapshotSource)? = nil, storage: any WatchSnapshotStorage,
		onChange: @escaping @MainActor (WatchSnapshot) -> Void = { _ in }
	) {
		self.source = source
		self.storage = storage
		self.onChange = onChange
		if let cached = storage.load() {
			snapshot = cached
			origin = .cache
		}
	}

	public var needsCount: Int { snapshot?.needsCount ?? 0 }
	public var cards: [WatchSnapshot.Card] { snapshot?.cards ?? [] }
	public var flows: [WatchSnapshot.Flow] { snapshot?.flows ?? [] }

	/// A snapshot pushed by the phone. Only ever replaces an older one, so a stale context
	/// delivered late can't undo what the watch fetched itself.
	public func receive(fromPhone incoming: WatchSnapshot) {
		adopt(incoming, origin: .phone)
	}

	/// A snapshot the watch built itself from its own live stores.
	public func publish(_ incoming: WatchSnapshot) {
		isOffline = false
		adopt(incoming, origin: .network)
	}

	public func refresh() async {
		guard let source else { return }
		do {
			let fresh = try await source.fetch()
			isOffline = false
			adopt(fresh, origin: .network)
		} catch {
			isOffline = true
		}
	}

	private func adopt(_ incoming: WatchSnapshot, origin: Origin) {
		if let current = snapshot, incoming.updatedAt < current.updatedAt { return }
		snapshot = incoming
		self.origin = origin
		storage.save(incoming)
		onChange(incoming)
	}

	/// Sign-out: nothing of the last account stays on the wrist.
	public func clear() {
		snapshot = nil
		origin = .none
		isOffline = false
		storage.save(WatchSnapshot(updatedAt: .distantPast))
	}
}
