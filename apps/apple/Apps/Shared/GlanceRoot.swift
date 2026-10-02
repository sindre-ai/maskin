import MaskinCore
import SwiftUI

/// Root of the watchOS and tvOS apps: sign in, then a glanceable list of what needs the user.
/// Uses only MaskinCore stores (`NotificationsStore`, `WorkspaceStore`) plus MaskinDesign/MaskinUI.
struct GlanceRoot: View {
	private let environment: AppEnvironment
	@State private var store: NotificationsStore

	init(environment: AppEnvironment) {
		self.environment = environment
		_store = State(initialValue: NotificationsStore(environment: environment))
	}

	var body: some View {
		let auth = environment.auth
		Group {
			if auth.session != nil {
				GlanceInbox(environment: environment, store: store)
			} else {
				GlanceLogin(auth: auth)
			}
		}
		.task(id: auth.session?.apiKey) { await environment.workspaces.refresh() }
		.task(id: auth.credentials) {
			environment.syncEvents()
			store.activate(workspaceId: environment.workspaceId, events: environment.events)
		}
	}
}
