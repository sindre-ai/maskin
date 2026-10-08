import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The notification inbox, presented by the shell as a sheet. Owns its `NavigationStack` and a
/// Done button.
///
/// Pass a long-lived `store` (the one feeding the bell badge) so the badge and the list agree;
/// without one the screen creates its own. If a `DeepLinkRouter` is in the environment, tapping a
/// notification about an object closes the sheet and opens it.
public struct NotificationsScreen: View {
	@Environment(\.dismiss) private var dismiss
	@Environment(\.isPushedInHostStack) private var pushed
	@Environment(DeepLinkRouter.self) private var router: DeepLinkRouter?
	private let environment: AppEnvironment
	@State private var store: NotificationsStore

	public init(environment: AppEnvironment, store: NotificationsStore? = nil) {
		self.environment = environment
		_store = State(initialValue: store ?? NotificationsStore(environment: environment))
	}

	public var body: some View {
		StandaloneStack {
			NotificationsContent(store: store) { open($0) }
				.navigationTitle("Notifications")
				#if os(iOS)
					.navigationBarTitleDisplayMode(.inline)
				#endif
				.toolbar {
					if !pushed {
						ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
					}
					ToolbarItem(placement: .primaryAction) {
						Menu {
							Button {
								Task { await store.markAllRead() }
							} label: {
								Label("Mark all as read", systemImage: "checkmark.circle")
							}
							.disabled(store.unreadCount == 0)
						} label: {
							Label("More", systemImage: "ellipsis.circle")
						}
					}
				}
		}
		.task(id: environment.workspaceId) {
			store.activate(workspaceId: environment.workspaceId, events: environment.events)
		}
	}

	private func open(_ notification: AppNotification) {
		Task { await store.markRead(notification.id) }
		if let link = notification.deepLink(), let router {
			dismiss()
			router.open(link)
		}
	}
}

/// The list and its states, separated from the sheet chrome so it renders in tests and previews.
struct NotificationsContent: View {
	let store: NotificationsStore
	let onOpen: (AppNotification) -> Void

	var body: some View {
		Group {
			switch store.phase {
			case .idle, .loading:
				LoadingSkeleton(rows: 5).padding(.horizontal, MaskinSpace.s9)
					.frame(maxHeight: .infinity, alignment: .top)
					.accessibilityLabel("Loading notifications")
			case .failed(let message):
				EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load notifications", message: message) {
					Button("Try again") { Task { await store.reload() } }
						.buttonStyle(.secondaryAction)
						.frame(maxWidth: 280)
				}
			case .loaded where store.isEmpty:
				EmptyState(
					symbol: "bell.badge", title: "All caught up",
					message: "When an agent needs you or has news, it shows up here.")
			case .loaded:
				list
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.ambientBackground()
		.alert(
			"Couldn't complete that",
			isPresented: Binding(
				get: { store.actionError != nil }, set: { if !$0 { store.dismissError() } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(store.actionError ?? "")
		}
	}

	private var list: some View {
		List {
			if store.isOffline {
				OfflineBanner(message: "Can't reach Maskin. Showing what we had.")
					.listRowInsets(EdgeInsets())
					.listRowSeparator(.hidden)
			}
			ForEach(store.notifications) { n in
				NotificationRow(
					notification: n, actor: store.actor(for: n.sourceActorId),
					isBusy: store.busyIDs.contains(n.id),
					onRespond: { response in
						Task { await store.respond(to: n.id, with: response) }
					},
					onOpen: { onOpen(n) }
				)
				.swipeActions(edge: .leading, allowsFullSwipe: true) {
					if n.isUnread {
						Button {
							Task { await store.markRead(n.id) }
						} label: {
							Label("Read", systemImage: "envelope.open")
						}
						.tint(MaskinColor.ink)
					} else if n.status == .seen {
						Button {
							Task { await store.markUnread(n.id) }
						} label: {
							Label("Unread", systemImage: "envelope.badge")
						}
						.tint(MaskinColor.ink)
					}
				}
				.swipeActions(edge: .trailing, allowsFullSwipe: true) {
					Button(role: .destructive) {
						Task { await store.delete(n.id) }
					} label: {
						Label("Delete", systemImage: "trash")
					}
				}
				.contextMenu {
					if n.isUnread {
						Button("Mark as read") { Task { await store.markRead(n.id) } }
					} else if n.status == .seen {
						Button("Mark as unread") { Task { await store.markUnread(n.id) } }
					}
					Button("Delete", role: .destructive) { Task { await store.delete(n.id) } }
				}
				.listRowBackground(Color.clear)
			}
		}
		.listStyle(.plain)
		.refreshable { await store.reload() }
		// A wide window shouldn't stretch rows across a 1000pt line.
		.frame(maxWidth: 720)
	}
}
