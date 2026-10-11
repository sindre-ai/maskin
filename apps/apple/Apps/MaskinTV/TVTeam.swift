import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Team on the big screen, as a split view: the rooms on the left (focus moves a row at a time) and
/// the focused room's live thread on the right with Dictate, Type and quick replies inline. Right
/// from a room enters the composer, left returns to the list.
struct TVTeam: View {
	let environment: AppEnvironment
	@State private var store: ConversationsStore?
	@FocusState private var focusedRoom: String?
	/// The room shown on the right. Follows focus after a short pause so skimming the list doesn't
	/// open a thread per row.
	@State private var shownRoom: String?

	private var rooms: [ConversationSummary] { WatchChat.glance(store?.conversations ?? [], limit: 20) }

	var body: some View {
		VStack(alignment: .leading, spacing: 32) {
			Text("Team").font(.system(size: 64, weight: .bold))
			if let store, rooms.isEmpty, store.phase == .loaded {
				EmptyState(symbol: "bubble.left", title: "No conversations", message: "Start one on your iPhone.")
			} else if store == nil || rooms.isEmpty {
				ProgressView().frame(maxWidth: .infinity, minHeight: 300)
			} else {
				HStack(alignment: .top, spacing: 56) {
					ScrollView {
						LazyVStack(spacing: 20) {
							ForEach(rooms) { room in
								Button { shownRoom = room.id } label: {
									TVRoomRow(room: room, selected: room.id == shownRoom)
								}
								.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 28))
								.focused($focusedRoom, equals: room.id)
							}
						}
						.padding(.vertical, 24)
					}
					.scrollClipDisabled()
					.frame(width: 700)
					.focusSection()
					Group {
						if let shownRoom {
							TVThread(environment: environment, conversationID: shownRoom, embedded: true)
								.id(shownRoom)
						}
					}
					.frame(maxWidth: .infinity, maxHeight: .infinity)
					.focusSection()
				}
			}
		}
		.padding(.horizontal, 96)
		.padding(.top, 56)
		.padding(.bottom, 48)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.ignoresSafeArea()
		.task(id: focusedRoom) {
			guard let focusedRoom, focusedRoom != shownRoom else { return }
			try? await Task.sleep(for: .milliseconds(350))
			if !Task.isCancelled { shownRoom = focusedRoom }
		}
		.task(id: rooms.first?.id) {
			if shownRoom == nil { shownRoom = rooms.first?.id }
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
	let selected: Bool

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
		.background(selected ? MaskinSurface.fillStrong : MaskinSurface.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
	}
}
