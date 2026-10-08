import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// For you on the big screen: the decisions waiting on you as focusable cards. Selecting one opens
/// the Decision screen, where it is decided with the remote.
struct TVForYou: View {
	let environment: AppEnvironment
	let store: ForYouStore?

	private var entries: [FeedEntry] {
		(store?.entries ?? []).filter { $0.section == .needs }
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 40) {
					Text("For you").font(.system(size: 64, weight: .bold))
					content
				}
				.padding(.horizontal, 96)
				.padding(.top, 56)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.navigationDestination(for: String.self) { id in
				if let store { TVDecision(store: store, id: id) }
			}
		}
	}

	@ViewBuilder private var content: some View {
		if let store, !entries.isEmpty {
			Text("NEEDS YOU · \(entries.count)")
				.font(.system(size: 24, weight: .semibold, design: .monospaced))
				.foregroundStyle(MaskinColor.ink4)
			ScrollView(.horizontal, showsIndicators: false) {
				LazyHStack(spacing: 40) {
					ForEach(entries) { entry in
						NavigationLink(value: entry.id) { TVDecisionCard(store: store, entry: entry) }
							.buttonStyle(TVFocusStyle())
					}
				}
				.padding(.vertical, 40)
			}
			.scrollClipDisabled()
		} else if let store, store.phase == .loading, store.cards.isEmpty {
			ProgressView().frame(maxWidth: .infinity, minHeight: 300)
		} else if let store, case .failed(let message) = store.phase, store.cards.isEmpty {
			EmptyState(symbol: "wifi.exclamationmark", title: "Can't load", message: message) {
				Button("Try again") { Task { await store.load() } }
			}
		} else {
			EmptyState(symbol: "checkmark.circle", title: "You're caught up", message: "Nothing needs you.")
		}
	}
}

struct TVDecisionCard: View {
	let store: ForYouStore
	let entry: FeedEntry

	private var card: ForYouCard { entry.card }

	var body: some View {
		VStack(alignment: .leading, spacing: 20) {
			HStack(spacing: 16) {
				Text(initials)
					.font(.system(size: 24, weight: .bold))
					.frame(width: 56, height: 56)
					.background(MaskinSurface.fillStrong, in: RoundedRectangle(cornerRadius: 16))
				Text(store.senderName(of: card) ?? "Chief of Staff")
					.font(.system(size: 28, weight: .semibold)).lineLimit(1)
			}
			Text(card.decision?.ask.trimmedNonEmpty ?? card.headline)
				.font(.system(size: 30, weight: .semibold))
				.lineLimit(3)
				.multilineTextAlignment(.leading)
			Spacer(minLength: 0)
			footer
		}
		.padding(32)
		.frame(width: 520, height: 330, alignment: .topLeading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
	}

	@ViewBuilder private var footer: some View {
		if let record = entry.record, case .option(let label) = record.kind {
			Label("You chose \(label)", systemImage: "checkmark.circle.fill")
				.font(.system(size: 26, weight: .semibold))
		} else if let options = card.decision?.options, let first = options.first(where: \.recommended) ?? options.first {
			HStack(spacing: 14) {
				Text(first.label).font(.system(size: 26, weight: .semibold)).lineLimit(1)
					.padding(.horizontal, 28).frame(height: 64)
					.background(MaskinSurface.inverse, in: Capsule())
					.foregroundStyle(MaskinSurface.onInverse)
				if options.count > 1 {
					Text("+ \(options.count - 1) more").font(.system(size: 24)).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
	}

	private var initials: String {
		let words = (store.senderName(of: card) ?? "Chief of Staff").split(separator: " ")
		return String(words.prefix(2).compactMap(\.first)).uppercased()
	}
}

extension String {
	fileprivate var trimmedNonEmpty: String? {
		let t = trimmingCharacters(in: .whitespacesAndNewlines)
		return t.isEmpty ? nil : t
	}
}
