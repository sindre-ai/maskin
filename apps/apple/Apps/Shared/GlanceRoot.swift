import MaskinCore
import SwiftUI

/// Root of the watchOS and tvOS apps: sign in, then whatever `content` builds from the signed-in
/// actor's For You runtime (nil until it exists). One `ForYouRuntime` per actor, built here and not in
/// `init`, so a re-render never starts a second listener.
struct GlanceRoot<Content: View>: View {
	private let environment: AppEnvironment
	private let content: (ForYouRuntime?) -> Content
	private let signedOut: (AuthSession) -> AnyView
	@State private var forYou: ForYouRuntime?

	/// `signedOut` is what shows before sign-in; the default is the email-and-password form (watch).
	init(
		environment: AppEnvironment,
		signedOut: @escaping (AuthSession) -> AnyView = { AnyView(GlanceLogin(auth: $0)) },
		@ViewBuilder content: @escaping (ForYouRuntime?) -> Content
	) {
		self.environment = environment
		self.signedOut = signedOut
		self.content = content
	}

	var body: some View {
		let auth = environment.auth
		Group {
			if auth.session != nil {
				content(forYou)
			} else {
				signedOut(auth)
			}
		}
		.task(id: auth.session?.apiKey) { await environment.workspaces.refresh() }
		.task(id: auth.credentials) {
			environment.syncEvents()
			forYou?.stop()
			guard auth.session != nil else {
				forYou = nil
				return
			}
			let runtime = ForYouRuntime.make(environment: environment)
			forYou = runtime
			await runtime.store.load()
		}
	}
}
