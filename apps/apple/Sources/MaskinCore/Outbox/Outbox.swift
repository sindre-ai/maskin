import Foundation
import MaskinAPI
import Observation

// MARK: - Model

/// One queued write. Persisted as JSON, so every field is plain data.
public struct OutboxEntry: Codable, Sendable, Equatable, Identifiable {
	public var id: UUID
	/// Which handler replays it (e.g. `decision.comment`). Opaque to the outbox.
	public var kind: String
	/// Ordering lane. Entries with the same lane replay strictly in enqueue order, and a lane
	/// whose head is waiting (retry back-off, undo hold) blocks everything behind it. Use the id
	/// of the thing being written to, e.g. `object:<uuid>`.
	public var lane: String
	/// Entries that stand or fall together (a decision's comment + its mark-read). When one is
	/// permanently rejected, the rest of its group is dropped too rather than replayed alone.
	public var groupId: String?
	/// The workspace whose credentials the replay must carry. Entries for another workspace wait.
	public var workspaceId: String?
	/// Generated once at enqueue and reused by every replay (`IdempotencyKey.current`), so a retry
	/// after a lost response is deduplicated by the backend.
	public var idempotencyKey: String
	public var payload: Data
	/// Human-readable, shown if the write is permanently rejected. Never a raw id.
	public var summary: String
	public var createdAt: Date
	/// Not replayed before this (the Undo window).
	public var notBefore: Date
	public var attempts: Int
	public var nextAttemptAt: Date
	/// When the server first answered this write with an error it will recover from (5xx, 429,
	/// 408). From then on the write is bounded by age (`maxServerErrorAge`), not by `attempts`.
	/// Optional so a file written by an older build still decodes.
	public var serverErrorSince: Date?
}

/// A write the outbox gave up on, surfaced to the user.
public struct OutboxFailure: Codable, Sendable, Equatable, Identifiable {
	public var id: UUID
	public var summary: String
	public var message: String
	public var at: Date
}

public enum OutboxEvent: Sendable, Equatable {
	case sent(OutboxEntry)
	/// Permanently rejected (4xx or out of retries). Dependents in the group are reported too.
	case rejected(OutboxEntry, message: String)
}

/// Throw from an executor for a response the server will never accept (400, 403, 404, 409, 422…).
/// The outbox drops the entry. Any other error is treated as transient and retried with back-off.
public struct OutboxRejection: Error, Sendable, Equatable {
	public var status: Int?
	public var message: String
	public init(status: Int? = nil, message: String) {
		self.status = status
		self.message = message
	}

	/// Whether an HTTP status is a permanent rejection. 408 and 429 are asked to be retried, and
	/// 401 is about the credentials, not the write (see `isAuthFailure`). A 403 IS a rejection of
	/// the write: the user is authenticated but not permitted, so nothing they do about their
	/// sign-in changes it, and holding the queue for it would strand the entry (and everything
	/// behind it) forever. It fails visibly instead, like any other refused write.
	public static func isPermanent(status: Int) -> Bool {
		(400..<500).contains(status) && status != 408 && status != 429 && !isAuthFailure(status: status)
	}

	/// 401: the key is the problem, not the queued write. The outbox holds the whole queue instead
	/// of dropping the entry, so it survives a re-login. (The server answers 401 only for bad
	/// credentials; a non-member gets 404 and a permission refusal 403, which are rejections.)
	public static func isAuthFailure(status: Int) -> Bool { status == 401 }
}

/// Throw from an executor for a 401. Never counts as an attempt and never drops the entry.
public struct OutboxAuthRequired: Error, Sendable, Equatable {
	public var status: Int
	public init(status: Int) { self.status = status }
}

/// Performs one queued write. The outbox has already set `IdempotencyKey.current`.
public protocol OutboxExecuting: Sendable {
	func execute(kind: String, payload: Data) async throws
}

// MARK: - Outbox

/// Durable offline write queue. Generic: it knows nothing about decisions or chats.
///
/// - `enqueue` persists immediately (JSON in Application Support) and returns; `drain()` replays
///   what is due, in lane order, each under its stable `Idempotency-Key`.
/// - Transient failures back off exponentially and keep their key; permanent rejections (4xx) are
///   dropped and reported through `failures` / `events()`. Being offline is never counted. Server
///   errors (5xx, 429, 408) keep the write for `maxServerErrorAge`, so a slow deploy cannot eat a
///   queued answer; any other failure gives up after `maxAttempts`.
/// - Drains are triggered by: enqueue, the network coming back, `.reconnected` from the event hub,
///   `appDidBecomeActive()`, and a wake timer for the next undo hold / back-off.
@MainActor
@Observable
public final class Outbox {
	public private(set) var entries: [OutboxEntry] = []
	public private(set) var failures: [OutboxFailure] = []
	public private(set) var isOnline: Bool
	/// The last replay was refused with 401/403, so the queue is held (nothing dropped) until a
	/// later drain gets through. The UI can say "sign in again to send".
	public private(set) var isAuthBlocked = false

	var fileURLForTesting: URL { fileURL }

	/// Writes waiting to go out (including those held for Undo).
	public var pendingCount: Int { entries.count }

	@ObservationIgnored private let fileURL: URL
	@ObservationIgnored private let fileManager: FileManager
	@ObservationIgnored private let executor: any OutboxExecuting
	@ObservationIgnored private let network: any NetworkMonitoring
	@ObservationIgnored private let currentWorkspace: @MainActor () -> String?
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private let backoff: @Sendable (Int) -> TimeInterval
	@ObservationIgnored private let maxAttempts: Int
	@ObservationIgnored private let maxServerErrorAge: TimeInterval
	@ObservationIgnored private var inFlight: Set<UUID> = []
	@ObservationIgnored private var draining = false
	@ObservationIgnored private var drainAgain = false
	/// When the last pass last looked at what was due (see `scheduleWake`).
	@ObservationIgnored private var lastEvaluatedAt = Date.distantPast
	/// Lanes whose head failed during the current pass, so were not tried again in it.
	@ObservationIgnored private var lanesFailedThisPass: Set<String> = []
	@ObservationIgnored private var subscribers: [UUID: AsyncStream<OutboxEvent>.Continuation] = [:]
	@ObservationIgnored nonisolated(unsafe) private var wake: Task<Void, Never>?
	@ObservationIgnored nonisolated(unsafe) private var tasks: [Task<Void, Never>] = []
	@ObservationIgnored private var isDiscarded = false
	/// Every entry id this outbox has held. An id in the file that is not here was written by another
	/// outbox over the same file (a notification answer parked while the app was alive), so it is
	/// adopted rather than overwritten or mistaken for an entry this outbox already sent.
	@ObservationIgnored private var knownIDs: Set<UUID> = []
	/// While `isAuthBlocked`, the only entry allowed out: the one that was refused, retried after
	/// its back-off as a probe. Everything else waits for it to get through.
	@ObservationIgnored private var authProbe: UUID?

	public static let defaultBackoff: @Sendable (Int) -> TimeInterval = { attempts in
		min(2 * pow(2, Double(max(attempts - 1, 0))), 300)
	}

	public init(
		fileURL: URL,
		executor: any OutboxExecuting,
		network: any NetworkMonitoring = NWPathNetworkMonitor(),
		workspaceId: @escaping @MainActor () -> String?,
		fileManager: FileManager = .default,
		now: @escaping @Sendable () -> Date = { Date() },
		backoff: @escaping @Sendable (Int) -> TimeInterval = Outbox.defaultBackoff,
		maxAttempts: Int = 8,
		maxServerErrorAge: TimeInterval = 24 * 60 * 60
	) {
		self.fileURL = fileURL
		self.fileManager = fileManager
		self.executor = executor
		self.network = network
		self.currentWorkspace = workspaceId
		self.now = now
		self.backoff = backoff
		self.maxAttempts = maxAttempts
		self.maxServerErrorAge = maxServerErrorAge
		self.isOnline = network.isOnline
		load()
	}

	/// `~/Library/Application Support/Maskin/outbox.json`.
	public static func defaultFileURL(fileManager: FileManager = .default) -> URL {
		let base =
			(try? fileManager.url(
				for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
			?? fileManager.temporaryDirectory
		return base.appendingPathComponent("Maskin", isDirectory: true)
			.appendingPathComponent("outbox.json")
	}

	/// `deinit` may run on any thread, so it must not assume main-actor isolation (that traps). The
	/// task handles are `nonisolated(unsafe)` precisely so cancelling them here is legal; `Task.cancel()`
	/// is thread-safe.
	deinit {
		for task in tasks { task.cancel() }
		wake?.cancel()
	}

	// MARK: Triggers

	/// Begin reacting to connectivity and stream reconnects. Call once after construction.
	public func start(events hub: EventHub? = nil) {
		guard tasks.isEmpty else { return }
		let updates = network.updates()
		tasks.append(
			Task { [weak self] in
				for await online in updates {
					guard let self else { return }
					self.isOnline = online
					if online {
						self.resumeAfterAuth()
						await self.drain()
					}
				}
			})
		if let hub {
			let signals = hub.subscribe()
			tasks.append(
				Task { [weak self] in
					for await signal in signals {
						guard let self else { return }
						if signal == .reconnected {
							self.resumeAfterAuth()
							await self.drain()
						}
					}
				})
		}
		Task { await drain() }
	}

	/// Call when the app returns to the foreground.
	public func appDidBecomeActive() {
		isOnline = network.isOnline
		resumeAfterAuth()
		Task { await drain() }
	}

	/// Lift an auth hold (the credentials are valid again, or worth trying again) and replay.
	/// The queue never drops entries over a 401/403, so nothing is lost while it was held.
	public func resumeAfterAuth() {
		guard isAuthBlocked else { return }
		isAuthBlocked = false
		authProbe = nil
		for index in entries.indices { entries[index].nextAttemptAt = min(entries[index].nextAttemptAt, now()) }
		save()
		Task { await drain() }
	}

	/// Cancel Undo holds so everything queued goes out now (call as the app backgrounds).
	public func releaseHolds() {
		let t = now()
		var changed = false
		for index in entries.indices where entries[index].notBefore > t {
			entries[index].notBefore = t
			changed = true
		}
		if changed {
			save()
			Task { await drain() }
		}
	}

	// MARK: Enqueue / cancel

	@discardableResult
	public func enqueue<Payload: Encodable>(
		kind: String, lane: String, groupId: String? = nil, summary: String, payload: Payload,
		holdFor hold: TimeInterval = 0
	) throws -> OutboxEntry {
		let t = now()
		let entry = OutboxEntry(
			id: UUID(), kind: kind, lane: lane, groupId: groupId, workspaceId: currentWorkspace(),
			idempotencyKey: IdempotencyKey.make(), payload: try JSONEncoder().encode(payload),
			summary: summary, createdAt: t, notBefore: t.addingTimeInterval(hold), attempts: 0,
			nextAttemptAt: t)
		entries.append(entry)
		knownIDs.insert(entry.id)
		save()
		Task { await drain() }
		return entry
	}

	/// Removes every not-yet-sent entry of `groupId`. Returns `false` when some already went out
	/// (or are on the wire), so the caller knows the write can no longer be taken back.
	@discardableResult
	public func cancel(groupId: String) -> Bool {
		let group = entries.filter { $0.groupId == groupId }
		guard !group.isEmpty else { return false }
		if group.contains(where: { inFlight.contains($0.id) }) { return false }
		entries.removeAll { $0.groupId == groupId }
		save()
		return true
	}

	/// Entries still queued for the group.
	public func entries(inGroup groupId: String) -> [OutboxEntry] {
		entries.filter { $0.groupId == groupId }
	}

	/// Stop reacting to triggers but keep the queue (memory and file) as it is, for a session that
	/// ended without the user choosing to discard their writes. `start` begins again.
	public func stop() {
		for task in tasks { task.cancel() }
		tasks = []
		wake?.cancel()
		wake = nil
	}

	/// Sign-out: forget every queued write and failure, delete the persisted file, and stop for
	/// good. The queue belongs to the signed-in user, so none of it may ever be replayed under
	/// another account. This outbox is unusable afterwards.
	public func discardAll() {
		isDiscarded = true
		for task in tasks { task.cancel() }
		tasks = []
		wake?.cancel()
		entries = []
		failures = []
		isAuthBlocked = false
		authProbe = nil
		try? fileManager.removeItem(at: fileURL)
	}

	public func dismissFailure(_ id: UUID) {
		failures.removeAll { $0.id == id }
		save()
	}

	public func events() -> AsyncStream<OutboxEvent> {
		let id = UUID()
		let (stream, continuation) = AsyncStream<OutboxEvent>.makeStream()
		subscribers[id] = continuation
		continuation.onTermination = { [weak self] _ in
			Task { @MainActor in self?.subscribers[id] = nil }
		}
		return stream
	}

	// MARK: Replay

	/// Replays everything currently due. Safe to call from anywhere, any number of times; a call
	/// made during a drain makes it run one more pass.
	public func drain() async {
		if draining {
			drainAgain = true
			return
		}
		draining = true
		defer {
			draining = false
			scheduleWake()
		}
		repeat {
			drainAgain = false
			await drainPass()
		} while drainAgain
	}

	private func drainPass() async {
		adoptEntriesFromFile()
		var blocked: Set<String> = []
		lanesFailedThisPass = []
		while true {
			isOnline = network.isOnline
			// Stamped before the online check: an offline pass never reaches `nextDue`, and
			// without this the stale stamp would make `scheduleWake` poll every 10 ms.
			lastEvaluatedAt = now()
			guard isOnline, let entry = nextDue(excludingLanes: blocked) else { return }
			inFlight.insert(entry.id)
			var outcome: Result<Void, any Error> = .success(())
			do {
				try await IdempotencyKey.$current.withValue(entry.idempotencyKey) {
					try await executor.execute(kind: entry.kind, payload: entry.payload)
				}
			} catch {
				outcome = .failure(error)
			}
			inFlight.remove(entry.id)
			switch outcome {
			case .success:
				isAuthBlocked = false
				authProbe = nil
				remove(entry.id)
				broadcast(.sent(entry))
			case .failure(let error):
				if error is CancellationError { return }
				if let status = Self.authFailureStatus(error) {
					// The credentials are the problem, so every lane would fail the same way:
					// hold the whole queue, spend no attempt, and let the next trigger retry.
					isAuthBlocked = true
					authProbe = entry.id
					holdForAuth(entry, status: status)
					return
				}
				if let rejection = error as? OutboxRejection {
					reject(entry, message: rejection.message)
				} else {
					blocked.insert(entry.lane)
					lanesFailedThisPass.insert(entry.lane)
					retryLater(entry, error: error)
				}
			}
		}
	}

	private static func authFailureStatus(_ error: any Error) -> Int? {
		if let auth = error as? OutboxAuthRequired { return auth.status }
		if let status = (error as? OutboxRejection)?.status, OutboxRejection.isAuthFailure(status: status) {
			return status
		}
		return nil
	}

	private func holdForAuth(_ entry: OutboxEntry, status: Int) {
		guard let index = entries.firstIndex(where: { $0.id == entry.id }) else { return }
		entries[index].nextAttemptAt = now().addingTimeInterval(backoff(1))
		save()
	}

	/// First entry that is due, whose lane head it is, and that belongs to the current workspace.
	private func nextDue(excludingLanes blocked: Set<String>) -> OutboxEntry? {
		let t = now()
		let workspace = currentWorkspace()
		var seenLanes: Set<String> = []
		if isAuthBlocked, !entries.contains(where: { $0.id == authProbe }) {
			// The refused write is gone (cancelled), so nothing is left to probe with.
			isAuthBlocked = false
			authProbe = nil
		}
		for entry in entries {
			let isHead = seenLanes.insert(entry.lane).inserted
			guard isHead, !blocked.contains(entry.lane) else { continue }
			if isAuthBlocked, entry.id != authProbe { continue }
			guard entry.workspaceId == nil || entry.workspaceId == workspace else { continue }
			guard entry.notBefore <= t, entry.nextAttemptAt <= t else { continue }
			return entry
		}
		return nil
	}

	private func retryLater(_ entry: OutboxEntry, error: any Error) {
		guard let index = entries.firstIndex(where: { $0.id == entry.id }) else { return }
		// Being offline is not the write's fault: don't spend attempts on it.
		let connectivity = (error as? URLError).map(Self.isConnectivity) ?? false
		if !connectivity { entries[index].attempts += 1 }
		// A server that is down or mid-deploy is not the write's fault either: once it has answered
		// like that, the write is bounded by age, and `attempts` only drives the back-off.
		if Self.isServerSide(error), entries[index].serverErrorSince == nil {
			entries[index].serverErrorSince = now()
		}
		if let since = entries[index].serverErrorSince {
			if now().timeIntervalSince(since) >= maxServerErrorAge {
				reject(entries[index], message: "Gave up: the server kept failing for too long.")
				return
			}
		} else if entries[index].attempts >= maxAttempts {
			reject(entries[index], message: "Gave up after \(maxAttempts) attempts.")
			return
		}
		entries[index].nextAttemptAt = now().addingTimeInterval(backoff(max(entries[index].attempts, 1)))
		save()
	}

	private func reject(_ entry: OutboxEntry, message: String) {
		var dropped = [entry]
		if let group = entry.groupId {
			dropped += entries.filter {
				$0.groupId == group && $0.id != entry.id && !inFlight.contains($0.id)
			}
		}
		let ids = Set(dropped.map(\.id))
		entries.removeAll { ids.contains($0.id) }
		failures.append(OutboxFailure(id: entry.id, summary: entry.summary, message: message, at: now()))
		save()
		for gone in dropped { broadcast(.rejected(gone, message: message)) }
	}

	private func remove(_ id: UUID) {
		entries.removeAll { $0.id == id }
		save()
	}

	/// 5xx, 429 and 408 from the server, or the `badServerResponse` the executors map them to.
	private static func isServerSide(_ error: any Error) -> Bool {
		if let http = error as? ChatsHTTPError {
			return http.status >= 500 || http.status == 408 || http.status == 429
		}
		return (error as? URLError)?.code == .badServerResponse
	}

	private static func isConnectivity(_ error: URLError) -> Bool {
		switch error.code {
		case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
			.cannotFindHost, .dnsLookupFailed, .timedOut, .dataNotAllowed, .internationalRoamingOff:
			return true
		default: return false
		}
	}

	private func broadcast(_ event: OutboxEvent) {
		for continuation in subscribers.values { continuation.yield(event) }
	}

	/// Sleep until the next hold / back-off expires, then drain.
	private func scheduleWake() {
		wake?.cancel()
		wake = nil
		let t = now()
		// "Not due yet" is judged at the moment the last pass looked, not now: if this task was
		// descheduled for longer than a back-off (a busy device), an entry that fell due in the
		// meantime would otherwise be neither sent by the pass nor waited for here, and sit in the
		// queue until some unrelated trigger drained it.
		// A lane whose head just failed was set aside for the rest of the pass, not looked at, so
		// its retry time counts however early it is.
		let next = entries
			.map { (due: max($0.notBefore, $0.nextAttemptAt), lane: $0.lane) }
			.filter { $0.due > lastEvaluatedAt || lanesFailedThisPass.contains($0.lane) }
			.map(\.due).min()
		guard let next else { return }
		let delay = max(next.timeIntervalSince(t), 0.01)
		wake = Task { [weak self] in
			try? await Task.sleep(for: .seconds(delay))
			guard !Task.isCancelled else { return }
			await self?.drain()
		}
	}

	// MARK: Persistence

	private struct Snapshot: Codable {
		var version = 1
		var entries: [OutboxEntry]
		var failures: [OutboxFailure]
	}

	/// The persisted snapshot, nil when there is no file. A file that exists but cannot be decoded
	/// (corrupt, or written by another build) is moved aside and logged, because the next `save()`
	/// would otherwise overwrite it and every write queued in it would vanish without a trace.
	private func readSnapshot() -> Snapshot? {
		guard let data = try? Data(contentsOf: fileURL) else { return nil }
		if let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) { return snapshot }
		let aside = fileURL.appendingPathExtension("unreadable-\(Int(now().timeIntervalSince1970))")
		do {
			try fileManager.moveItem(at: fileURL, to: aside)
			SyncLog.sync.error("outbox file unreadable, kept aside bytes=\(data.count)")
		} catch {
			SyncLog.sync.error(
				"outbox file unreadable and could not be moved aside: \(error.localizedDescription, privacy: .public)"
			)
		}
		return nil
	}

	private func load() {
		guard let snapshot = readSnapshot() else { return }
		entries = snapshot.entries
		failures = snapshot.failures
		knownIDs = Set(snapshot.entries.map(\.id))
	}

	/// Picks up entries another outbox wrote to the file since this one last looked. The notification
	/// action builds its own outbox over this file when an answer cannot be sent, and this one reads
	/// the file only at start-up, so without this the next `save()` would overwrite that answer.
	private func adoptEntriesFromFile() {
		guard !isDiscarded, let snapshot = readSnapshot() else { return }
		let foreign = snapshot.entries.filter { !knownIDs.contains($0.id) }
		guard !foreign.isEmpty else { return }
		knownIDs.formUnion(foreign.map(\.id))
		entries.append(contentsOf: foreign)
	}

	private func save() {
		guard !isDiscarded else { return }
		adoptEntriesFromFile()
		do {
			try fileManager.createDirectory(
				at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
			let data = try JSONEncoder().encode(Snapshot(entries: entries, failures: failures))
			try data.write(to: fileURL, options: .atomic)
		} catch {
			// Best-effort: the in-memory queue still replays this session, but say it was not saved.
			SyncLog.sync.error("outbox save failed: \(error.localizedDescription, privacy: .public)")
		}
	}
}
