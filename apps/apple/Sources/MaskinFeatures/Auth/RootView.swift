import MaskinCore
import MaskinUI
import SwiftUI

/// App root: login when signed out, the shell otherwise. Also drives the runtime: restores the
/// stored session, loads workspaces after sign-in, points the event stream and the notification
/// inbox at the selected workspace, and routes deep links (held until signed in).
public struct RootView: View {
	private let environment: AppEnvironment
	@Environment(\.scenePhase) private var scenePhase
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var runtime: AppRuntime
	/// Names and kinds for the in-app links that appear in markdown (chat messages, comments).
	@State private var links: InternalLinkDirectory
	/// Thumbnails for the photos attached to chat messages.
	@State private var chatImages: ChatImageLoader
private let onRuntimeReady: (AppRuntime) -> Void
	/// Resolves the seeded Chief of Staff conversation's id for the signed-in workspace, if one
	/// exists. The first-use screen offers "Open the welcome chat" only when this returns an id.
	/// `nil` (the default) means For You is the only landing; the shell wires this when it can.
	private let welcomeConversationId: (@MainActor () async -> String?)?
	/// The actor whose first-use screen is showing (a sign-up made it pending), else `nil`.
	@State private var firstUseActorId: String?
	@State private var welcomeChatId: String?
	@State private var isRetryingWorkspace = false
	/// Reloads the home/lock-screen widgets on sign-in, sign-out, workspace switch and backgrounding.
	@State private var widgetReloader = makeWidgetReloader()
	/// Workspace invitation links: holds the token across sign-in and relaunch, presents the screen.
	@State private var invites: InviteCoordinator
	/// Opt-in Face ID / Touch ID / passcode lock (Settings → Security). Off by default.
	@State private var appLock: AppLockController
	#if os(iOS)
		/// Covers sheets too, which a SwiftUI overlay on this view cannot.
		@State private var appLockWindow: AppLockWindowPresenter
	#endif

	/// `push` is the platform's registrar (built by the app target); `onRuntimeReady` hands the
	/// app delegate the runtime's router so notification taps reach it.
	public init(
		environment: AppEnvironment, push: PushRegistrar? = nil,
		onRuntimeReady: @escaping (AppRuntime) -> Void = { _ in },
		welcomeConversationId: (@MainActor () async -> String?)? = nil,
		appLock: AppLockController? = nil
	) {
		self.environment = environment
		self.welcomeConversationId = welcomeConversationId
		self.onRuntimeReady = onRuntimeReady
		let lock = appLock ?? AppLockController(authenticator: LocalAuthenticator())
		_appLock = State(initialValue: lock)
		#if os(iOS)
			_appLockWindow = State(initialValue: AppLockWindowPresenter(lock: lock))
		#endif
		_runtime = State(initialValue: AppRuntime(environment: environment, push: push))
		_invites = State(initialValue: Self.makeInvites(environment))
		_chatImages = State(
			initialValue: ChatImageLoader(
				files: APIFilesRemote(client: environment.client, credentials: environment.auth.credentialsProvider)))
		_links = State(
			initialValue: InternalLinkDirectory(store: { [weak environment] in
				environment.flatMap { LinkedItemStores.store(for: $0) }
			}))
	}

	public var body: some View {
		let auth = environment.auth
		Group {
			if let session = auth.session {
				if firstUseActorId == session.actorId {
					firstUse(session: session, auth: auth)
				} else if environment.workspaces.hasNoWorkspaces {
					NoWorkspacesView(environment: environment, runtime: runtime)
				} else {
					MainShell(environment: environment, runtime: runtime)
				}
			} else {
				AuthView(environment: environment)
			}
		}
		.animation(reduceMotion ? nil : .default, value: auth.session != nil)
		.appLockCover(appLock)
		.environment(appLock)
		.onChange(of: auth.session != nil, initial: true) { _, hasSession in
			appLock.sessionChanged(hasSession: hasSession)
		}
		#if os(iOS)
			.task { appLockWindow.start() }
		#endif
		.onChange(of: auth.session?.actorId, initial: true) { _, id in
			firstUseActorId = id.flatMap { auth.firstUse.isPending(actorId: $0) ? $0 : nil }
		}
		.task(id: firstUseActorId) {
			welcomeChatId = firstUseActorId == nil ? nil : await welcomeConversationId?()
		}
		.handlesDeepLinks(runtime.router, intercept: { invites.open($0) }) { runtime.present($0) }
		.onChange(of: auth.session?.actorId, initial: true) { _, id in
			if id == nil { invites.signedOut() } else { invites.resume(isSignedIn: true) }
		}
		.sheet(isPresented: $invites.isPresented) {
			if let store = invites.store {
				InviteView(
					store: store, onFinish: { invites.finish() },
					onSignIn: { invites.dismiss() }, onClose: { invites.dismiss() })
			}
		}
		// Only Maskin links go to the router; it flags anything else (GitHub, ...) as unopenable, so
		// outside links must fall through to the markdown view's own confirm-and-open path.
		.environment(
			\.markdownInternalLinkHandler,
			{ @MainActor [runtime] url in DeepLink(url: url) != nil && runtime.open(url) })
		.environment(\.markdownInternalLinkInfo, { @MainActor [links] url in links.info(for: url) })
		.environment(\.markdownStandaloneLink, { @MainActor [environment] url, _ in
			LinkedItemStores.standaloneStyle(for: url, environment: environment)
		})
		.environment(\.markdownChipPreview, { @MainActor [environment] url in
			LinkedItemStores.chipPreview(for: url, environment: environment)
		})
		.environment(
			\.attachmentImages,
			AttachmentImages(
				cached: { [chatImages] id in chatImages.cachedImage(for: id) },
				load: { [chatImages] id in await chatImages.image(for: id) })
		)
		.environment(\.openAttachment, { @MainActor [runtime] id in runtime.openFile(id) })
		.task { onRuntimeReady(runtime) }
		.task { ThreadWarmup.run() }
		.task(id: auth.session?.apiKey) { await environment.workspaces.refresh() }
		.task(id: auth.credentials) { environment.syncEvents() }
		.task(id: runtime.syncKey) { runtime.sync() }
		.task(id: auth.session?.actorId) { await runtime.actorChanged(auth.session?.actorId) }
		.task { runtime.updateBadge() }
		.onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in
			runtime.timeZoneDidChange()
		}
		.onChange(of: [auth.session?.actorId ?? "", auth.session?.workspaceId ?? ""]) {
			widgetReloader.reload()
		}
		.onChange(of: scenePhase) { _, phase in
			if phase == .background { widgetReloader.reload() }
			switch phase {
			case .active: runtime.scenePhaseChanged(.active)
			case .inactive: runtime.scenePhaseChanged(.inactive)
			case .background: runtime.scenePhaseChanged(.background)
			@unknown default: break
			}
		}
	}
}

extension RootView {
	fileprivate static func makeInvites(_ environment: AppEnvironment) -> InviteCoordinator {
		let remote = APIInviteRemote(
			baseURL: environment.baseURL, clientSource: environment.clientSource)
		return InviteCoordinator(pending: UserDefaultsPendingInviteStore()) { token in
			InviteStore(
				token: token, remote: remote,
				viewer: {
					environment.auth.session.map { InviteViewer(apiKey: $0.apiKey, email: $0.email) }
				},
				joined: { workspaceId in
					// Load the new workspace into the list first, then switch to it.
					await environment.workspaces.refresh()
					environment.auth.selectWorkspace(workspaceId)
				})
		}
	}

	@ViewBuilder
	fileprivate func firstUse(session: StoredSession, auth: AuthSession) -> some View {
		let workspaces = environment.workspaces
		FirstUseView(
			name: session.name,
			readiness: FirstUseReadiness.resolve(
				provisioningFailed: auth.workspaceProvisioningFailed,
				workspaceCount: workspaces.workspaces.count,
				isLoading: isRetryingWorkspace || workspaces.phase == .loading),
			hasWelcomeChat: welcomeChatId != nil,
			onOpenWelcome: {
				finishFirstUse(session: session)
				if let id = welcomeChatId, let ws = auth.session?.workspaceId {
					runtime.present(.chat(workspaceId: ws, id: id))
				}
			},
			onContinue: { finishFirstUse(session: session) },
			onRetry: {
				isRetryingWorkspace = true
				Task {
					await workspaces.refresh()
					isRetryingWorkspace = false
				}
			},
			// No notification step here: the system prompt waits for a moment of value, offered
			// by `NotificationPromptCoordinator` (see `AppRuntime.valueMomentSeen()`).
			onEnableNotifications: nil)
	}

	fileprivate func finishFirstUse(session: StoredSession) {
		environment.auth.firstUse.markSeen(actorId: session.actorId)
		firstUseActorId = nil
	}
}

#Preview("Signed out") { RootView(environment: .preview(signedIn: false)) }
#Preview("Signed in") { RootView(environment: .preview()) }
