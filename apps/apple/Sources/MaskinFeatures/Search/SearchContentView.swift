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
	var onAskChiefOfStaff: (String) -> Void = { _ in }
	let onSelect: (SearchResult) -> Void

	var body: some View {
		ScrollView {
			SearchContentBody(
				store: store, onSelect: onSelect, showsChips: true, needsYou: needsYou,
				onOpenNeedsYou: onOpenNeedsYou, onAskChiefOfStaff: onAskChiefOfStaff)
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
	var onAskChiefOfStaff: (String) -> Void = { _ in }

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
								RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
									.fill(MaskinColor.sigInk)
									.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
									.accessibilityHidden(true)
								VStack(alignment: .leading, spacing: MaskinSpace.s1) {
									Text(item.title).maskinText(.headline).foregroundStyle(MaskinColor.ink)
										.lineLimit(2)
									if let type = item.type {
										Text(type).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
									}
								}
								.frame(maxWidth: .infinity, alignment: .leading)
								Image(systemName: "chevron.right").foregroundStyle(MaskinColor.ink5)
									.accessibilityHidden(true)
							}
							.padding(.vertical, MaskinSpace.s5)
							.frame(minHeight: MaskinSpace.touchMin)
							.contentShape(Rectangle())
						}
						.buttonStyle(.maskinPressed)
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
					MonoLabel("Recent")
					Spacer()
					Button("Clear") { store.clearRecents() }
						.maskinText(.caption)
						.foregroundStyle(MaskinColor.ink4)
						.buttonStyle(.maskinPressed)
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
							.buttonStyle(.maskinPressed)
							Button { store.removeRecent(recent) } label: {
								Image(systemName: "xmark").foregroundStyle(MaskinColor.ink5)
									.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
									.contentShape(Rectangle())
							}
							.buttonStyle(.maskinPressed)
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
			noMatch
		} else {
			ForEach(sections) { section in
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					HStack(spacing: MaskinSpace.s4) {
						MonoLabel(section.group.title)
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
							.buttonStyle(.maskinPressed)
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

	/// Nothing in the chosen scope: offer to hand the question to Chief of Staff.
	private var noMatch: some View {
		VStack(spacing: MaskinSpace.s3) {
			Text("Nothing matches that yet").maskinText(.title).foregroundStyle(MaskinColor.ink)
			Text("An agent can look further than the index does.")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				.multilineTextAlignment(.center)
			Button { onAskChiefOfStaff(store.query) } label: {
				Text("Ask Chief of Staff")
					.maskinText(.headline)
					.foregroundStyle(MaskinSurface.onInverse)
					.padding(.horizontal, MaskinSpace.s8)
					.frame(minHeight: MaskinSpace.touchMin)
					.background(MaskinSurface.inverse, in: Capsule())
			}
			.buttonStyle(.maskinPressed(.shrink))
			.padding(.top, MaskinSpace.s5)
		}
		.frame(maxWidth: .infinity)
		.padding(.vertical, MaskinSpace.s13)
		.padding(.horizontal, MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
	}

	private func card<C: View>(@ViewBuilder _ content: () -> C) -> some View {
		VStack(spacing: 0) { content() }
			.padding(.horizontal, MaskinSpace.s7)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
	}
}

/// All, Team, Objects, Flows, Agents with counts, plus the type sub-chips under Objects. Narrows
/// the results without searching again.
struct SearchScopeChips: View {
	let store: SearchStore

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: MaskinSpace.s2) {
					ForEach(SearchScope.chips) { scope in chip(scope) }
				}
			}
			let types = store.objectTypes
			if store.scope == .objects, types.count > 1 {
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: MaskinSpace.s8) {
						subChip(nil, label: "All types")
						ForEach(types, id: \.self) { type in subChip(type, label: type.replacingOccurrences(of: "_", with: " ").capitalized) }
					}
					.padding(.horizontal, MaskinSpace.s5)
				}
			}
		}
	}

	private func chip(_ scope: SearchScope) -> some View {
		let selected = store.scope == scope
		return Button {
			MaskinHaptics.play(.selection)
			store.scope = scope
		} label: {
			HStack(spacing: MaskinSpace.s2) {
				Text(scope.title)
				if store.phase == .results {
					Text("\(store.count(in: scope))").maskinText(.caption).foregroundStyle(MaskinColor.ink5)
				}
			}
			.maskinText(.subhead)
			.fontWeight(selected ? .semibold : .regular)
			.foregroundStyle(selected ? MaskinColor.ink : MaskinColor.ink4)
			.padding(.horizontal, MaskinSpace.s6)
			.frame(minHeight: MaskinSpace.s14)
			.background(selected ? MaskinSurface.fill : Color.clear, in: Capsule())
			.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityAddTraits(selected ? .isSelected : [])
	}

	private func subChip(_ type: String?, label: String) -> some View {
		let selected = store.objectType == type
		return Button {
			MaskinHaptics.play(.selection)
			store.objectType = type
		} label: {
			Text(label).maskinText(.subhead)
				.fontWeight(selected ? .semibold : .regular)
				.foregroundStyle(selected ? MaskinColor.ink : MaskinColor.ink4)
				.frame(minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityAddTraits(selected ? .isSelected : [])
	}
}
