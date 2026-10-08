import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Decisions waiting on the wearer, one card per page. One tap decides (optimistic, held for the
/// Undo window). Every option the iPhone card has is here, in order, scrolling with the Digital
/// Crown; one that can't be taken back asks first, and Hold asks why.
struct WatchNeedsYou: View {
	let store: ForYouStore?
	let workspaceId: String?

	private var entries: [FeedEntry] {
		(store?.entries ?? []).filter { $0.section == .needs }
	}

	var body: some View {
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
		.containerBackground(for: .tabView) { WatchBackdrop() }
	}
}

private struct WatchDecisionPage: View {
	let store: ForYouStore
	let entry: FeedEntry
	let workspaceId: String?
	@State private var confirming: DecisionOption?
	@State private var holding: DecisionOption?

	private var card: ForYouCard { entry.card }

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 10) {
				header
				if let record = entry.record, !isFailed(record) {
					receipt(record)
				} else {
					Text(card.decision?.summary.nonEmpty ?? card.headline)
						.font(WatchType.body())
						.lineSpacing(3)
						.lineLimit(4)
						.foregroundStyle(MaskinColor.ink)
					if let ask = card.decision?.ask.nonEmpty {
						Text(ask).font(WatchType.question()).foregroundStyle(MaskinColor.ink3)
					}
					ForEach(card.decision?.options ?? []) { option in
						WatchOptionButton(option: option) { choose(option) }
					}
					Label("Open on iPhone", systemImage: "iphone")
						.font(WatchType.caption())
						.foregroundStyle(MaskinColor.ink4)
						.padding(.top, 2)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, 2)
		}
		// "Open on iPhone": the phone picks up this card from the app switcher.
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
		.sheet(item: $holding) { option in
			WatchHoldReason { reason in
				store.choose(option, note: reason, on: card)
				holding = nil
			}
		}
	}

	private func choose(_ option: DecisionOption) {
		if option.label.caseInsensitiveCompare("Hold") == .orderedSame {
			holding = option
		} else if option.destructive {
			confirming = option
		} else {
			store.choose(option, on: card)
		}
	}

	private var header: some View {
		HStack(spacing: 8) {
			WatchTile(name: sender)
			Text(sender).font(WatchType.name()).foregroundStyle(MaskinColor.ink).lineLimit(1)
			Spacer(minLength: 0)
			if let when = card.latestActivityAt {
				Text(when.formatted(date: .omitted, time: .shortened))
					.font(WatchType.mono()).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	private var sender: String { store.senderName(of: card) ?? "Chief of Staff" }

	private func receipt(_ record: DecisionRecord) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			Image(systemName: "checkmark")
				.font(.system(size: 18, weight: .bold))
				.frame(width: 44, height: 44)
				.background(MaskinSurface.inverse, in: Circle())
				.foregroundStyle(MaskinSurface.onInverse)
			Text(receiptTitle(record)).font(WatchType.question()).foregroundStyle(MaskinColor.ink)
			switch record.phase {
			case .held:
				Text("Undo any time in the next hour.").font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
				Button("Undo") { _ = store.undo(card) }.buttonStyle(SecondaryActionButtonStyle())
			case .queued:
				Text("Queued, sends when you're back.").font(WatchType.caption()).foregroundStyle(MaskinColor.sigHi)
			default:
				EmptyView()
			}
		}
	}

	private func receiptTitle(_ record: DecisionRecord) -> String {
		switch record.kind {
		case .option(let label): label.caseInsensitiveCompare("Hold") == .orderedSame ? "Held" : label
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

/// A full-width capsule, 44 pt tall: the recommended option in the light fill with ink text, the
/// rest on glass. Actions are ink; nothing here is a colour.
private struct WatchOptionButton: View {
	let option: DecisionOption
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Text(option.label)
				.font(MaskinTypeface.sans(16, weight: option.recommended ? .bold : .semibold, relativeTo: .body))
				.lineLimit(2)
				.multilineTextAlignment(.center)
				.foregroundStyle(option.recommended ? MaskinSurface.onInverse : MaskinColor.ink)
				.frame(maxWidth: .infinity, minHeight: 44)
				.padding(.horizontal, 12)
				.background(
					option.recommended ? AnyShapeStyle(MaskinSurface.inverse) : AnyShapeStyle(MaskinSurface.fillStrong),
					in: Capsule())
		}
		.buttonStyle(.plain)
	}
}

/// Hold asks why, as the iPhone does: two presets, dictation, or skip.
private struct WatchHoldReason: View {
	let decide: (String?) -> Void
	@State private var dictated = ""
	private let presets = ["Need more time", "Wrong audience"]

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 8) {
				Text("Why are you holding it?").font(WatchType.question()).foregroundStyle(MaskinColor.ink)
				ForEach(presets, id: \.self) { reason in
					Button { decide(reason) } label: { capsule(reason) }.buttonStyle(.plain)
				}
				TextField("Dictate", text: $dictated)
					.submitLabel(.done)
					.onSubmit { decide(dictated.isEmpty ? nil : dictated) }
				Button { decide(nil) } label: {
					Text("Skip").font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
						.frame(maxWidth: .infinity, minHeight: 44)
				}
				.buttonStyle(.plain)
			}
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
	}

	private func capsule(_ title: String) -> some View {
		Text(title)
			.font(MaskinTypeface.sans(16, weight: .semibold, relativeTo: .body))
			.foregroundStyle(MaskinColor.ink)
			.frame(maxWidth: .infinity, minHeight: 44)
			.background(MaskinSurface.fillStrong, in: Capsule())
	}
}

private struct WatchConfirm: View {
	let option: DecisionOption
	let confirm: () -> Void
	let cancel: () -> Void

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 8) {
				Text(option.label).font(WatchType.question()).foregroundStyle(MaskinColor.ink)
				ForEach(option.consequences, id: \.self) { line in
					Text(line).font(WatchType.caption()).foregroundStyle(MaskinColor.ink3)
				}
				Button(action: confirm) {
					Text("Confirm").font(MaskinTypeface.sans(16, weight: .bold, relativeTo: .body))
						.foregroundStyle(MaskinSurface.onInverse)
						.frame(maxWidth: .infinity, minHeight: 44)
						.background(MaskinSurface.inverse, in: Capsule())
				}
				.buttonStyle(.plain)
				Button(action: cancel) {
					Text("Cancel").font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
						.frame(maxWidth: .infinity, minHeight: 44)
				}
				.buttonStyle(.plain)
			}
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
	}
}

private extension String {
	var nonEmpty: String? {
		let t = trimmingCharacters(in: .whitespacesAndNewlines)
		return t.isEmpty ? nil : t
	}
}
