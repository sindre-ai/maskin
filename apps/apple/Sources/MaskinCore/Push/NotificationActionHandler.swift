import CryptoKit
import Foundation
import MaskinAPI

// Performs a decision tapped on a push notification, with no UI and no running app.
//
// WHEN IT RUNS: iOS launches the app in the background for an action tap (about 30 seconds), so
// this must not depend on any live runtime: credentials come from the shared Keychain, the
// client is built here, and a write that cannot go out is parked in the durable outbox file.
//
// THE SAME DECISION PATH: the write is exactly what `DecisionService` does for the For You
// card, through the same `DecisionBackend` (`POST /api/events` with the option label as the
// comment, `parent_event_id` = the agent's comment, then `POST /api/subscriptions/read`).
// The difference is the Undo window: there is none. A tap on a notification button is an
// explicit, deliberate act, and the user may be looking at a lock screen, not at our UI, so the
// write goes out immediately.
//
// RETRY SAFETY: every write carries a deterministic Idempotency-Key derived from the decision
// and the answer, so a double tap, an OS retry, or this attempt timing out on the wire and then
// being replayed from the outbox cannot post the answer twice.
//
// OUTBOX FILE: the fallback appends to the actor's outbox file. If the app is running in the
// foreground at the same moment AND offline, its own in-memory queue could overwrite that file;
// the window is a few milliseconds on a device that just lost the network, and the worst case
// is the answer is lost (the notification stays, the user retries) rather than sent twice.

public enum NotificationActionOutcome: Sendable, Equatable {
	/// The answer was posted and the thread marked read.
	case answered(String)
	/// No network (or the request timed out): saved, and sent the next time the app runs.
	case queued(String)
	/// The server refused it, or it could not even be saved. The notification stays.
	case failed(String)
	/// No stored session; the user has to open the app and sign in.
	case notSignedIn
}

/// A decision write that could not go out now.
public struct QueuedDecision: Sendable, Equatable {
	/// Only so the outbox's own immediate replay attempt is authenticated; never persisted.
	public var session: StoredSession
	public var actorId: String
	public var workspaceId: String
	public var entityId: String
	/// `nil` when the comment already went out and only the mark-read is owed.
	public var content: String?
	public var parentEventId: Int?
	public var lastEventId: Int?
}

public protocol DecisionQueueing: Sendable {
	func enqueue(_ write: QueuedDecision) async throws
}

public struct NotificationActionHandler: Sendable {
	public typealias BackendFactory = @Sendable (_ session: StoredSession, _ workspaceId: String) -> any DecisionBackend

	private let secrets: any SecretStore
	private let backend: BackendFactory
	private let queue: any DecisionQueueing
	private let attemptTimeout: Duration

	public init(
		secrets: any SecretStore, backend: @escaping BackendFactory, queue: any DecisionQueueing,
		attemptTimeout: Duration = .seconds(20)
	) {
		self.secrets = secrets
		self.backend = backend
		self.queue = queue
		self.attemptTimeout = attemptTimeout
	}

	/// What to do for a tapped option or typed reply. `NotificationActionPlan.choice` decides
	/// which of the two a tap is; `.open` and the default tap are the app's business, not this.
	public func perform(
		_ kind: NotificationActionPlan.Action.Kind, userText: String?, payload: PushDecisionPayload
	) async -> NotificationActionOutcome {
		let content: String
		switch kind {
		case .option(let label): content = label
		case .reply:
			let text = userText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
			guard !text.isEmpty else { return .failed("Type a reply first.") }
			content = text
		case .open: return .failed("Nothing to send.")
		}

		guard let data = try? secrets.read(),
			let session = try? JSONDecoder().decode(StoredSession.self, from: data)
		else { return .notSignedIn }

		let backend = backend(session, payload.workspaceId)
		let key = Self.idempotencyKey(payload: payload, content: content)

		// 1. The answer. 2. Mark the thread read, which is what clears it from the feed.
		do {
			try await attempt { [payload] in
				try await IdempotencyKey.$current.withValue(key + "-comment") {
					try await backend.postComment(
						entityId: payload.objectId, content: content, parentEventId: payload.eventId)
				}
			}
		} catch {
			return await fallback(
				error, label: content, session: session, payload: payload, content: content)
		}
		do {
			try await attempt { [payload] in
				try await IdempotencyKey.$current.withValue(key + "-read") {
					try await backend.markRead(entityId: payload.objectId, lastEventId: payload.eventId)
				}
			}
		} catch {
			// The answer is already out. A failed mark-read only leaves the card in the feed, so
			// owe it to the outbox and still report success.
			_ = try? await queue.enqueue(
				QueuedDecision(
					session: session, actorId: session.actorId, workspaceId: payload.workspaceId,
					entityId: payload.objectId, content: nil, parentEventId: nil,
					lastEventId: payload.eventId))
		}
		return .answered(content)
	}

	private func fallback(
		_ error: any Error, label: String, session: StoredSession, payload: PushDecisionPayload,
		content: String
	) async -> NotificationActionOutcome {
		if error is OutboxAuthRequired {
			return .failed("Open Maskin and sign in again to send this.")
		}
		if let rejection = error as? OutboxRejection {
			if OutboxRejection.isAuthFailure(status: rejection.status ?? 0) {
				return .failed("Open Maskin and sign in again to send this.")
			}
			return .failed(rejection.message)
		}
		// Anything else (offline, timeout, 5xx) is transient: keep it for the next launch.
		do {
			try await queue.enqueue(
				QueuedDecision(
					session: session, actorId: session.actorId, workspaceId: payload.workspaceId,
					entityId: payload.objectId, content: content, parentEventId: payload.eventId,
					lastEventId: payload.eventId))
			return .queued(label)
		} catch {
			return .failed("Couldn't send this. Open Maskin to answer.")
		}
	}

	/// Run one write, giving up (as a transient failure) after `attemptTimeout` so the OS's
	/// background budget is never what ends us mid-request.
	private func attempt(_ work: @escaping @Sendable () async throws -> Void) async throws {
		try await withThrowingTaskGroup(of: Void.self) { group in
			group.addTask { try await work() }
			group.addTask {
				try await Task.sleep(for: attemptTimeout)
				throw URLError(.timedOut)
			}
			defer { group.cancelAll() }
			_ = try await group.next()
		}
	}

	/// Stable for one (decision, answer): the server collapses replays of it into one write.
	static func idempotencyKey(payload: PushDecisionPayload, content: String) -> String {
		let material = "\(payload.workspaceId)|\(payload.objectId)|\(payload.eventId)|\(content)"
		let digest = SHA256.hash(data: Data(material.utf8))
		return "push-" + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
	}
}

// MARK: - Production wiring

extension NotificationActionHandler {
	/// The real handler: the generated client with the stored key, aimed at the notification's
	/// own workspace (not whichever one the app last selected), and the durable outbox as the
	/// offline fallback.
	public static func production(
		baseURL: URL, clientSource: String, secrets: any SecretStore, outboxDirectory: URL? = nil
	) -> NotificationActionHandler {
		let backend: BackendFactory = { session, workspaceId in
			let client = MaskinClient.make(
				serverURL: baseURL, clientSource: clientSource,
				credentials: { MaskinCredentials(apiKey: session.apiKey, workspaceId: workspaceId) })
			return APIForYouBackend(client: client, workspaceId: { workspaceId })
		}
		return NotificationActionHandler(
			secrets: secrets, backend: backend,
			queue: OutboxDecisionQueue(backend: backend, directory: outboxDirectory))
	}
}

/// Parks a decision write in the actor's outbox file, where the app's own outbox picks it up.
public struct OutboxDecisionQueue: DecisionQueueing {
	private let backend: NotificationActionHandler.BackendFactory
	private let directory: URL?

	public init(backend: @escaping NotificationActionHandler.BackendFactory, directory: URL? = nil) {
		self.backend = backend
		self.directory = directory
	}

	public func enqueue(_ write: QueuedDecision) async throws {
		let backend = backend
		let directory = directory
		try await MainActor.run {
			let outbox = Outbox(
				fileURL: ForYouRuntime.outboxFileURL(actorId: write.actorId, directory: directory),
				executor: DecisionOutboxExecutor(backend: backend(write.session, write.workspaceId)),
				workspaceId: { write.workspaceId })
			let group = UUID().uuidString
			let lane = "object:\(write.entityId)"
			if let content = write.content {
				try outbox.enqueue(
					kind: DecisionService.commentKind, lane: lane, groupId: group,
					summary: "Your reply on \u{201C}\(DecisionService.excerpt(content))\u{201D}",
					payload: CommentPayload(
						entityId: write.entityId, content: content, parentEventId: write.parentEventId))
			}
			if let last = write.lastEventId {
				try outbox.enqueue(
					kind: DecisionService.markReadKind, lane: lane, groupId: group,
					summary: "Mark thread as read",
					payload: MarkReadPayload(entityId: write.entityId, lastEventId: last))
			}
		}
	}
}
