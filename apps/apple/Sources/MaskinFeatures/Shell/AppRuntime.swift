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
	public var presentedObject: ObjectPresentation?
	/// The inbox sheet. Opening it is the first moment the app asks about push permission (see
	/// `requestPushPermission()`): by then the person has seen what a notification is.
	public var showNotifications = false {
		didSet { if showNotifications, !oldValue { Task { await requestPushPermission() } } }
	}
	/// Set by a chat link; `ChatsScreen` takes it and resets it to nil.
	public var requestedConversationId: String?
	public private(set) var isSigningOut = false

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
			return
		}
		notifications.activate(workspaceId: environment.workspaceId, events: environment.events)
		router.evaluate()
		handlePendingLink()
	}

	/// The session ended without the user signing out (the server rejected the key). Stops
	/// everything that was following the old session but, unlike `signOut()`, keeps the user's
	/// queued writes on disk: they replay if the same actor signs in again. Idempotent.
	func sessionEnded() {
		forYouRuntime?.stop()
		forYouRuntime = nil
		notifications.stop()
		notifications.reset()
		router.reset()
		environment.workspaces.reset()
		environment.events.disconnect()
		presentedObject = nil
		showNotifications = false
		requestedConversationId = nil
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

	/// Mirror the unread count onto the app icon.
	func updateBadge() { push?.setBadge(notifications.unreadCount) }

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
			showNotifications = false
			presentedObject = ObjectPresentation(id: id)
		case .chat(_, let id):
			showNotifications = false
			presentedObject = nil
			selectedTab = .chats
			requestedConversationId = id
		case .notifications:
			presentedObject = nil
			showNotifications = true
		}
	}

	/// For You and the shell's own surfaces open objects through here.
	public func openObject(_ id: String) {
		presentedObject = ObjectPresentation(id: id)
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
		if let push {
			await push.signOut(timeout: signOutTimeout) { [environment] in environment.signOut() }
		} else {
			environment.signOut()
		}
		running?.outbox.discardAll()
		ForYouRuntime.deletePersistedOutbox(actorId: actorId, directory: forYouDirectory)
		notifications.stop()
		notifications.reset()
		router.reset()
		presentedObject = nil
		showNotifications = false
		requestedConversationId = nil
		selectedTab = .forYou
		push?.setBadge(0)
	}
}
