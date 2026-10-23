import Foundation
import MaskinAPI
import Observation

/// What a subscriber receives from `EventHub`.
public enum HubSignal: Sendable, Equatable {
	/// A workspace event. Match on `entityType` / `entityId`, then refetch what changed.
	case event(WorkspaceEvent)
	/// The stream dropped and came back. Events in the gap beyond the server's 100-event replay
	/// window are lost, so stores refetch their lists. NOT sent for the first connection of a
	/// workspace (stores do their own initial load).
	case reconnected
}

/// One live event stream per signed-in workspace, fanned out to any number of subscribers
/// (stores, screens). Owns the `SSEClient`; restarts it when the workspace changes and stops it
/// on sign-out. Subscribing is cheap and independent of connection state, so a store can
/// subscribe at init and keep one `for await` loop for its lifetime:
///
///     for await signal in environment.events.subscribe() {
///         switch signal {
///         case .event(let e) where e.entityType == .conversation: await refresh(e.entityId)
///         case .reconnected: await reload()
///         default: break
///         }
///     }
@MainActor
@Observable
public final class EventHub {
	public enum Connection: Equatable, Sendable {
		case idle
		/// Between a (re)connect attempt and the first byte, or backing off after a drop.
		case connecting
		case live
		/// Not retryable (credentials rejected, workspace gone). Stays until `connect` is called.
		case failed
	}

	public private(set) var connection: Connection = .idle
	public private(set) var workspaceId: String?
	/// Why the stream last `failed` (nil otherwise).
	public private(set) var failure: SSEError?
	/// The stream was refused with 401: the stored key is dead. Wired to `AuthSession` by
	/// `AppEnvironment`, so a revoked key ends the session even when no other request is made.
	///
	/// Receives the API key the REFUSED stream was opened with (nil if none was given to `connect`),
	/// not whatever key is current by the time the refusal arrives: after a key rotation the old
	/// stream's 401 must not end the new session. `AuthSession.sessionRejected(apiKey:)` ignores a
	/// key that is no longer the live one.
	@ObservationIgnored public var onUnauthorized: (@MainActor (_ apiKey: String?) -> Void)?

	@ObservationIgnored private let client: SSEClient?
	@ObservationIgnored private var subscribers: [UUID: AsyncStream<HubSignal>.Continuation] = [:]
	@ObservationIgnored private var pump: Task<Void, Never>?
	/// Bumped on every connect/disconnect so a late update from a replaced stream is dropped.
	@ObservationIgnored private var generation = 0
	/// The key the current stream was opened with, so a changed key restarts it.
	@ObservationIgnored private var streamKey: String?
	/// First wait before a failed stream is retried; doubles per consecutive failure up to `maxRetry`.
	@ObservationIgnored private let retryAfterFailure: Duration
	@ObservationIgnored private static let maxRetry: Duration = .seconds(300)
	@ObservationIgnored private var retryTask: Task<Void, Never>?
	@ObservationIgnored private var consecutiveFailures = 0

	/// `client == nil` makes an inert hub (previews, tests that don't need a stream).
	public init(client: SSEClient?, retryAfterFailure: Duration = .seconds(30)) {
		self.client = client
		self.retryAfterFailure = retryAfterFailure
	}

	/// Production hub: `GET /api/events` with the live credentials, so a workspace switch is
	/// picked up on the next connection.
	public convenience init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider
	) {
		self.init(
			client: SSEClient.events(
				baseURL: baseURL, clientSource: clientSource, credentials: credentials))
	}

	/// Point the stream at `workspaceId`; `nil` stops it. Calling again with the workspace it's
	/// already streaming is a no-op (unless it `failed`, which retries). Pass `credentialKey` (the
	/// API key requests are signed with) so a rotated key restarts the stream with the new key
	/// instead of leaving the old one to be refused.
	public func connect(workspaceId: String?, credentialKey: String? = nil) {
		if workspaceId == self.workspaceId, credentialKey == streamKey, pump != nil,
			connection != .failed
		{
			return
		}
		// Restarting onto the SAME workspace (a rotated key, or a retry after failure) leaves a gap
		// in the event stream: the first connection after it must tell stores to refetch.
		let continuesSameWorkspace = workspaceId == self.workspaceId && pump != nil
		stop()
		self.workspaceId = workspaceId
		self.streamKey = credentialKey
		failure = nil
		guard let workspaceId, let client else {
			connection = .idle
			return
		}
		connection = .connecting
		generation += 1
		let mine = generation
		let openedWith = credentialKey
		pump = Task { [weak self] in
			var hasConnectedBefore = continuesSameWorkspace
			for await update in client.updates() {
				guard let self, self.generation == mine else { return }
				switch update {
				case .connected:
					self.consecutiveFailures = 0
					self.connection = .live
					SyncLog.network.info(
						"sse connected ws=\(SyncLog.shortHash(workspaceId), privacy: .public) gap=\(hasConnectedBefore)")
					if hasConnectedBefore { self.broadcast(.reconnected) }
					hasConnectedBefore = true
				case .event(let sse):
					if let event = WorkspaceEvent(sse: sse), event.workspaceId.map({ $0 == workspaceId }) ?? true {
						self.broadcast(.event(event))
					}
				case .disconnected:
					SyncLog.network.notice("sse disconnected")
					self.connection = .connecting
				case .failed(let error):
					SyncLog.network.error("sse failed")
					self.connection = .failed
					self.failure = error
					if error == .badStatus(401) { self.onUnauthorized?(openedWith) }
					self.scheduleRetry(after: error, generation: mine, workspaceId: workspaceId, key: openedWith)
				}
			}
		}
	}

	public func disconnect() { connect(workspaceId: nil) }

	/// Ask every subscriber to refetch what it shows, without a reconnect (the app returned to the
	/// foreground, connectivity came back). It is the existing `.reconnected` signal, so stores
	/// need no new case. Prefer `SyncCoordinator`, which coalesces calls.
	public func requestRefresh() {
		SyncLog.sync.info("refresh requested")
		broadcast(.reconnected)
	}

	/// A new stream of signals. Ends when its consumer stops iterating or is cancelled.
	public func subscribe() -> AsyncStream<HubSignal> {
		let id = UUID()
		let (stream, continuation) = AsyncStream<HubSignal>.makeStream()
		subscribers[id] = continuation
		continuation.onTermination = { [weak self] _ in
			Task { @MainActor in self?.subscribers[id] = nil }
		}
		return stream
	}

	private func broadcast(_ signal: HubSignal) {
		for continuation in subscribers.values { continuation.yield(signal) }
	}

	/// A stream that ended on a status the client won't retry (a 404 or 400 from a proxy mid-deploy,
	/// say) would otherwise stay dead for the rest of the session: nothing reconnects it, and every
	/// thread then waits for events that never come. Only a rejection of the credentials themselves
	/// (401 / 403, what the web client also treats as final) is left alone.
	private func scheduleRetry(after error: SSEError, generation mine: Int, workspaceId: String, key: String?) {
		if error == .badStatus(401) || error == .badStatus(403) { return }
		consecutiveFailures += 1
		var wait = retryAfterFailure
		for _ in 1..<max(consecutiveFailures, 1) where wait < Self.maxRetry { wait = wait * 2 }
		wait = min(wait, Self.maxRetry)
		retryTask?.cancel()
		retryTask = Task { [weak self] in
			try? await Task.sleep(for: wait)
			guard !Task.isCancelled, let self, self.generation == mine, self.connection == .failed else { return }
			SyncLog.network.info("sse retrying after failure")
			self.connect(workspaceId: workspaceId, credentialKey: key)
		}
	}

	private func stop() {
		generation += 1
		pump?.cancel()
		pump = nil
		retryTask?.cancel()
		retryTask = nil
	}
}
