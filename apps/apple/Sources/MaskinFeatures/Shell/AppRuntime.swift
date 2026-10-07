import MaskinCore
import Observation
import SwiftUI

/// The signed-in app's long-lived state, created once by `RootView` and shared through the SwiftUI
/// environment: the notification inbox, the deep-link router, the optional push registrar, and
/// what the shell is presenting (selected tab, object sheet, inbox sheet, requested chat).
@MainActor
@Observable
public final class AppRuntime {
	/// An object shown in a sheet over whatever tab is selected.
	public struct ObjectPresentation: Identifiable, Equatable, Sendable {
		public var id: String
		public init(id: String) { self.id = id }
	}

	public let environment: AppEnvironment
	public let notifications: NotificationsStore
	public let router: DeepLinkRouter
	public let push: PushRegistrar?

	var selectedTab: ShellTab = .forYou

	/// What the shell shows in its ONE sheet. A single value (not a flag per sheet) so two
	/// presentations requested in the same tick (an inbox tap that opens an object) replace each
	/// other deterministically instead of racing, and the sheet can't outlive its workspace.
	public enum Presentation: Identifiable, Equatable, Sendable {
		case object(String)
		case agent(String)
		case file(String)
		case search
		case files
		case agents
		case settings
		case notifications

		public var id: String {
			switch self {
			case .object(let id): "object:\(id)"
			case .agent(let id): "agent:\(id)"
			case .file(let id): "file:\(id)"
			case .search: "search"
			case .files: "files"
			case .agents: "agents"
			case .settings: "settings"
			case .notifications: "notifications"
			}
		}
	}

	/// The sheet currently requested. Asking for the inbox is the first moment the app asks about
	/// push permission (see `requestPushPermission()`): by then the person has seen what a
	/// notification is.
	public var presentation: Presentation? {
		didSet {
			if presentation == .notifications, oldValue != .notifications {
				Task { await requestPushPermission() }
			}
		}
	}

	// Per-sheet accessors over `presentation` (the surface existing callers and tests use).
	public var presentedObject: ObjectPresentation? {
		get { if case .object(let id) = presentation { ObjectPresentation(id: id) } else { nil } }
		set { presentation = newValue.map { .object($0.id) } ?? clearing(.object) }
	}
	public var presentedAgentId: String? {
		get { if case .agent(let id) = presentation { id } else { nil } }
		set { presentation = newValue.map { .agent($0) } ?? clearing(.agent) }
	}
	public var presentedFileId: String? {
		get { if case .file(let id) = presentation { id } else { nil } }
		set { presentation = newValue.map { .file($0) } ?? clearing(.file) }
	}
	public var showSettings: Bool {
		get { presentation == .settings }
		set { presentation = newValue ? .settings : clearing(.settings) }
	}
	public var showNotifications: Bool {
		get { presentation == .notifications }
		set { presentation = newValue ? .notifications : clearing(.notifications) }
	}
	public var showAgents: Bool {
		get { presentation == .agents }
		set { presentation = newValue ? .agents : clearing(.agents) }
	}
	public var showFiles: Bool {
		get { presentation == .files }
		set { presentation = newValue ? .files : clearing(.files) }
	}
	public var showSearch: Bool {
		get { presentation == .search }
		set { presentation = newValue ? .search : clearing(.search) }
	}

	private enum Kind { case object, agent, file, files, agents, settings, notifications, search }

	/// Closing one kind of sheet must not close a DIFFERENT one that replaced it meanwhile.
	private func clearing(_ kind: Kind) -> Presentation? {
		switch (kind, presentation) {
		case (.object, .object), (.agent, .agent), (.file, .file), (.settings, .settings),
			(.notifications, .notifications), (.search, .search), (.files, .files), (.agents, .agents):
			return nil
		default:
			return presentation
		}
	}

	/// Set by a chat link; `ChatsScreen` takes it and resets it to nil.
	public var requestedConversationId: String?

	/// Agents and loops are built by talking, never by filling in a form. Screens that used to offer
	/// a builder form call `buildInChat(_:)`; `ChatsScreen` takes the draft and opens a new chat
	/// with it filled in, so the person picks who to build with. Reset to nil once taken.
	public struct ChatDraft: Equatable, Identifiable, Sendable {
		public let id = UUID()
		public let text: String
	}
	public var chatDraft: ChatDraft?

	public func buildInChat(_ text: String) {
		presentation = nil
		selectedTab = .chats
		chatDraft = ChatDraft(text: text)
	}

	public private(set) var isSigningOut = false

	/// Keeps data current: refetch on returning to the app, connectivity (for the global offline
	/// banner) and replaying queued writes when the network is back. Built once a session is active;
	/// observed, so the banner appears as soon as it exists.
	public private(set) var syncCoordinator: SyncCoordinator?
	@ObservationIgnored private var syncActorId: String?
	@ObservationIgnored private var shareDrain: Task<Void, Never>?
	/// `true` until the coordinator says otherwise (no banner before we know).
	public var isOnline: Bool { syncCoordinator?.isOnline ?? true }

	@ObservationIgnored private var lastSyncedWorkspaceId: String?
	@ObservationIgnored private let signOutTimeout: Duration
	@ObservationIgnored private let forYouDirectory: URL?
	@ObservationIgnored private var forYouRuntime: ForYouRuntime?

	public init(
		environment: AppEnvironment, push: PushRegistrar? = nil,
		notifications: NotificationsStore? = nil, router: DeepLinkRouter? = nil,
		signOutTimeout: Duration = .seconds(3), forYouDirectory: URL? = nil
	) {
		self.forYouDirectory = forYouDirectory
		self.environment = environment
		self.push = push
		self.notifications = notifications ?? NotificationsStore(environment: environment)
		self.router = router ?? DeepLinkRouter(environment: environment)
		self.signOutTimeout = signOutTimeout
	}

	// MARK: For You

	/// The For You runtime (outbox, decisions, feed) for the signed-in actor. Built on first use
	/// and kept until the actor changes or the session ends, so views just read it and never
	/// construct anything. With nobody signed in it returns an inert one that is not retained: a
	/// view that re-renders mid-sign-out gets something to hold without starting listeners or
	/// touching any account's queue.
	public var forYou: ForYouRuntime {
		let actorId = environment.auth.session?.actorId
		if let existing = forYouRuntime {
			if existing.actorId == actorId { return existing }
			// Different actor (or none): stop it but leave its queue on disk for its owner.
			existing.stop()
			forYouRuntime = nil
		}
		guard actorId != nil else {
			return ForYouRuntime.make(environment: environment, directory: forYouDirectory, start: false)
		}
		let runtime = ForYouRuntime.make(environment: environment, directory: forYouDirectory)
		forYouRuntime = runtime
		return runtime
	}

	// MARK: Mentions

	@ObservationIgnored private var rosterProvider: MentionRosterProvider?

	/// Who `@` offers in any composer, for the selected workspace. Built on first use and rebuilt
	/// when the workspace changes. Nil with no workspace.
	func mentionRoster() -> MentionRosterProvider? {
		guard let workspaceID = environment.workspaceId else { return nil }
		if let rosterProvider, rosterProvider.workspaceID == workspaceID { return rosterProvider }
		let provider = MentionRosterProvider(environment: environment, workspaceID: workspaceID)
		rosterProvider = provider
		return provider
	}

	// MARK: Stories

	@ObservationIgnored private var storiesProvider = StoriesProvider()

	/// The briefing and page cards for the selected workspace, shared by For you and the loop pages
	/// so each page is fetched once. Nil with no workspace.
	func storiesStore() -> StoriesStore? { storiesProvider.store(for: environment) }

	// MARK: Workspace sync

	/// What `RootView` keys its sync task on: any change re-points the inbox and gives a held
	/// deep link another chance (the workspace list may just have loaded, or the user just
	/// signed in).
	struct SyncKey: Hashable {
		var signedIn: Bool
		var workspaceId: String?
		var workspacesLoaded: Bool
	}

	var syncKey: SyncKey {
		SyncKey(
			signedIn: environment.auth.session != nil, workspaceId: environment.workspaceId,
			workspacesLoaded: environment.workspaces.phase == .loaded)
	}

	func sync() {
		guard environment.auth.session != nil else {
			if !isSigningOut { sessionEnded() }
			lastSyncedWorkspaceId = nil
			return
		}
		// Anything open (an object, an agent, a file, a thread) belongs to the OLD workspace and
		// would fetch with the new one's header and 404. Settings and the inbox are workspace
		// scoped but rebuild themselves, so only the id-addressed sheets are dropped.
		if let previous = lastSyncedWorkspaceId, previous != environment.workspaceId {
			switch presentation {
			case .object, .agent, .file: presentation = nil
			default: break
			}
			requestedConversationId = nil
		}
		lastSyncedWorkspaceId = environment.workspaceId
		notifications.activate(workspaceId: environment.workspaceId, events: environment.events)
		// Start the chat runtime now (not when the Chats tab first appears) so messages queued
		// offline, or before the app was last killed, replay as soon as the user is signed in.
		_ = ChatsRuntime.shared(environment: environment)
		ensureSyncCoordinator()
		router.evaluate()
		handlePendingLink()
	}

	/// One coordinator per signed-in actor: created on first sync, rebuilt if the actor changes.
	private func ensureSyncCoordinator() {
		let actorId = environment.auth.session?.actorId
		if syncCoordinator != nil, syncActorId == actorId { return }
		syncCoordinator?.stop()
		let coordinator = SyncCoordinator(events: environment.events, outbox: forYou.outbox)
		coordinator.start()
		syncCoordinator = coordinator
		syncActorId = actorId
	}

	private func stopSyncCoordinator() {
		syncCoordinator?.stop()
		syncCoordinator = nil
		syncActorId = nil
	}

	/// Map the app's scene phase onto the coordinator, and tell the chat outbox too (the For You
	/// outbox is driven by the coordinator itself).
	public func scenePhaseChanged(_ phase: SyncScenePhase) {
		syncCoordinator?.scenePhaseChanged(phase)
		if phase == .active, let session = environment.auth.session {
			ChatsRuntime.shared(environment: environment).outbox.appDidBecomeActive()
			drainShareQueue(apiKey: session.apiKey)
		}
	}

	/// Sends what the share extension parked while offline. One drain at a time; the queue is
	/// idempotent, so a drain interrupted by the app being suspended just resumes next time.
	private func drainShareQueue(apiKey: String) {
		guard shareDrain == nil, let queue = ShareQueue.shared(), !queue.pending().isEmpty else { return }
		let baseURL = environment.baseURL
		shareDrain = Task { [weak self] in
			let drainer = ShareQueueDrainer(queue: queue) { ShareSession.remote(baseURL: baseURL, credentials: $0) }
			_ = await drainer.drain(apiKey: apiKey)
			self?.shareDrain = nil
		}
	}

	/// The session ended without the user signing out (the server rejected the key). Stops
	/// everything that was following the old session but, unlike `signOut()`, keeps the user's
	/// queued writes on disk: they replay if the same actor signs in again. Idempotent.
	func sessionEnded() {
		forYouRuntime?.stop()
		forYouRuntime = nil
		rosterProvider = nil
		storiesProvider = StoriesProvider()
		stopSyncCoordinator()
		notifications.stop()
		notifications.reset()
		router.reset()
		environment.workspaces.reset()
		environment.events.disconnect()
		presentation = nil
		requestedConversationId = nil
		selectedTab = .forYou
		FileStore.clearExports()
	}

	/// The signed-in actor changed (`nil` = signed out): keep the push token registered for them.
	/// Never prompts: an already-authorized device re-registers silently, everyone else is asked
	/// later, at `requestPushPermission()`.
	func actorChanged(_ actorId: String?) async {
		await push?.actorChanged(actorId)
	}

	/// Ask for notification permission (the OS prompt shows only while undecided; a denied user is
	/// never re-prompted). Called when the inbox first opens, and available to a settings screen
	/// or an explicit "turn on notifications" prompt. Not called at sign-in: asking before the
	/// person has seen a single notification gets reflexively denied, and a denial is permanent.
	public func requestPushPermission() async {
		guard environment.auth.session != nil else { return }
		await push?.requestAuthorization()
	}

	/// The app icon carries no badge: keep it cleared rather than mirroring the unread count.
	func updateBadge() { push?.setBadge(0) }

	// MARK: Deep links

	/// Offer a URL to the router. `true` if it was a Maskin link (accepted or held).
	@discardableResult
	public func open(_ url: URL) -> Bool {
		let accepted = router.open(url)
		handlePendingLink()
		return accepted
	}

	/// Take a link the router has resolved (workspace already switched) and present it.
	public func handlePendingLink() {
		if let link = router.consume() { present(link) }
	}

	/// Where each kind of link lands. Objects open in a sheet (own navigation stack) over the
	/// current tab; chats select the Chats tab and request the thread; the inbox opens as a sheet.
	public func present(_ link: DeepLink) {
		switch link {
		case .object(_, let id):
			presentation = .object(id)
		case .chat(_, let id):
			presentation = nil
			selectedTab = .chats
			requestedConversationId = id
		case .notifications:
			presentation = .notifications
		}
	}

	/// For You and the shell's own surfaces open objects through here.
	public func openObject(_ id: String) {
		presentation = .object(id)
	}

	public func openAgent(_ id: String) { presentedAgentId = id }
	public func openFile(_ id: String) { presentedFileId = id }

	/// Where a search result lands: objects, agents and files open in a sheet over the current
	/// tab; a chat selects the Chats tab and requests the thread.
	public func openSearchResult(_ result: SearchResult) {
		switch result.kind {
		case .object: openObject(result.entityId)
		case .agent: openAgent(result.entityId)
		case .file: openFile(result.entityId)
		case .chat:
			presentation = nil
			selectedTab = .chats
			requestedConversationId = result.entityId
		}
	}

	/// A user-facing sentence for a link the router refused, or `nil`.
	var rejectionMessage: String? {
		switch router.rejection {
		case .notAMember: "You're not a member of the workspace this link points to."
		case .unrecognized: "That link isn't something Maskin can open."
		case nil: nil
		}
	}

	// MARK: Sign-out

	/// The one sign-out path. Order matters:
	/// 1. unregister this device's push token (needs the credentials; bounded, never blocks),
	/// 2. clear credentials, workspaces and the event stream,
	/// 3. discard the user's persisted outbox and cached For You runtime, so queued writes from
	///    this account can never replay as another (deleted by path, so it goes even if the
///    feed never opened this launch),
	/// 4. reset the inbox, router and presentation state, and clear the icon badge.
	public func signOut() async {
		guard !isSigningOut else { return }
		isSigningOut = true
		defer { isSigningOut = false }
		let actorId = environment.auth.session?.actorId
		let running = forYouRuntime
		forYouRuntime = nil
		rosterProvider = nil
		storiesProvider = StoriesProvider()
		if let push {
			await push.signOut(timeout: signOutTimeout) { [environment] in environment.signOut() }
		} else {
			environment.signOut()
		}
		running?.outbox.discardAll()
		ForYouRuntime.deletePersistedOutbox(actorId: actorId, directory: forYouDirectory)
		// Queued chat messages belong to this account and must never replay as another.
		ChatsRuntime.signOut(actorId: actorId)
		notifications.stop()
		notifications.reset()
		router.reset()
		presentation = nil
		requestedConversationId = nil
		selectedTab = .forYou
		// Local traces of this account: what they searched for and files they exported to share.
		SearchRecents.clearAll()
		FileStore.clearExports()
		stopSyncCoordinator()
		// The cached copy of this account's data (feed, objects, inbox...) goes with the session.
		DiskCache.clearAll()
		push?.setBadge(0)
	}
}
