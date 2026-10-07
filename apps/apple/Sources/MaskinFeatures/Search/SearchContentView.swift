import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One thing waiting on the person, shown above the recents while the field is empty.
struct SearchNeedsYou: Identifiable, Equatable {
	/// The object the card is about.
	let id: String
	let title: String
	/// The object type (`bet`, `task`...), shown as a mono label.
	let type: String?
}

/// The search tab's content for a given store state, in a scroll view.
struct SearchContentView: View {
	let store: SearchStore
	var needsYou: [SearchNeedsYou] = []
	var onOpenNeedsYou: (String) -> Void = { _ in }
	let onSelect: (SearchResult) -> Void

	var body: some View {
		ScrollView {
			SearchContentBody(
				store: store, onSelect: onSelect, showsChips: true, needsYou: needsYou,
				onOpenNeedsYou: onOpenNeedsYou)
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s5)
				.frame(maxWidth: 760)
				.frame(maxWidth: .infinity)
		}
		.scrollDismissesKeyboard(.interactively)
		.ambientBackground()
	}
}

/// Recents, skeleton, error, empty and grouped results as plain stacks (no scroll view), so it
/// also renders in `ImageRenderer` snapshots.
struct SearchContentBody: View {
	let store: SearchStore
	let onSelect: (SearchResult) -> Void
	var showsChips = false
	var needsYou: [SearchNeedsYou] = []
	var onOpenNeedsYou: (String) -> Void = { _ in }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			if showsChips { SearchScopeChips(store: store) }
			switch store.phase {
			case .idle:
				needsYouSection
				recents
			case .searching where store.allResults.isEmpty:
				LoadingSkeleton(rows: 5)
			case .failed(let message):
				EmptyState(
					symbol: store.isOffline ? "wifi.slash" : "exclamationmark.triangle",
					title: "Search didn't work", message: message
				) {
					Button("Try again") { Task { await store.retry() } }
						.buttonStyle(SecondaryActionButtonStyle())
				}
			case .searching, .results:
				results
			}
		}
	}

	/// Live items waiting on the person (the open decisions of For you), most pressing first.
	@ViewBuilder private var needsYouSection: some View {
		if !needsYou.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				MonoLabel("Needs you").accessibilityAddTraits(.isHeader)
				card {
					ForEach(Array(needsYou.enumerated()), id: \.element.id) { index, item in
						if index > 0 { Divider() }
						Button { onOpenNeedsYou(item.id) } label: {
							HStack(spacing: MaskinSpace.s5) {
								Text(item.title).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(2)
									.frame(maxWidth: .infinity, alignment: .leading)
								if let type = item.type { MonoLabel(type) }
							}
							.padding(.vertical, MaskinSpace.s5)
							.frame(minHeight: MaskinSpace.touchMin)
							.contentShape(Rectangle())
						}
						.buttonStyle(.plain)
					}
				}
			}
		}
	}

	@ViewBuilder private var recents: some View {
		if store.recents.isEmpty && needsYou.isEmpty {
			EmptyState(
				symbol: "magnifyingglass", title: "Search everything",
				message: "Objects, chats, agents and files in this workspace.")
		} else if store.recents.isEmpty {
			EmptyView()
		} else {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				HStack {
					MonoLabel("Recent searches")
					Spacer()
					Button("Clear") { store.clearRecents() }
						.maskinText(.caption)
						.foregroundStyle(MaskinColor.ink4)
				}
				card {
					ForEach(Array(store.recents.enumerated()), id: \.element) { index, recent in
						if index > 0 { Divider() }
						HStack {
							Button { store.setQuery(recent) } label: {
								Label(recent, systemImage: "clock.arrow.circlepath")
									.maskinText(.body)
									.foregroundStyle(MaskinColor.ink)
									.frame(maxWidth: .infinity, alignment: .leading)
									.contentShape(Rectangle())
							}
							.buttonStyle(.plain)
							Button { store.removeRecent(recent) } label: {
								Image(systemName: "xmark").foregroundStyle(MaskinColor.ink5)
									.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
									.contentShape(Rectangle())
							}
							.buttonStyle(.plain)
							.accessibilityLabel("Remove \(recent)")
						}
						.padding(.vertical, MaskinSpace.s5)
					}
				}
			}
		}
	}

	@ViewBuilder private var results: some View {
		let sections = store.sections
		if sections.isEmpty {
			EmptyState(
				symbol: "magnifyingglass", title: "No matches",
				message: "Nothing for “\(store.query)”\(store.scope == .all ? "" : " in \(store.scope.title)"). Try another word or scope."
			)
		} else {
			ForEach(sections) { section in
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					HStack(spacing: MaskinSpace.s4) {
						MonoLabel(section.kind.title)
						Text("\(section.results.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink5)
					}
					.accessibilityAddTraits(.isHeader)
					card {
						ForEach(Array(section.results.enumerated()), id: \.element.id) { index, result in
							if index > 0 { Divider() }
							Button { onSelect(result) } label: {
								SearchResultRow(result: result, query: store.query)
									.padding(.vertical, MaskinSpace.s3)
							}
							.buttonStyle(.plain)
						}
					}
				}
			}
			if store.isPartial {
				Label("Some results couldn't be loaded.", systemImage: "exclamationmark.circle")
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	private func card<C: View>(@ViewBuilder _ content: () -> C) -> some View {
		VStack(spacing: 0) { content() }
			.padding(.horizontal, MaskinSpace.s7)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
	}
}

/// All, Bets, Tasks, Insights, Files, Agents: narrows the results without searching again.
struct SearchScopeChips: View {
	let store: SearchStore

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s2) {
				ForEach(SearchScope.chips) { scope in
					let selected = store.scope == scope
					Button {
						MaskinHaptics.play(.selection)
						store.scope = scope
					} label: {
						Text(scope.title)
							.maskinText(.subhead)
							.fontWeight(selected ? .semibold : .regular)
							.foregroundStyle(selected ? MaskinColor.ink : MaskinColor.ink4)
							.padding(.horizontal, MaskinSpace.s6)
							.frame(minHeight: MaskinSpace.s14)
							.background(selected ? MaskinSurface.fill : Color.clear, in: Capsule())
							.contentShape(Capsule())
					}
					.buttonStyle(.plain)
					.accessibilityAddTraits(selected ? .isSelected : [])
				}
			}
		}
	}
}
