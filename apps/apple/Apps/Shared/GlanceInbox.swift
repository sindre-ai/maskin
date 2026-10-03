import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What needs the user right now: unread notifications and open decisions, newest first.
struct GlanceInbox<Extra: View>: View {
	let environment: AppEnvironment
	let store: NotificationsStore
	@ViewBuilder let extra: () -> Extra

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
				extra()
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

/// One notification: its text and, for a decision, a button per option and (when the agent asked
/// for words) a text reply. Answering is the same optimistic `NotificationsStore.respond` the phone
/// uses. A destructive option asks first, as on the phone: one stray tap on a wrist must not send
/// something that can't be undone.
struct GlanceDetail: View {
	let store: NotificationsStore
	let id: String
	@Environment(\.dismiss) private var dismiss
	@State private var pendingDestructive: AppNotification.Action?
	@State private var reply = ""

	/// Sends `response` and leaves, but only when it went through: a refusal reverts the row and
	/// leaves `actionError`, which this screen must still be showing.
	private func send(_ response: JSONValue, for n: AppNotification) {
		Task {
			await store.respond(to: n.id, with: response)
			if store.actionError == nil { dismiss() }
		}
	}

	@ViewBuilder
	private func answerButton(_ action: AppNotification.Action, for n: AppNotification) -> some View {
		let button = Button(action.label) {
			if action.style == .destructive {
				pendingDestructive = action
			} else {
				send(action.response, for: n)
			}
		}
		switch action.style {
		case .primary: button.buttonStyle(PrimaryActionButtonStyle())
		case .secondary: button.buttonStyle(SecondaryActionButtonStyle())
		case .destructive: button.buttonStyle(SecondaryActionButtonStyle()).tint(MaskinColor.danger)
		}
	}

	private func trimmedReply() -> String { reply.trimmingCharacters(in: .whitespacesAndNewlines) }

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
						if n.wantsText {
							// Dictation, scribble or keyboard, whichever the watch offers.
							TextField(n.placeholder ?? "Reply", text: $reply)
								.submitLabel(.send)
								.onSubmit { if !trimmedReply().isEmpty { send(.string(trimmedReply()), for: n) } }
							Button("Send reply") { send(.string(trimmedReply()), for: n) }
								.buttonStyle(PrimaryActionButtonStyle())
								.disabled(trimmedReply().isEmpty)
						}
					}
					if let error = store.actionError {
						Text(error).font(.footnote).foregroundStyle(MaskinColor.danger)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.task { await store.markRead(id) }
			.confirmationDialog(
				"Are you sure?",
				isPresented: Binding(
					get: { pendingDestructive != nil }, set: { if !$0 { pendingDestructive = nil } }),
				titleVisibility: .visible, presenting: pendingDestructive
			) { action in
				Button("Yes, \(action.label)", role: .destructive) { send(action.response, for: n) }
				Button("Cancel", role: .cancel) {}
			}
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
