import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What needs the user right now: open decisions and unread mentions from For You, newest first.
struct GlanceInbox<Extra: View>: View {
	let environment: AppEnvironment
	let store: ForYouStore?
	@ViewBuilder let extra: () -> Extra

	private var items: [FeedEntry] {
		(store?.entries ?? []).filter { $0.bucket == .needs || $0.bucket == .fyi }
	}

	var body: some View {
		NavigationStack {
			List {
				if let store {
					feed(store)
				} else {
					LoadingSkeleton(rows: 3)
				}
				extra()
				Section(environment.workspaces.selected?.name ?? "Account") {
					Button("Sign out", role: .destructive) { environment.signOut() }
				}
			}
			.navigationTitle(title)
			.navigationDestination(for: String.self) { id in
				if let store { GlanceDetail(store: store, id: id) }
			}
		}
	}

	@ViewBuilder
	private func feed(_ store: ForYouStore) -> some View {
		if store.phase == .loading && store.cards.isEmpty {
			LoadingSkeleton(rows: 3)
		} else if case .failed(let message) = store.phase, store.cards.isEmpty {
			EmptyState(symbol: "wifi.exclamationmark", title: "Can't load", message: message) {
				Button("Retry") { Task { await store.load() } }
			}
		} else if items.isEmpty {
			EmptyState(symbol: "checkmark.circle", title: "All caught up", message: "Nothing needs you.")
		} else {
			ForEach(items) { entry in
				NavigationLink(value: entry.id) { GlanceRow(card: entry.card) }
			}
		}
	}

	private var title: String {
		let n = items.count
		return n == 0 ? "For you" : "For you · \(n)"
	}
}

struct GlanceRow: View {
	let card: ForYouCard

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack(spacing: MaskinSpace.s3) {
				Image(systemName: card.kind.symbol)
					.foregroundStyle(card.kind.tint)
				if let when = card.latestActivityAt {
					RelativeTime(when)
						.font(.caption2)
						.foregroundStyle(MaskinColor.ink4)
				}
			}
			Text(card.headline)
				.font(.headline)
				.lineLimit(3)
		}
		.accessibilityElement(children: .combine)
	}
}

/// One card: its text and, for a decision, a button per option and a text reply. Answering is the
/// same optimistic `ForYouStore.choose`/`reply` the phone uses. A destructive option asks first, as
/// on the phone: one stray tap on a wrist must not send something that can't be undone.
struct GlanceDetail: View {
	let store: ForYouStore
	let id: String
	@Environment(\.dismiss) private var dismiss
	@State private var pendingDestructive: DecisionOption?
	@State private var reply = ""

	private var card: ForYouCard? { store.entries.first { $0.id == id }?.card }

	private func choose(_ option: DecisionOption, on card: ForYouCard) {
		store.choose(option, on: card)
		dismiss()
	}

	private func send(_ text: String, on card: ForYouCard) {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }
		store.reply(trimmed, on: card)
		dismiss()
	}

	@ViewBuilder
	private func optionButton(_ option: DecisionOption, on card: ForYouCard) -> some View {
		let button = Button(option.label) {
			if option.destructive { pendingDestructive = option } else { choose(option, on: card) }
		}
		if option.recommended {
			button.buttonStyle(PrimaryActionButtonStyle())
		} else if option.destructive {
			button.buttonStyle(SecondaryActionButtonStyle()).tint(MaskinColor.danger)
		} else {
			button.buttonStyle(SecondaryActionButtonStyle())
		}
	}

	var body: some View {
		if let card {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s7) {
					Text(card.headline).font(.headline)
					if let summary = card.decision?.summary, !summary.isEmpty {
						Text(summary).font(.footnote).foregroundStyle(MaskinColor.ink3)
					} else if !card.body.isEmpty {
						Text(card.body).font(.footnote).foregroundStyle(MaskinColor.ink3)
					}
					if let ask = card.decision?.ask, !ask.isEmpty {
						Text(ask).font(.footnote.weight(.semibold))
					}
					if let options = card.decision?.options {
						ForEach(options) { optionButton($0, on: card) }
					}
					// Dictation, scribble or keyboard, whichever the device offers.
					TextField(card.kind == .decision ? "Or answer in words" : "Reply", text: $reply)
						.submitLabel(.send)
						.onSubmit { send(reply, on: card) }
					Button("Send reply") { send(reply, on: card) }
						.buttonStyle(PrimaryActionButtonStyle())
						.disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
					if card.kind == .thread {
						Button("Mark read") {
							store.dismiss(card)
							dismiss()
						}
						.buttonStyle(SecondaryActionButtonStyle())
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.confirmationDialog(
				"Are you sure?",
				isPresented: Binding(
					get: { pendingDestructive != nil }, set: { if !$0 { pendingDestructive = nil } }),
				titleVisibility: .visible, presenting: pendingDestructive
			) { option in
				Button("Yes, \(option.label)", role: .destructive) { choose(option, on: card) }
				Button("Cancel", role: .cancel) {}
			}
		} else {
			EmptyState(symbol: "checkmark.circle", title: "Done")
		}
	}
}

extension ForYouCard.Kind {
	var symbol: String {
		switch self {
		case .decision: "questionmark.bubble.fill"
		case .thread: "text.bubble.fill"
		}
	}

	var tint: Color {
		switch self {
		case .decision: MaskinColor.accent
		case .thread: MaskinColor.ink4
		}
	}
}
