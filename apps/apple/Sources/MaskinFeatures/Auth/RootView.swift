import MaskinCore
import SwiftUI

/// App root: login when signed out, the shell otherwise. Also drives the runtime: restores the
/// stored session, loads workspaces after sign-in, points the event stream and the notification
/// inbox at the selected workspace, and routes deep links (held until signed in).
public struct RootView: View {
	private let environment: AppEnvironment
	@Environment(\.scenePhase) private var scenePhase
	@State private var runtime: AppRuntime
	private let onRuntimeReady: (AppRuntime) -> Void

	/// `push` is the platform's registrar (built by the app target); `onRuntimeReady` hands the
	/// app delegate the runtime's router so notification taps reach it.
	public init(
		environment: AppEnvironment, push: PushRegistrar? = nil,
		onRuntimeReady: @escaping (AppRuntime) -> Void = { _ in }
	) {
		self.environment = environment
		self.onRuntimeReady = onRuntimeReady
		_runtime = State(initialValue: AppRuntime(environment: environment, push: push))
	}

	public var body: some View {
		let auth = environment.auth
		Group {
			if auth.session != nil {
				MainShell(environment: environment, runtime: runtime)
			} else {
				LoginView(environment: environment)
			}
		}
		.animation(.default, value: auth.session != nil)
		.handlesDeepLinks(runtime.router) { runtime.present($0) }
		.task { onRuntimeReady(runtime) }
		.task(id: auth.session?.apiKey) { await environment.workspaces.refresh() }
		.task(id: auth.credentials) { environment.syncEvents() }
		.task(id: runtime.syncKey) { runtime.sync() }
		.task(id: auth.session?.actorId) { await runtime.actorChanged(auth.session?.actorId) }
		.onChange(of: runtime.notifications.unreadCount, initial: true) { runtime.updateBadge() }
		.onChange(of: scenePhase) { _, phase in
			switch phase {
			case .active: runtime.scenePhaseChanged(.active)
			case .inactive: runtime.scenePhaseChanged(.inactive)
			case .background: runtime.scenePhaseChanged(.background)
			@unknown default: break
			}
		}
	}
}

#Preview("Signed out") { RootView(environment: .preview(signedIn: false)) }
#Preview("Signed in") { RootView(environment: .preview()) }
