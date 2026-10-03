import Foundation

/// The long-lived pieces For You needs for one signed-in actor: the offline outbox (shared, so
/// Chats can enqueue into it later), the decision service and the feed store.
///
/// Owned by `AppRuntime` (one per signed-in actor), never created from a view: a view's `init`
/// runs on every re-render, including the ones during sign-out, and must have no side effects.
@MainActor
public final class ForYouRuntime {
	public let outbox: Outbox
	public let decisions: DecisionService
	public let store: ForYouStore
	/// Whose queue this is.
	public let actorId: String?

	public init(
		outbox: Outbox, decisions: DecisionService, store: ForYouStore, actorId: String? = nil
	) {
		self.outbox = outbox
		self.decisions = decisions
		self.store = store
		self.actorId = actorId
	}

	/// Stop reacting to events and connectivity WITHOUT touching the persisted queue. For when the
	/// session ended involuntarily (revoked key): the queued writes wait for the same actor to
	/// sign in again.
	public func stop() {
		outbox.stop()
		store.stop()
	}

	/// Where an actor's queue lives. One file per actor, so one account's writes can never be
	/// replayed as another's.
	public static func outboxFileURL(actorId: String?, directory: URL? = nil) -> URL {
		(directory ?? Outbox.defaultFileURL().deletingLastPathComponent())
			.appendingPathComponent("outbox-\(actorId ?? "anonymous").json")
	}

	/// Sign-out: delete an actor's persisted queue BY PATH, so it goes even when no runtime was
	/// ever built for it in this launch (a queue restored from disk, then signed out before the
	/// feed opened).
	public static func deletePersistedOutbox(
		actorId: String?, directory: URL? = nil, fileManager: FileManager = .default
	) {
		try? fileManager.removeItem(at: outboxFileURL(actorId: actorId, directory: directory))
	}

	/// Delete every queue file that belongs to someone else. A session that ended involuntarily
	/// keeps its queue for the same actor to resume; the moment a DIFFERENT actor signs in, that
	/// queue can never be replayed by anyone, so it goes.
	static func purgeOutboxes(
		except actorId: String, directory: URL? = nil, fileManager: FileManager = .default
	) {
		let dir = outboxFileURL(actorId: actorId, directory: directory).deletingLastPathComponent()
		let keep = outboxFileURL(actorId: actorId, directory: directory).lastPathComponent
		let names = (try? fileManager.contentsOfDirectory(atPath: dir.path)) ?? []
		for name in names where name.hasPrefix("outbox-") && name.hasSuffix(".json") && name != keep {
			try? fileManager.removeItem(at: dir.appendingPathComponent(name))
		}
	}

	/// Build the runtime for the environment's current actor. `start: false` makes an inert one
	/// (no listeners, no replay) for when nobody is signed in.
	public static func make(
		environment: AppEnvironment, directory: URL? = nil, start: Bool = true
	) -> ForYouRuntime {
		let backend = APIForYouBackend(
			client: environment.client,
			workspaceId: { @Sendable in await MainActor.run { environment.workspaceId ?? "" } })
		let actorId = environment.auth.session?.actorId
		if start, let actorId { purgeOutboxes(except: actorId, directory: directory) }
		let outbox = Outbox(
			fileURL: outboxFileURL(actorId: actorId, directory: directory),
			executor: DecisionOutboxExecutor(backend: backend),
			workspaceId: { environment.workspaceId })
		let decisions = DecisionService(outbox: outbox)
		let store = ForYouStore(
			source: backend, decisions: decisions, workspaceId: { environment.workspaceId },
			cache: environment.snapshotCache)
		if start { store.widgetReloader = makeWidgetReloader() }
		if start {
			outbox.start(events: environment.events)
			store.start(events: environment.events)
		}
		return ForYouRuntime(outbox: outbox, decisions: decisions, store: store, actorId: actorId)
	}
}
