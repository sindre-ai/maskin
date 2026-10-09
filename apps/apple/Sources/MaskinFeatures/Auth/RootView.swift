import MaskinCore
import MaskinUI
import SwiftUI

/// App root: login when signed out, the shell otherwise. Also drives the runtime: restores the
/// stored session, loads workspaces after sign-in, points the event stream and the notification
/// inbox at the selected workspace, and routes deep links (held until signed in).
public struct RootView: View {
	private let environment: AppEnvironment
	@Environment(\.scenePhase) private var scenePhase
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

	/// `push` is the platform's registrar (built by the app target); `onRuntimeReady` hands the
	/// app delegate the runtime's router so notification taps reach it.
	public init(
		environment: AppEnvironment, push: PushRegistrar? = nil,
		onRuntimeReady: @escaping (AppRuntime) -> Void = { _ in },
		welcomeConversationId: (@MainActor () async -> String?)? = nil
	) {
		self.environment = environment
		self.welcomeConversationId = welcomeConversationId
		self.onRuntimeReady = onRuntimeReady
		_runtime = State(initialValue: AppRuntime(environment: environment, push: push))
		_chatImages = State(
			initialValue: ChatImageLoader(
				files: APIFilesRemote(client: environment.client, credentials: environment.auth.credentialsProvider)))
		_links = State(
			initialValue: InternalLinkDirectory(
				remote: APIObjectsRemote(client: environment.client, credentials: environment.auth.credentialsProvider)))
	}

	public var body: some View {
		let auth = environment.auth
		Group {
			if let session = auth.session {
				if firstUseActorId == session.actorId {
					firstUse(session: session, auth: auth)
				} else {
					MainShell(environment: environment, runtime: runtime)
				}
			} else {
				AuthView(environment: environment)
			}
		}
		.animation(.default, value: auth.session != nil)
		.onChange(of: auth.session?.actorId, initial: true) { _, id in
			firstUseActorId = id.flatMap { auth.firstUse.isPending(actorId: $0) ? $0 : nil }
		}
		.task(id: firstUseActorId) {
			welcomeChatId = firstUseActorId == nil ? nil : await welcomeConversationId?()
		}
		.handlesDeepLinks(runtime.router) { runtime.present($0) }
		.environment(\.markdownInternalLinkHandler, { @MainActor [runtime] url in runtime.open(url) })
		.environment(\.markdownInternalLinkInfo, { @MainActor [links] url in links.info(for: url) })
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
			})
	}

	fileprivate func finishFirstUse(session: StoredSession) {
		environment.auth.firstUse.markSeen(actorId: session.actorId)
		firstUseActorId = nil
	}
}

#Preview("Signed out") { RootView(environment: .preview(signedIn: false)) }
#Preview("Signed in") { RootView(environment: .preview()) }
