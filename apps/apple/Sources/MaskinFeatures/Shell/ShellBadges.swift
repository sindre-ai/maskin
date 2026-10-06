import MaskinAPI
import MaskinCore
import Observation

/// The numbers on the tab bar. For you shows the open decisions (read from the For you store);
/// Chats shows how many chats are unread, kept live by its own list subscription so the badge is
/// right before the Chats tab has ever been opened.
@MainActor
@Observable
final class ShellBadges {
	private var chats: ConversationsStore?
	@ObservationIgnored private var workspaceID: String?

	var unreadChats: Int { chats?.conversations.unreadChatCount ?? 0 }

	func start(environment: AppEnvironment) async {
		guard let workspaceID = environment.workspaceId else {
			stop()
			return
		}
		guard workspaceID != self.workspaceID else { return }
		stop()
		self.workspaceID = workspaceID
		let store = ConversationsStore(
			api: APIChatsSource(client: environment.client, workspaceID: workspaceID),
			events: environment.events, cache: environment.snapshotCache)
		chats = store
		await store.start()
	}

	func stop() {
		chats?.stop()
		chats = nil
		workspaceID = nil
	}
}
