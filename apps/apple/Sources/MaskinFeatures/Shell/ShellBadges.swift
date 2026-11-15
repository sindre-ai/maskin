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
	/// Keeps the disk copy of the chats most likely to be opened next fresh.
	@ObservationIgnored private var prefetcher: ThreadPrefetcher?
	@ObservationIgnored private var workspaceID: String?

	/// With sections on the badge is what waits on you (mentions plus open cards), not how many chats have news.
	var unreadChats: Int {
		guard let chats else { return 0 }
		return chats.sectionsEnabled ? chats.conversations.waitingBadgeTotal : chats.conversations.unreadChatCount
	}

	func start(environment: AppEnvironment) async {
		guard let workspaceID = environment.workspaceId else {
			stop()
			return
		}
		guard workspaceID != self.workspaceID else { return }
		stop()
		self.workspaceID = workspaceID
		let source = APIChatsSource(client: environment.client, workspaceID: workspaceID)
		let store = ConversationsStore(
			api: source, events: environment.events, cache: environment.snapshotCache)
		let prefetcher = ThreadPrefetcher(api: source, cache: environment.snapshotCache)
		store.onListLoaded = { [weak prefetcher] in prefetcher?.listChanged($0) }
		self.prefetcher = prefetcher
		chats = store
		await store.start()
	}

	func stop() {
		chats?.stop()
		chats = nil
		prefetcher?.cancelAll()
		prefetcher = nil
		workspaceID = nil
	}
}
