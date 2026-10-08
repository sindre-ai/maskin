import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One decision, full screen. The message and the question on the left, the options as big capsules
/// on the right. An option that can't be taken back asks first; after deciding the screen shows what
/// was chosen with an Undo. Text never needs typing: replies and questions come with the thread.
struct TVDecision: View {
	let store: ForYouStore
	let id: String
	@Environment(\.dismiss) private var dismiss
	@State private var confirming: DecisionOption?

	private var entry: FeedEntry? { store.entries.first { $0.id == id } }

	var body: some View {
		Group {
			if let entry {
				HStack(alignment: .top, spacing: 96) {
					left(entry.card)
					right(entry)
						.frame(width: 640)
				}
				.padding(.horizontal, 96)
				.padding(.top, 56)
			} else {
				EmptyState(symbol: "checkmark.circle", title: "Done")
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.confirmationDialog(
			confirming.map { "\($0.label)?" } ?? "", isPresented: Binding(
				get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
			titleVisibility: .visible, presenting: confirming
		) { option in
			Button("Confirm", role: .destructive) {
				if let entry { store.choose(option, on: entry.card) }
			}
			Button("Cancel", role: .cancel) {}
		} message: { option in
			Text(option.consequences.joined(separator: "\n"))
		}
	}

	private func left(_ card: ForYouCard) -> some View {
		VStack(alignment: .leading, spacing: 32) {
			Text(store.senderName(of: card) ?? "Chief of Staff")
				.font(.system(size: 28, weight: .semibold)).foregroundStyle(MaskinColor.ink4)
			Text(card.decision?.title.trimmedNonEmpty ?? card.headline)
				.font(.system(size: 48, weight: .bold))
			if let summary = card.decision?.summary.trimmedNonEmpty {
				Text(summary).font(.system(size: 30)).foregroundStyle(MaskinColor.ink3)
			}
			if let ask = card.decision?.ask.trimmedNonEmpty {
				Text(ask).font(.system(size: 36, weight: .semibold))
			}
			if let context = card.contextTitle {
				Text(context).font(.system(size: 26, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	@ViewBuilder private func right(_ entry: FeedEntry) -> some View {
		VStack(spacing: 24) {
			if let record = entry.record, !isFailed(record) {
				receipt(record, entry: entry)
			} else {
				ForEach(entry.card.decision?.options ?? []) { option in
					Button {
						if option.destructive { confirming = option } else { store.choose(option, on: entry.card) }
					} label: {
						TVCapsuleLabel(title: option.label, prominent: option.recommended)
					}
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
				}
				if (entry.card.decision?.options ?? []).isEmpty {
					Text("Decide on iPhone or Watch").font(.system(size: 28)).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
	}

	private func receipt(_ record: DecisionRecord, entry: FeedEntry) -> some View {
		VStack(alignment: .leading, spacing: 24) {
			Label(receiptTitle(record), systemImage: "checkmark.circle.fill")
				.font(.system(size: 40, weight: .bold))
			switch record.phase {
			case .held:
				Text("Undo any time in the next hour.").font(.system(size: 28)).foregroundStyle(MaskinColor.ink4)
				Button { _ = store.undo(entry.card) } label: { TVCapsuleLabel(title: "Undo") }
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
			case .queued:
				Text("Queued, sends when you're back.").font(.system(size: 28)).foregroundStyle(MaskinColor.ink4)
			default:
				EmptyView()
			}
			Button { dismiss() } label: { TVCapsuleLabel(title: "Back") }
				.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func receiptTitle(_ record: DecisionRecord) -> String {
		switch record.kind {
		case .option(let label): "You chose \(label)"
		case .reply: "Sent"
		case .dismissed: "Marked read"
		}
	}

	private func isFailed(_ record: DecisionRecord) -> Bool {
		if case .failed = record.phase { return true }
		return false
	}
}

extension String {
	fileprivate var trimmedNonEmpty: String? {
		let t = trimmingCharacters(in: .whitespacesAndNewlines)
		return t.isEmpty ? nil : t
	}
}
