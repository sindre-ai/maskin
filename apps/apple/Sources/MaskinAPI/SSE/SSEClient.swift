import Foundation

/// What the stream tells its consumer. `connected` after every (re)connect lets stores refetch
/// anything they may have missed beyond the server's 100-event replay window.
public enum SSEUpdate: Sendable, Equatable {
	case connected
	case event(SSEEvent)
	case disconnected(retryIn: Duration)
	/// Not retryable (bad credentials, workspace not found). The stream ends after this.
	case failed(SSEError)
}

public enum SSEError: Error, Sendable, Equatable {
	case badStatus(Int)
	case silent
}

/// Reconnect delay: `initial`, doubling up to `max`, reset only after a connection stayed up
/// for `SSEClient.healthyAfter` (a server that accepts and immediately closes must keep backing off).
public struct SSEBackoff: Sendable, Equatable {
	public var initial: Duration
	public var max: Duration

	public init(initial: Duration = .seconds(1), max: Duration = .seconds(30)) {
		self.initial = initial
		self.max = max
	}

	func next(after current: Duration?) -> Duration {
		guard let current else { return initial }
		return Swift.min(current * 2, max)
	}
}

/// Opens one HTTP connection and yields its body bytes. `lastEventID` goes out as the
/// `Last-Event-ID` header so the server replays what was missed.
public typealias SSEOpener = @Sendable (_ lastEventID: String?) async throws -> AsyncThrowingStream<UInt8, Error>

/// A self-healing event stream: reconnects with backoff, resumes from the last event id, and
/// recycles a connection that has gone silent. The backend sends a comment frame every 15 s, so
/// silence beyond `silenceTimeout` means a half-open connection that will never error on its own.
public struct SSEClient: Sendable {
	let open: SSEOpener
	let backoff: SSEBackoff
	let silenceTimeout: Duration
	/// How long a connection must stay up before it counts as healthy and earns a fresh, short
	/// backoff. Delivering a byte is not enough: a flapping server that sends a header or a
	/// heartbeat and then drops would otherwise be retried at the shortest delay forever.
	let healthyAfter: Duration

	public init(
		open: @escaping SSEOpener,
		backoff: SSEBackoff = SSEBackoff(),
		silenceTimeout: Duration = .seconds(45),
		healthyAfter: Duration = .seconds(10)
	) {
		self.open = open
		self.backoff = backoff
		self.silenceTimeout = silenceTimeout
		self.healthyAfter = healthyAfter
	}

	/// Ends when the consuming task is cancelled or on a non-retryable failure.
	public func updates(resumingFrom lastEventID: String? = nil) -> AsyncStream<SSEUpdate> {
		AsyncStream { continuation in
			let task = Task {
				var lastID = lastEventID
				var delay: Duration?
				while !Task.isCancelled {
					let connection = Connection(lastEventID: lastID)
					let startedAt = ContinuousClock.now
					do {
						let bytes = try await open(lastID)
						continuation.yield(.connected)
						try await read(bytes, from: connection, into: continuation)
					} catch is CancellationError {
						break
					} catch let error as SSEError {
						if case .badStatus(let code) = error, !Self.isRetryable(status: code) {
							continuation.yield(.failed(error))
							break
						}
					} catch {
						// Network error mid-stream: reconnect below.
					}
					if Task.isCancelled { break }
					lastID = await connection.lastEventID ?? lastID
					// Only a connection that stayed up long enough earns a fresh, short backoff.
					if await connection.byteCount > 0, ContinuousClock.now - startedAt >= healthyAfter {
						delay = nil
					}
					let wait = backoff.next(after: delay)
					delay = wait
					continuation.yield(.disconnected(retryIn: wait))
					try? await Task.sleep(for: wait)
				}
				continuation.finish()
			}
			continuation.onTermination = { _ in task.cancel() }
		}
	}

	static func isRetryable(status: Int) -> Bool {
		status >= 500 || status == 408 || status == 429
	}

	/// Reads until the server closes (returns) or the connection fails / goes silent (throws).
	private func read(
		_ bytes: AsyncThrowingStream<UInt8, Error>,
		from connection: Connection,
		into continuation: AsyncStream<SSEUpdate>.Continuation
	) async throws {
		try await withThrowingTaskGroup(of: Void.self) { group in
			group.addTask {
				for try await byte in bytes {
					if let event = await connection.feed(byte) { continuation.yield(.event(event)) }
				}
			}
			group.addTask { [silenceTimeout] in
				var seen = await connection.byteCount
				while true {
					try await Task.sleep(for: silenceTimeout)
					let now = await connection.byteCount
					if now == seen { throw SSEError.silent }
					seen = now
				}
			}
			// First to finish wins: the reader returning means a clean server close, either
			// task throwing means failure. Cancel the other either way.
			defer { group.cancelAll() }
			try await group.next()
		}
	}
}

/// Per-connection parser state. Counting bytes (heartbeat comments included) is what lets the
/// watchdog tell a quiet-but-alive stream from a dead one.
private actor Connection {
	private var parser: SSEParser
	private(set) var byteCount = 0

	init(lastEventID: String?) { parser = SSEParser(lastEventID: lastEventID) }

	var lastEventID: String? { parser.lastEventID }

	func feed(_ byte: UInt8) -> SSEEvent? {
		byteCount += 1
		return parser.feed(byte)
	}
}
