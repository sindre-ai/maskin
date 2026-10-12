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
	@Binding var chromeHidden: Bool
	/// A flow the briefing player asked to open; Flows picks it up.
	@Binding var openFlow: String?
	@State private var path = NavigationPath()
	@State private var playing: BriefSequence?
	@State private var askFailed = false

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
			.navigationDestination(for: TVThreadRoute.self) { TVThread(environment: environment, conversationID: $0.id) }
		}
		.alert("Can't open the thread", isPresented: $askFailed) { Button("OK", role: .cancel) {} }
		#if DEBUG
		.task(id: entries.first?.id) {
			// MASKIN_DEMO_SCREEN=decision | briefing opens that screen once the data is in.
			let demo = ProcessInfo.processInfo.environment["MASKIN_DEMO_SCREEN"]
			if demo == "decision" || demo == "thread", let id = entries.first?.id, path.isEmpty { path.append(id) }
		}
		.task(id: stories?.cards.first?.id) {
			if ProcessInfo.processInfo.environment["MASKIN_DEMO_SCREEN"] == "briefing", let stories,
				let card = stories.cards.first, playing == nil
			{ playing = BriefSequence.make(cards: stories.cards, opening: card) }
		}
		#endif
		.onChange(of: path.count) { _, count in chromeHidden = count > 0 }
		.onChange(of: openDecision) { _, id in
			guard let id else { return }
			path = NavigationPath([id])
			openDecision = nil
		}
		.fullScreenCover(item: Binding(get: { playing.map(PlayingSequence.init) }, set: { if $0 == nil { playing = nil } })) { item in
			if let stories {
				TVBriefingPlayer(
					environment: environment, stories: stories, chief: forYou?.chief, sequence: item.sequence,
					action: { briefingAction(for: $0) }, onAction: perform
				) { playing = nil }
			}
		}
	}

	/// What the last briefing slide offers: review the first thing that needs you, or open the flow
	/// a page came from. Nil when there is nothing specific to open.
	private func briefingAction(for card: StoryCard) -> TVBriefingAction? {
		if let loopID = card.loopID { return TVBriefingAction(title: "Open \(card.unit) flow", target: .flow(loopID)) }
		guard let first = entries.first(where: { $0.record == nil }) else { return nil }
		let name = first.card.objectTitle ?? first.card.headline
		return TVBriefingAction(title: "Review \(name)", target: .decision(first.id))
	}

	private func perform(_ action: TVBriefingAction) {
		playing = nil
		switch action.target {
		case .decision(let id): path.append(id)
		case .flow(let id): openFlow = id
		}
	}

	/// Asking the Chief of Staff about a card opens its conversation without leaving For you.
	private func ask(about card: ForYouCard) {
		guard let chief = forYou?.chief else { return }
		Task {
			do {
				let outcome = try await ChiefOfStaffThreads.open(about: card, conversations: chief.conversations)
				path.append(TVThreadRoute(id: outcome.conversation.id))
			} catch {
				askFailed = true
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
					ZStack(alignment: .bottomTrailing) {
						NavigationLink(value: entry.id) { TVDecisionCard(store: store, entry: entry) }
							.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 40))
						// Ask is its own focus stop on the card's footer, to the right of the card.
						if forYou?.chief != nil, entry.record == nil {
							Button { ask(about: entry.card) } label: { TVAskPill() }
								.buttonStyle(TVFocusStyle(scale: 1.08, cornerRadius: 28))
								.padding(.trailing, 40).padding(.bottom, 36)
						}
					}
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
				if entry.record == nil, let held = TVDecisionAge.heldTag(since: when) {
					Text(held).font(.system(size: 24, weight: .semibold, design: .monospaced))
						.foregroundStyle(MaskinColor.ink4)
				}
				Text(when.formatted(date: .omitted, time: .shortened))
					.font(.system(size: 26)).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	@ViewBuilder private var answer: some View {
		if let record = entry.record, case .option(let label) = record.kind {
			// The done block: what was chosen, then the agent's own lines about what happens next.
			VStack(alignment: .leading, spacing: 10) {
				Label("You chose \(label)", systemImage: "checkmark.circle.fill")
					.font(.system(size: 30, weight: .semibold))
				ForEach(card.decision?.options.first(where: { $0.label == label })?.consequences ?? [], id: \.self) {
					Text($0).font(.system(size: 26)).foregroundStyle(MaskinColor.ink3).lineLimit(2)
				}
			}
		} else if let options = card.decision?.options {
			// Every option, wrapping onto a second line rather than clipping.
			TVWrapLayout(spacing: 14) {
				ForEach(options) { option in
					Text(option.label).font(.system(size: 28, weight: .semibold)).lineLimit(1)
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
				.font(.system(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
			Text(card.objectTitle ?? card.headline).font(.system(size: 30, weight: .semibold)).lineLimit(1)
			Spacer(minLength: 0)
			// Room for the focusable Ask pill laid over this corner by the grid.
			Color.clear.frame(width: TVAskPill.width, height: 56)
		}
	}
}

/// The Ask pill on a decision card's footer.
struct TVAskPill: View {
	static let width: CGFloat = 110

	var body: some View {
		Text("Ask").font(.system(size: 28, weight: .semibold))
			.foregroundStyle(MaskinColor.ink)
			.frame(width: Self.width, height: 56)
			.background(MaskinSurface.fillStrong, in: Capsule())
			.accessibilityLabel("Ask Chief of Staff")
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
