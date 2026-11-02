import Foundation
import Network

/// Connectivity as the outbox sees it. A protocol so tests drive it by hand.
public protocol NetworkMonitoring: Sendable {
	/// Current best guess; `true` until the system says otherwise.
	var isOnline: Bool { get }
	/// Emits whenever reachability flips (not the initial value).
	func updates() -> AsyncStream<Bool>
}

/// `NWPathMonitor` behind `NetworkMonitoring`.
public final class NWPathNetworkMonitor: NetworkMonitoring, @unchecked Sendable {
	private let monitor = NWPathMonitor()
	private let queue = DispatchQueue(label: "io.maskin.network-monitor")
	private let lock = NSLock()
	private var online = true
	private var continuations: [UUID: AsyncStream<Bool>.Continuation] = [:]

	public init() {
		monitor.pathUpdateHandler = { [weak self] path in
			self?.handle(satisfied: path.status == .satisfied)
		}
		monitor.start(queue: queue)
	}

	deinit { monitor.cancel() }

	public var isOnline: Bool {
		lock.lock()
		defer { lock.unlock() }
		return online
	}

	public func updates() -> AsyncStream<Bool> {
		let id = UUID()
		let (stream, continuation) = AsyncStream<Bool>.makeStream()
		lock.lock()
		continuations[id] = continuation
		lock.unlock()
		continuation.onTermination = { [weak self] _ in
			self?.lock.lock()
			self?.continuations[id] = nil
			self?.lock.unlock()
		}
		return stream
	}

	private func handle(satisfied: Bool) {
		lock.lock()
		let changed = satisfied != online
		online = satisfied
		let targets = changed ? Array(continuations.values) : []
		lock.unlock()
		for continuation in targets { continuation.yield(satisfied) }
	}
}

/// Hand-driven monitor for tests and previews.
public final class ManualNetworkMonitor: NetworkMonitoring, @unchecked Sendable {
	private let lock = NSLock()
	private var online: Bool
	private var continuations: [UUID: AsyncStream<Bool>.Continuation] = [:]

	public init(isOnline: Bool = true) { online = isOnline }

	public var isOnline: Bool {
		lock.lock()
		defer { lock.unlock() }
		return online
	}

	public func set(online value: Bool) {
		lock.lock()
		let changed = value != online
		online = value
		let targets = changed ? Array(continuations.values) : []
		lock.unlock()
		for continuation in targets { continuation.yield(value) }
	}

	public func updates() -> AsyncStream<Bool> {
		let id = UUID()
		let (stream, continuation) = AsyncStream<Bool>.makeStream()
		lock.lock()
		continuations[id] = continuation
		lock.unlock()
		continuation.onTermination = { [weak self] _ in
			self?.lock.lock()
			self?.continuations[id] = nil
			self?.lock.unlock()
		}
		return stream
	}
}
