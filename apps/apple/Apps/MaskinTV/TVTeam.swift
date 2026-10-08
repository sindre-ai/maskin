import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Team on the big screen: the conversations, unread first. Selecting one opens the thread.
struct TVTeam: View {
	let environment: AppEnvironment
	@State private var store: ConversationsStore?

	private var rooms: [ConversationSummary] { WatchChat.glance(store?.conversations ?? [], limit: 20) }

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 32) {
					Text("Team").font(.system(size: 64, weight: .bold))
					if let store, rooms.isEmpty, store.phase == .loaded {
						EmptyState(symbol: "bubble.left", title: "No conversations", message: "Start one on your iPhone.")
					} else if store == nil || rooms.isEmpty {
						ProgressView().frame(maxWidth: .infinity, minHeight: 300)
					} else {
						LazyVStack(spacing: 20) {
							ForEach(rooms) { room in
								NavigationLink(value: room.id) { TVRoomRow(room: room) }
									.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 28))
							}
						}
						.padding(.vertical, 24)
					}
				}
				.padding(.horizontal, 96)
				.padding(.top, 56)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.navigationDestination(for: String.self) { id in
				TVThread(environment: environment, conversationID: id)
			}
		}
		.task(id: environment.workspaceId) { await start() }
		.onDisappear { store?.stop() }
	}

	private func start() async {
		store?.stop()
		guard environment.auth.session != nil, let workspaceID = environment.workspaceId else {
			store = nil
			return
		}
		let next = ConversationsStore(
			api: APIChatsSource(client: environment.client, workspaceID: workspaceID),
			events: environment.events, cache: environment.snapshotCache)
		store = next
		await next.start()
	}
}

private struct TVRoomRow: View {
	let room: ConversationSummary

	var body: some View {
		HStack(spacing: 28) {
			ActorAvatar(
				name: room.participants.first?.name ?? room.title,
				kind: room.participants.first?.kind == .agent ? .agent : .human, size: 64)
			VStack(alignment: .leading, spacing: 6) {
				Text(room.title).font(.system(size: 32, weight: .semibold)).lineLimit(1)
				if let snippet = room.snippet, !snippet.isEmpty {
					Text(snippet).font(.system(size: 26)).foregroundStyle(MaskinColor.ink4).lineLimit(1)
				}
			}
			Spacer(minLength: 0)
			if let when = room.lastMessageAt {
				RelativeTime(when, style: .compact).font(.system(size: 24)).foregroundStyle(MaskinColor.ink4)
			}
			if room.unreadCount > 0 {
				Text("\(room.unreadCount)")
					.font(.system(size: 24, weight: .bold))
					.padding(.horizontal, 16).frame(minWidth: 44, minHeight: 44)
					.background(MaskinSurface.inverse, in: Capsule())
					.foregroundStyle(MaskinSurface.onInverse)
			}
		}
		.padding(.horizontal, 32)
		.frame(maxWidth: .infinity, minHeight: 104, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
	}
}
