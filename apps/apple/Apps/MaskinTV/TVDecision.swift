import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One decision, full screen. The message and the question on the left, the options as big capsules
/// on the right. An option that can't be taken back asks first; after deciding the screen shows what
/// was chosen with an Undo. Text never needs typing: replies and questions come with the thread.
struct TVDecision: View {
	let environment: AppEnvironment
	let store: ForYouStore
	let chief: ChiefOfStaffDesk?
	let id: String
	@Environment(\.dismiss) private var dismiss
	@State private var confirming: DecisionOption?
	@State private var thread: TVThreadRoute?
	@State private var opening = false
	@State private var askFailed = false

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
				.padding(.bottom, 80)
			} else {
				EmptyState(symbol: "checkmark.circle", title: "Done")
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.ignoresSafeArea()
		#if DEBUG
		.task(id: chief != nil) {
			if ProcessInfo.processInfo.environment["MASKIN_DEMO_SCREEN"] == "thread", let entry {
				await openThread(about: entry.card)
			}
		}
		#endif
		.navigationDestination(item: $thread) { TVThread(environment: environment, conversationID: $0.id) }
		.alert("Can't open the thread", isPresented: $askFailed) {
			Button("OK", role: .cancel) {}
		} message: {
			Text("There's no Chief of Staff in this workspace to ask.")
		}
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
		let sender = store.senderName(of: card) ?? "Chief of Staff"
		return VStack(alignment: .leading, spacing: 34) {
			HStack(spacing: 18) {
				Text(sender == "Chief of Staff" ? "Co" : String(sender.split(separator: " ").prefix(2).compactMap(\.first)))
					.font(.system(size: 28, weight: .bold)).foregroundStyle(MaskinColor.avFg)
					.frame(width: 62, height: 62)
					.background(MaskinGradient.avatar, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
				Text(sender).font(.system(size: 36, weight: .semibold))
				if let when = card.latestActivityAt {
					Text(when.formatted(date: .omitted, time: .shortened))
						.font(.system(size: 28)).foregroundStyle(MaskinColor.ink4)
				}
			}
			Text(card.decision?.summary.trimmedNonEmpty ?? card.headline)
				.font(.system(size: 52)).lineSpacing(6)
			if let ask = card.decision?.ask.trimmedNonEmpty {
				Text(ask).font(.system(size: 36, weight: .semibold)).foregroundStyle(MaskinColor.ink3)
			}
			Spacer(minLength: 0)
			HStack(spacing: 14) {
				Circle().fill(MaskinPatina.dotWatch).frame(width: 18, height: 18)
				Text((card.objectType ?? "object").uppercased())
					.font(.system(size: 24, weight: .medium, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
				Text(card.objectTitle ?? card.headline).font(.system(size: 34, weight: .semibold))
			}
		}
		.foregroundStyle(MaskinColor.ink)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
				askButton(entry.card)
				if let pick = entry.card.decision?.recommended {
					Text("Suggested: \(pick.label). Every choice can be undone unless noted.")
						.font(.system(size: 28)).foregroundStyle(MaskinColor.ink4)
						.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12)
				}
				Button { dismiss() } label: {
					Label("Back", systemImage: "chevron.left").font(.system(size: 32, weight: .semibold))
						.foregroundStyle(MaskinColor.ink3).frame(maxWidth: .infinity, minHeight: 80)
				}
				.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
			}
		}
	}

	/// Opens the conversation with the Chief of Staff about this card's object: dictate a question
	/// there rather than typing one.
	@ViewBuilder private func askButton(_ card: ForYouCard) -> some View {
		if let chief {
			Button {
				Task { await openThread(about: card) }
			} label: {
				TVCapsuleLabel(title: opening ? "Opening…" : "Ask Chief of Staff", symbol: "mic.fill")
			}
			.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
		}
	}

	private func openThread(about card: ForYouCard) async {
		guard let chief, !opening else { return }
		opening = true
		defer { opening = false }
		do {
			let outcome = try await ChiefOfStaffThreads.open(about: card, conversations: chief.conversations)
			thread = TVThreadRoute(id: outcome.conversation.id)
		} catch {
			askFailed = true
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

/// Where "Ask Chief of Staff" goes: the conversation about the card's object.
struct TVThreadRoute: Hashable, Identifiable {
	let id: String
}
