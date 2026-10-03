import MaskinCore
import SwiftUI

/// Root of the watchOS and tvOS apps: sign in, then a glanceable list of what needs the user.
/// Uses only MaskinCore stores (`NotificationsStore`, `WorkspaceStore`) plus MaskinDesign/MaskinUI.
struct GlanceRoot<Extra: View>: View {
	private let environment: AppEnvironment
	private let extra: Extra
	@State private var store: NotificationsStore

	/// `extra` is an optional section shown under the inbox (the watch adds Chats there).
	init(environment: AppEnvironment, @ViewBuilder extra: () -> Extra) {
		self.environment = environment
		self.extra = extra()
		_store = State(initialValue: NotificationsStore(environment: environment))
	}

	var body: some View {
		let auth = environment.auth
		Group {
			if auth.session != nil {
				GlanceInbox(environment: environment, store: store) { extra }
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

extension GlanceRoot where Extra == EmptyView {
	init(environment: AppEnvironment) { self.init(environment: environment) { EmptyView() } }
}
