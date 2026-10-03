import Foundation
import MaskinAPI

/// The long-lived part of Chats: the durable send queue (one outbox file per signed-in actor).
/// It outlives the Chats screen so a message typed in a thread keeps sending after the user
/// leaves the tab, and a message queued before the app was killed goes out on the next launch.
@MainActor
public final class ChatsRuntime {
	public let outbox: Outbox
	public let queue: ChatSendQueue
	public let actorId: String?

	private static var registry: [String: ChatsRuntime] = [:]

	init(outbox: Outbox, queue: ChatSendQueue, actorId: String?) {
		self.outbox = outbox
		self.queue = queue
		self.actorId = actorId
	}

	static func outboxFileURL(actorId: String?, directory: URL? = nil) -> URL {
		(directory ?? Outbox.defaultFileURL().deletingLastPathComponent())
			.appendingPathComponent("chat-outbox-\(actorId ?? "anonymous").json")
	}

	/// The runtime for the environment's signed-in actor, built on first use and kept. Call it at
	/// launch / sign-in (not only when the Chats tab opens) so queued sends replay right away.
	public static func shared(environment: AppEnvironment, directory: URL? = nil) -> ChatsRuntime {
		let key = environment.auth.session?.actorId ?? "anonymous"
		if let existing = registry[key] { return existing }
		let runtime = make(environment: environment, directory: directory)
		registry[key] = runtime
		return runtime
	}

	/// Build a runtime. `start: false` makes an inert one (no listeners, no replay).
	public static func make(
		environment: AppEnvironment, directory: URL? = nil, start: Bool = true
	) -> ChatsRuntime {
		let actorId = environment.auth.session?.actorId
		let box = QueueBox()
		let executor = ChatSendExecutor(
			api: { @Sendable in
				let workspace = await MainActor.run { environment.workspaceId ?? "" }
				return APIChatsSource(client: environment.client, workspaceID: workspace)
			},
			onDelivered: { @Sendable clientID, message in
				await MainActor.run { box.queue?.recordDelivery(clientID: clientID, message: message) }
			})
		let outbox = Outbox(
			fileURL: outboxFileURL(actorId: actorId, directory: directory), executor: executor,
			workspaceId: { environment.workspaceId })
		let queue = ChatSendQueue(
			outbox: outbox, failedFileURL: ChatSendQueue.failedFileURL(actorId: actorId, directory: directory))
		box.queue = queue
		if start {
			queue.start()
			outbox.start(events: environment.events)
		}
		return ChatsRuntime(outbox: outbox, queue: queue, actorId: actorId)
	}

	/// Sign-out: drop this actor's queued and failed sends so they can never replay as someone
	/// else. Deleted by path, so it works even if Chats never opened this launch.
	public static func signOut(actorId: String?, directory: URL? = nil) {
		let key = actorId ?? "anonymous"
		ChatDraftStore.clearAll()
		if let running = registry.removeValue(forKey: key) {
			running.queue.stop()
			running.outbox.discardAll()
		}
		try? FileManager.default.removeItem(at: outboxFileURL(actorId: actorId, directory: directory))
		ChatSendQueue.deletePersistedFailures(actorId: actorId, directory: directory)
	}

	private final class QueueBox: @unchecked Sendable {
		@MainActor var queue: ChatSendQueue?
	}
}
