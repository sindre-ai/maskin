import Foundation
import MaskinAPI
import Observation

/// What a queued send carries. Persisted in the outbox, so every field is plain data.
struct ChatSendPayload: Codable, Sendable, Equatable {
	var clientID: String
	var conversationID: String
	var content: String
	var metadata: ChatSendMetadata?
	/// The newest server message id the sender had seen. Lets the thread tell "my message,
	/// already on the server" from an older identical one when a refetch races the response.
	var afterServerID: Int?
	var createdAt: Date
}

/// A message the user sent that the server has not confirmed yet.
public struct PendingChatSend: Identifiable, Equatable, Sendable {
	public enum State: Equatable, Sendable {
		/// Going out (or about to).
		case sending
		/// Held back: offline, signed out, or backing off after an error. It will go by itself.
		case waiting(String)
		/// The server refused it for good. The user retries or deletes it.
		case failed(String)
	}

	public var id: String
	public var conversationID: String
	public var content: String
	public var metadata: ChatSendMetadata?
	public var afterServerID: Int?
	public var createdAt: Date
	public var state: State

	/// The row as the thread renders it.
	public func asMessage(actorID: String, actorName: String) -> ChatMessage {
		let status: ChatMessage.Status
		switch state {
		case .sending: status = .sending
		case .waiting(let reason): status = .waiting(reason)
		case .failed(let reason): status = .failed(reason)
		}
		return ChatMessage(
			id: "local-\(id)", conversationID: conversationID, actorID: actorID, actorName: actorName,
			author: .human, content: content, createdAt: createdAt, metadata: metadata?.jsonValue,
			status: status, idempotencyKey: id)
	}
}

public enum ChatSendEvent: Sendable, Equatable {
	/// The server accepted the message; `message` is the persisted row.
	case delivered(clientID: String, message: ChatMessage)
	/// The server refused it permanently; it is now in the failed list.
	case failed(clientID: String, reason: String)
}

/// Durable chat writes. Every send goes through the shared `Outbox` (one lane per conversation,
/// a stable Idempotency-Key per message), so a message typed offline, or while the app is
/// killed, goes out exactly once when it can. Permanently refused sends are kept (on disk) as
/// failed rows so the user can retry or delete them instead of losing their words.
@MainActor
@Observable
public final class ChatSendQueue {
	public nonisolated static let sendKind = "chat.send"

	public private(set) var failed: [PendingChatSend] = []

	@ObservationIgnored private let outbox: Outbox
	@ObservationIgnored private let failedFileURL: URL?
	@ObservationIgnored private let fileManager: FileManager
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private var subscribers: [UUID: AsyncStream<ChatSendEvent>.Continuation] = [:]
	@ObservationIgnored private var listener: Task<Void, Never>?

	public init(
		outbox: Outbox, failedFileURL: URL? = nil, fileManager: FileManager = .default,
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.outbox = outbox
		self.failedFileURL = failedFileURL
		self.fileManager = fileManager
		self.now = now
		loadFailed()
	}

	deinit { MainActor.assumeIsolated { listener?.cancel() } }

	/// Begin turning outbox rejections into failed rows. Idempotent.
	public func start() {
		guard listener == nil else { return }
		let events = outbox.events()
		listener = Task { [weak self] in
			for await event in events {
				guard let self else { return }
				if case .rejected(let entry, let message) = event { self.recordFailure(entry, message: message) }
			}
		}
	}

	public func stop() {
		listener?.cancel()
		listener = nil
	}

	// MARK: Reading

	/// Everything not yet confirmed for one conversation, oldest first: failed rows, then the
	/// queued ones in send order.
	public func pending(in conversationID: String) -> [PendingChatSend] {
		let queued = outbox.entries.compactMap { entry -> PendingChatSend? in
			guard entry.kind == Self.sendKind,
				let payload = try? JSONDecoder().decode(ChatSendPayload.self, from: entry.payload),
				payload.conversationID == conversationID
			else { return nil }
			return PendingChatSend(
				id: payload.clientID, conversationID: conversationID, content: payload.content,
				metadata: payload.metadata, afterServerID: payload.afterServerID,
				createdAt: payload.createdAt, state: state(of: entry))
		}
		return (failed.filter { $0.conversationID == conversationID } + queued)
			.sorted { $0.createdAt < $1.createdAt }
	}

	/// Whether anything is waiting to go out in any conversation (for a "sending…" hint).
	public var queuedCount: Int { outbox.entries.filter { $0.kind == Self.sendKind }.count }

	private func state(of entry: OutboxEntry) -> PendingChatSend.State {
		if outbox.isAuthBlocked { return .waiting("Sign in again to send") }
		if !outbox.isOnline { return .waiting("Waiting for a connection") }
		if entry.attempts > 0 { return .waiting("Will retry shortly") }
		return .sending
	}

	// MARK: Writing

	/// Queue a message. Returns at once; the outbox sends it (immediately when online).
	@discardableResult
	public func send(
		conversationID: String, content: String, metadata: ChatSendMetadata? = nil,
		afterServerID: Int? = nil, clientID: String = UUID().uuidString
	) throws -> PendingChatSend {
		let payload = ChatSendPayload(
			clientID: clientID, conversationID: conversationID, content: content,
			metadata: metadata?.isEmpty == true ? nil : metadata, afterServerID: afterServerID,
			createdAt: now())
		try outbox.enqueue(
			kind: Self.sendKind, lane: "chat:\(conversationID)", groupId: clientID,
			summary: "Message to a conversation", payload: payload)
		return pending(in: conversationID).first { $0.id == clientID }
			?? PendingChatSend(
				id: clientID, conversationID: conversationID, content: content, metadata: metadata,
				afterServerID: afterServerID, createdAt: payload.createdAt, state: .sending)
	}

	/// Re-queue a failed send as a fresh message (the server never accepted the old one).
	public func retry(_ clientID: String) {
		guard let row = failed.first(where: { $0.id == clientID }) else { return }
		failed.removeAll { $0.id == clientID }
		saveFailed()
		_ = try? send(
			conversationID: row.conversationID, content: row.content, metadata: row.metadata,
			afterServerID: row.afterServerID, clientID: clientID)
	}

	/// Drop a send the user no longer wants. A queued one is cancelled unless it is already on
	/// the wire (returns `false` then: it will land, and the thread shows it as delivered).
	@discardableResult
	public func discard(_ clientID: String) -> Bool {
		if failed.contains(where: { $0.id == clientID }) {
			failed.removeAll { $0.id == clientID }
			saveFailed()
			return true
		}
		return outbox.cancel(groupId: clientID)
	}

	public func events() -> AsyncStream<ChatSendEvent> {
		let id = UUID()
		let (stream, continuation) = AsyncStream<ChatSendEvent>.makeStream()
		subscribers[id] = continuation
		continuation.onTermination = { [weak self] _ in Task { @MainActor in self?.subscribers[id] = nil } }
		return stream
	}

	/// Called by the executor the moment the server confirms a send.
	func recordDelivery(clientID: String, message: ChatMessage) {
		for continuation in subscribers.values {
			continuation.yield(.delivered(clientID: clientID, message: message))
		}
	}

	private func recordFailure(_ entry: OutboxEntry, message: String) {
		guard entry.kind == Self.sendKind,
			let payload = try? JSONDecoder().decode(ChatSendPayload.self, from: entry.payload)
		else { return }
		failed.removeAll { $0.id == payload.clientID }
		failed.append(
			PendingChatSend(
				id: payload.clientID, conversationID: payload.conversationID, content: payload.content,
				metadata: payload.metadata, afterServerID: payload.afterServerID,
				createdAt: payload.createdAt, state: .failed(message)))
		saveFailed()
		for continuation in subscribers.values {
			continuation.yield(.failed(clientID: payload.clientID, reason: message))
		}
	}

	/// Sign-out: forget everything this queue holds on disk.
	public static func deletePersistedFailures(actorId: String?, directory: URL? = nil) {
		try? FileManager.default.removeItem(at: failedFileURL(actorId: actorId, directory: directory))
	}

	public static func failedFileURL(actorId: String?, directory: URL? = nil) -> URL {
		(directory ?? Outbox.defaultFileURL().deletingLastPathComponent())
			.appendingPathComponent("chat-failed-\(actorId ?? "anonymous").json")
	}

	// MARK: Persistence

	private func loadFailed() {
		guard let url = failedFileURL, let data = try? Data(contentsOf: url),
			let rows = try? JSONDecoder().decode([FailedRow].self, from: data)
		else { return }
		failed = rows.map(\.pending)
	}

	private func saveFailed() {
		guard let url = failedFileURL else { return }
		do {
			if failed.isEmpty {
				try? fileManager.removeItem(at: url)
				return
			}
			try fileManager.createDirectory(
				at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
			try JSONEncoder().encode(failed.map(FailedRow.init)).write(to: url, options: .atomic)
		} catch {
			// Best effort: the in-memory list still serves this launch.
		}
	}

	private struct FailedRow: Codable {
		var payload: ChatSendPayload
		var reason: String

		init(_ row: PendingChatSend) {
			payload = ChatSendPayload(
				clientID: row.id, conversationID: row.conversationID, content: row.content,
				metadata: row.metadata, afterServerID: row.afterServerID, createdAt: row.createdAt)
			if case .failed(let message) = row.state { reason = message } else { reason = "Not sent" }
		}

		var pending: PendingChatSend {
			PendingChatSend(
				id: payload.clientID, conversationID: payload.conversationID, content: payload.content,
				metadata: payload.metadata, afterServerID: payload.afterServerID,
				createdAt: payload.createdAt, state: .failed(reason))
		}
	}
}

/// Replays queued chat sends against the API. Register under the `chat.` prefix of an outbox's
/// executor.
public struct ChatSendExecutor: OutboxExecuting {
	private let makeAPI: @Sendable () async -> any ChatAPI
	private let onDelivered: @Sendable (_ clientID: String, _ message: ChatMessage) async -> Void

	/// `api` is resolved at replay time, so a workspace switch is picked up without rebuilding.
	public init(
		api: @escaping @Sendable () async -> any ChatAPI,
		onDelivered: @escaping @Sendable (_ clientID: String, _ message: ChatMessage) async -> Void
	) {
		makeAPI = api
		self.onDelivered = onDelivered
	}

	public init(
		api: any ChatAPI,
		onDelivered: @escaping @Sendable (_ clientID: String, _ message: ChatMessage) async -> Void
	) {
		self.init(api: { api }, onDelivered: onDelivered)
	}

	public func execute(kind: String, payload: Data) async throws {
		guard kind == ChatSendQueue.sendKind,
			let send = try? JSONDecoder().decode(ChatSendPayload.self, from: payload)
		else { throw OutboxRejection(message: "Unknown queued chat action.") }
		guard let key = IdempotencyKey.current else {
			throw OutboxRejection(message: "Missing idempotency key.")
		}
		do {
			let saved = try await makeAPI().send(
				conversationID: send.conversationID, content: send.content, metadata: send.metadata,
				idempotencyKey: key)
			await onDelivered(send.clientID, saved)
		} catch {
			throw Self.classify(error)
		}
	}

	/// 401 holds the whole queue for a re-login. Every other 4xx means this message will never be
	/// accepted (including 403: the person left the conversation), so it must not block the lane
	/// forever. Anything else (offline, 5xx, timeouts) is retried under the same key.
	static func classify(_ error: any Error) -> any Error {
		guard let http = error as? ChatsHTTPError else { return error }
		if http.status == 401 { return OutboxAuthRequired(status: 401) }
		if (400..<500).contains(http.status), http.status != 408, http.status != 429 {
			// 403 carries no status: the outbox would read it as "credentials are bad" and hold
			// the whole queue instead of dropping this one message.
			return OutboxRejection(status: http.status == 403 ? nil : http.status, message: http.message)
		}
		return error
	}
}
