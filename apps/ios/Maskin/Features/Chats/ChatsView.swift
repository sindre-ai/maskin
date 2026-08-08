import SwiftUI

/// Chats — the full unread feed rendered as threads (see plan §5). For You is the same
/// data filtered to decision-shaped cards; Chats shows everything with unread activity.
struct ChatsView: View {
	@Environment(AuthManager.self) private var auth
	@Environment(AppModel.self) private var appModel

	private var sortedItems: [UnreadItem] {
		appModel.unreadItems.sorted { ($0.latestActivityAt ?? "") > ($1.latestActivityAt ?? "") }
	}

	var body: some View {
		NavigationStack {
			List {
				ForEach(sortedItems) { item in
					if let object = item.object {
						NavigationLink(value: object.id) {
							ChatRow(item: item, object: object)
						}
					}
				}
			}
			.listStyle(.plain)
			.background(MaskinColor.surface)
			.navigationTitle("Chats")
			.navigationDestination(for: String.self) { objectId in
				ObjectDetailView(objectId: objectId)
			}
			.overlay {
				if sortedItems.isEmpty && !appModel.isLoadingUnread {
					ContentUnavailableView("No chats yet", systemImage: "bubble.left.and.bubble.right")
				}
			}
			.refreshable {
				if let workspaceId = auth.workspaceId {
					await appModel.refreshUnread(workspaceId: workspaceId)
				}
			}
		}
	}
}

private struct ChatRow: View {
	@Environment(AppModel.self) private var appModel
	let item: UnreadItem
	let object: MaskinObject

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpacing.s3) {
			let creatorId = object.driver ?? object.createdBy
			ActorAvatar(name: appModel.actor(creatorId)?.name ?? "Agent", id: creatorId, size: 32)
			VStack(alignment: .leading, spacing: MaskinSpacing.s1) {
				HStack {
					Text(object.title ?? "Untitled")
						.font(MaskinFont.md.weight(.semibold))
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					Spacer()
					if item.unreadCount > 0 {
						Circle().fill(MaskinColor.accent).frame(width: 8, height: 8)
					}
				}
				if let content = object.content, !content.isEmpty {
					Text(content).font(MaskinFont.sm).foregroundStyle(MaskinColor.ink2).lineLimit(2)
				}
				HStack(spacing: MaskinSpacing.s2) {
					ObjectTypeTag(type: object.type)
					StatusPill(text: object.status.replacingOccurrences(of: "_", with: " "))
				}
			}
		}
		.padding(.vertical, MaskinSpacing.s1)
	}
}
