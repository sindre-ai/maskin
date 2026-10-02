import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What needs the user right now: unread notifications and open decisions, newest first.
struct GlanceInbox: View {
	let environment: AppEnvironment
	let store: NotificationsStore

	private var items: [AppNotification] {
		store.notifications.filter { $0.isUnread || $0.canRespond }
	}

	var body: some View {
		NavigationStack {
			List {
				if store.phase == .loading && store.isEmpty {
					LoadingSkeleton(rows: 3)
				} else if case .failed(let message) = store.phase, store.isEmpty {
					EmptyState(symbol: "wifi.exclamationmark", title: "Can't load", message: message) {
						Button("Retry") { Task { await store.reload() } }
					}
				} else if items.isEmpty {
					EmptyState(symbol: "checkmark.circle", title: "All caught up", message: "Nothing needs you.")
				} else {
					ForEach(items) { n in
						NavigationLink(value: n.id) { GlanceRow(notification: n) }
					}
				}
				Section(environment.workspaces.selected?.name ?? "Account") {
					Button("Sign out", role: .destructive) { environment.signOut() }
				}
			}
			.navigationTitle(title)
			.navigationDestination(for: String.self) { id in
				GlanceDetail(store: store, id: id)
			}
		}
	}

	private var title: String {
		let n = items.count
		return n == 0 ? "For you" : "For you · \(n)"
	}
}

struct GlanceRow: View {
	let notification: AppNotification

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack(spacing: MaskinSpace.s3) {
				Image(systemName: notification.kind.symbol)
					.foregroundStyle(notification.kind.tint)
				RelativeTime(notification.createdAt)
					.font(.caption2)
					.foregroundStyle(MaskinColor.ink4)
			}
			Text(notification.title)
				.font(.headline)
				.lineLimit(3)
		}
		.accessibilityElement(children: .combine)
	}
}

/// One notification: its text and, for a decision, a button per option. Answering is the same
/// optimistic `NotificationsStore.respond` the phone uses.
struct GlanceDetail: View {
	let store: NotificationsStore
	let id: String
	@Environment(\.dismiss) private var dismiss

	@ViewBuilder
	private func answerButton(_ action: AppNotification.Action, for n: AppNotification) -> some View {
		let button = Button(action.label) {
			Task {
				await store.respond(to: n.id, with: action.response)
				dismiss()
			}
		}
		if action.style == .primary {
			button.buttonStyle(PrimaryActionButtonStyle())
		} else {
			button.buttonStyle(SecondaryActionButtonStyle())
		}
	}

	var body: some View {
		if let n = store.notifications.first(where: { $0.id == id }) {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					Text(n.title).font(.headline)
					if let content = n.content, !content.isEmpty {
						Text(content).font(.footnote).foregroundStyle(MaskinColor.ink3)
					}
					if n.canRespond {
						ForEach(n.actions) { action in
							answerButton(action, for: n)
						}
						if n.wantsText && n.actions.isEmpty {
							Text("Reply on your iPhone.").font(.footnote).foregroundStyle(MaskinColor.ink4)
						}
					}
					if let error = store.actionError {
						Text(error).font(.footnote).foregroundStyle(MaskinColor.danger)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.task { await store.markRead(id) }
		} else {
			EmptyState(symbol: "checkmark.circle", title: "Done")
		}
	}
}

extension AppNotification.Kind {
	var symbol: String {
		switch self {
		case .needsInput: "questionmark.bubble.fill"
		case .recommendation: "lightbulb.fill"
		case .goodNews: "checkmark.seal.fill"
		case .alert: "exclamationmark.triangle.fill"
		case .other: "bell.fill"
		}
	}

	var tint: Color {
		switch self {
		case .needsInput: MaskinColor.accent
		case .recommendation: MaskinColor.warning
		case .goodNews: MaskinColor.success
		case .alert: MaskinColor.danger
		case .other: MaskinColor.ink4
		}
	}
}
