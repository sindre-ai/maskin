import SwiftUI

struct TabShellView: View {
	@Environment(AuthManager.self) private var auth
	@Environment(AppModel.self) private var appModel

	var body: some View {
		TabView {
			ForYouView()
				.tabItem { Label("For you", systemImage: "list.bullet") }
				.badge(appModel.needsYouCount)

			ChatsView()
				.tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }

			ObjectsListView()
				.tabItem { Label("Objects", systemImage: "cube") }

			LoopsView()
				.tabItem { Label("Loops", systemImage: "arrow.triangle.2.circlepath") }
		}
		.tint(MaskinColor.accent)
		.task {
			guard let workspaceId = auth.workspaceId else { return }
			await appModel.loadAll(workspaceId: workspaceId)
			appModel.startRealtime(workspaceId: workspaceId)
		}
	}
}
