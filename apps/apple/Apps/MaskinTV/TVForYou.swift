import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// For you on the big screen: the decisions waiting on you as focusable cards. Selecting one opens
/// the Decision screen, where it is decided with the remote.
struct TVForYou: View {
	let environment: AppEnvironment
	let forYou: ForYouRuntime?
	let stories: StoriesStore?
	@Binding var openDecision: String?
	@State private var path: [String] = []
	@State private var playing: BriefSequence?

	private var store: ForYouStore? { forYou?.store }

	private var entries: [FeedEntry] {
		(store?.entries ?? []).filter { $0.section == .needs }
	}

	var body: some View {
		NavigationStack(path: $path) {
			ScrollView {
				VStack(alignment: .leading, spacing: 28) {
					Text("For you").font(.system(size: 64, weight: .bold))
					if let stories {
						TVStoryRow(stories: stories) { card in
							playing = BriefSequence.make(cards: stories.cards, opening: card)
						}
					}
					content
				}
				.padding(.horizontal, 96)
				.padding(.top, 24)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.ignoresSafeArea(edges: .horizontal)
			.navigationDestination(for: String.self) { id in
				if let store { TVDecision(environment: environment, store: store, chief: forYou?.chief, id: id) }
			}
		}
		.onChange(of: openDecision) { _, id in
			guard let id else { return }
			path = [id]
			openDecision = nil
		}
		.fullScreenCover(item: Binding(get: { playing.map(PlayingSequence.init) }, set: { if $0 == nil { playing = nil } })) { item in
			if let stories {
				TVBriefingPlayer(
					environment: environment, stories: stories, chief: forYou?.chief, sequence: item.sequence
				) { playing = nil }
			}
		}
	}

	@ViewBuilder private var content: some View {
		if let store, !entries.isEmpty {
			Text("NEEDS YOU · \(entries.count)")
				.font(.system(size: 24, weight: .semibold, design: .monospaced))
				.foregroundStyle(MaskinColor.ink4)
			LazyVGrid(columns: [GridItem(.flexible(), spacing: 40), GridItem(.flexible())], spacing: 40) {
				ForEach(entries) { entry in
					NavigationLink(value: entry.id) { TVDecisionCard(store: store, entry: entry) }
						.buttonStyle(TVFocusStyle())
				}
			}
			.padding(.vertical, 20)
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
	private var sender: String { store.senderName(of: card) ?? "Chief of Staff" }

	var body: some View {
		VStack(alignment: .leading, spacing: 22) {
			header
			Text(card.decision?.summary.trimmedNonEmpty ?? card.headline)
				.font(.system(size: 30)).foregroundStyle(MaskinColor.ink2)
				.lineLimit(3).multilineTextAlignment(.leading)
			if let ask = card.decision?.ask.trimmedNonEmpty {
				Text(ask).font(.system(size: 32, weight: .semibold)).lineLimit(1)
			}
			answer
			Spacer(minLength: 0)
			Divider().overlay(MaskinSurface.line)
			footer
		}
		.padding(40)
		.frame(maxWidth: .infinity, minHeight: 440, alignment: .topLeading)
		.foregroundStyle(MaskinColor.ink)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 40, style: .continuous))
	}

	private var header: some View {
		HStack(spacing: 16) {
			Text(sender == "Chief of Staff" ? "Co" : String(sender.split(separator: " ").prefix(2).compactMap(\.first)))
				.font(.system(size: 22, weight: .bold)).foregroundStyle(MaskinColor.avFg)
				.frame(width: 46, height: 46)
				.background(MaskinGradient.avatar, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
			Text(sender).font(.system(size: 30, weight: .semibold)).lineLimit(1)
			Spacer(minLength: 0)
			if let when = card.latestActivityAt {
				Text(when.formatted(date: .omitted, time: .shortened))
					.font(.system(size: 26)).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	@ViewBuilder private var answer: some View {
		if let record = entry.record, case .option(let label) = record.kind {
			Label("You chose \(label)", systemImage: "checkmark.circle.fill")
				.font(.system(size: 30, weight: .semibold))
		} else if let options = card.decision?.options {
			HStack(spacing: 14) {
				ForEach(options) { option in
					Text(option.label).font(.system(size: 28, weight: .semibold)).lineLimit(1).fixedSize()
						.padding(.horizontal, 26).frame(height: 64)
						.foregroundStyle(option.recommended ? MaskinSurface.onInverse : MaskinColor.ink)
						.background(option.recommended ? MaskinSurface.inverse : MaskinSurface.fillStrong, in: Capsule())
				}
			}
		}
	}

	private var footer: some View {
		HStack(spacing: 14) {
			Circle().fill(MaskinPatina.dotWatch).frame(width: 16, height: 16)
			Text((card.objectType ?? "object").uppercased())
				.font(.system(size: 24, weight: .medium, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
			Text(card.objectTitle ?? card.headline).font(.system(size: 30, weight: .semibold)).lineLimit(1)
			Spacer(minLength: 0)
			Text("Ask").font(.system(size: 28, weight: .semibold))
				.padding(.horizontal, 28).frame(height: 56)
				.background(MaskinSurface.fillStrong, in: Capsule())
		}
	}
}

extension String {
	fileprivate var trimmedNonEmpty: String? {
		let t = trimmingCharacters(in: .whitespacesAndNewlines)
		return t.isEmpty ? nil : t
	}
}

/// `BriefSequence` has no identity of its own, and a full-screen cover needs one.
private struct PlayingSequence: Identifiable {
	let sequence: BriefSequence
	var id: String { sequence.slides.map(\.id).joined(separator: "|") + "@\(sequence.startIndex)" }
}
