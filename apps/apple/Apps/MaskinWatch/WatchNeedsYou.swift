import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Decisions waiting on the wearer, one card per page. One tap decides (optimistic, held for the
/// Undo window); an option that can't be taken back asks first; a card with more than two options
/// shows the recommended one and hands the rest to the iPhone.
struct WatchNeedsYou: View {
	let store: ForYouStore?
	let workspaceId: String?

	private var entries: [FeedEntry] {
		(store?.entries ?? []).filter { $0.section == .needs }
	}

	var body: some View {
		NavigationStack {
			Group {
				if let store, !entries.isEmpty {
					TabView {
						ForEach(entries) { entry in
							WatchDecisionPage(store: store, entry: entry, workspaceId: workspaceId)
						}
					}
					.tabViewStyle(.page)
				} else if let store, store.phase == .loading, store.cards.isEmpty {
					ProgressView()
				} else if let store, case .failed(let message) = store.phase, store.cards.isEmpty {
					EmptyState(symbol: "wifi.exclamationmark", title: "Can't load", message: message) {
						Button("Retry") { Task { await store.load() } }
					}
				} else {
					EmptyState(symbol: "checkmark.circle", title: "You're caught up")
				}
			}
			.navigationTitle(title)
		}
	}

	private var title: String {
		entries.isEmpty ? "Needs you" : "Needs you · \(entries.count)"
	}
}

private struct WatchDecisionPage: View {
	let store: ForYouStore
	let entry: FeedEntry
	let workspaceId: String?
	@State private var confirming: DecisionOption?

	private var card: ForYouCard { entry.card }

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				header
				if let record = entry.record, !isFailed(record) {
					receipt(record)
				} else {
					Text(card.decision?.ask.nonEmpty ?? card.headline)
						.font(.system(size: 16))
						.lineLimit(4)
					if let context = card.contextTitle {
						Text(context).font(.caption2).foregroundStyle(MaskinColor.ink4).underline()
					}
					options
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		// "More on iPhone": the phone picks up this card from the app switcher.
		.userActivity(HandoffActivity.type, isActive: workspaceId != nil) { activity in
			guard let workspaceId else { return }
			activity.isEligibleForHandoff = true
			activity.title = card.headline
			activity.userInfo = HandoffActivity.userInfo(workspaceId: workspaceId, objectId: card.id)
		}
		.sheet(item: $confirming) { option in
			WatchConfirm(option: option) {
				store.choose(option, on: card)
				confirming = nil
			} cancel: {
				confirming = nil
			}
		}
	}

	private var header: some View {
		HStack(spacing: MaskinSpace.s3) {
			Text(initials)
				.font(.system(size: 11, weight: .bold))
				.frame(width: 22, height: 22)
				.background(MaskinSurface.fillStrong, in: RoundedRectangle(cornerRadius: 7))
			Text(store.senderName(of: card) ?? "Chief of Staff")
				.font(.system(size: 15, weight: .semibold)).lineLimit(1)
			Spacer(minLength: 0)
			if let when = card.latestActivityAt {
				RelativeTime(when).font(.caption2.monospaced()).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	private var initials: String {
		let words = (store.senderName(of: card) ?? "Chief of Staff").split(separator: " ")
		return String(words.prefix(2).compactMap(\.first)).uppercased()
	}

	@ViewBuilder
	private var options: some View {
		let all = card.decision?.options ?? []
		let shown = WatchDecisionOptions.visible(all)
		ForEach(shown) { option in
			WatchOptionButton(option: option) {
				if option.destructive { confirming = option } else { store.choose(option, on: card) }
			}
		}
		if all.count > shown.count || card.kind == .thread || all.isEmpty {
			Label("More on iPhone", systemImage: "iphone")
				.font(.caption2).foregroundStyle(MaskinColor.ink4)
		}
	}

	private func receipt(_ record: DecisionRecord) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Image(systemName: "checkmark")
				.font(.system(size: 18, weight: .bold))
				.frame(width: 44, height: 44)
				.background(MaskinSurface.inverse, in: Circle())
				.foregroundStyle(MaskinSurface.onInverse)
			Text(receiptTitle(record)).font(.headline)
			switch record.phase {
			case .held:
				Text("Undo any time in the next hour.").font(.caption2).foregroundStyle(MaskinColor.ink4)
				Button("Undo") { _ = store.undo(card) }.buttonStyle(SecondaryActionButtonStyle())
			case .queued:
				Text("Queued, sends when you're back.").font(.caption2).foregroundStyle(MaskinColor.ink4)
			default:
				EmptyView()
			}
		}
	}

	private func receiptTitle(_ record: DecisionRecord) -> String {
		switch record.kind {
		case .option(let label): "Sent \(label)"
		case .reply: "Sent"
		case .dismissed: "Marked read"
		}
	}

	/// A rejected decision rolls the card back to how it was, options and all.
	private func isFailed(_ record: DecisionRecord) -> Bool {
		if case .failed = record.phase { return true }
		return false
	}
}

private struct WatchConfirm: View {
	let option: DecisionOption
	let confirm: () -> Void
	let cancel: () -> Void

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				Text(option.label).font(.headline)
				ForEach(option.consequences, id: \.self) { line in
					Text(line).font(.footnote).foregroundStyle(MaskinColor.ink3)
				}
				Text("This can't be undone.").font(.footnote.weight(.semibold))
				Button("Confirm", role: .destructive, action: confirm)
					.buttonStyle(SecondaryActionButtonStyle()).tint(MaskinColor.danger)
				Button("Cancel", action: cancel).buttonStyle(SecondaryActionButtonStyle())
			}
		}
	}
}

/// A full-width capsule: the recommended option in the primary style, the rest quieter.
private struct WatchOptionButton: View {
	let option: DecisionOption
	let action: () -> Void

	var body: some View {
		if option.recommended {
			Button(option.label, action: action).buttonStyle(PrimaryActionButtonStyle())
		} else {
			Button(option.label, action: action).buttonStyle(SecondaryActionButtonStyle())
		}
	}
}

private extension String {
	var nonEmpty: String? { isEmpty ? nil : self }
}
