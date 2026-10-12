import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The loops sidebar: sections by what needs attention, with loading, empty, error and offline states.
struct LoopsListView: View {
	let store: LoopsStore
	@Binding var selection: String?
	let search: String
	var isLive = true
	/// Regular width: cards in a 2-3 across grid that pushes the detail, instead of a sidebar list.
	var isGrid = false
	var zoomNamespace: Namespace.ID?
	var onNew: () -> Void = {}

	var body: some View {
		let loops = store.filtered(query: search)
		Group {
			if isGrid { grid(loops) } else { list(loops) }
		}
		.ambientBackground()
		.overlay { overlay(isEmpty: loops.isEmpty) }
		.refreshable { await store.refresh() }
	}

	private func card(_ loop: LoopSummary) -> LoopCard {
		LoopCard(
			loop: loop, needsYou: store.needsYou(loop),
			hasUpdate: store.installs[loop.id]?.hasUpdate == true,
			update: store.latestUpdate(for: loop),
			target: LoopOutcomes.cards(for: [loop]).first)
	}

	/// 2-3 cards across (adaptive columns); a card pushes the flow's detail full width.
	private func grid(_ loops: [LoopSummary]) -> some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				if !isLive {
					OfflineBanner(message: "Live updates paused. Reconnecting…")
				}
				if let notice = store.notice {
					FormError(notice).onTapGesture { store.notice = nil }
				}
				if search.isEmpty, let summary = store.summaryLine {
					Text(summary)
						.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink4)
				}
				LazyVGrid(
					columns: [GridItem(.adaptive(minimum: 340, maximum: 520), spacing: MaskinSpace.s9, alignment: .top)],
					alignment: .leading, spacing: MaskinSpace.s9
				) {
					ForEach(loops) { loop in
						Button { selection = loop.id } label: { card(loop) }
							.buttonStyle(.plain)
							.zoomSource(id: loop.id, in: zoomNamespace)
					}
				}
			}
			.padding(.horizontal, MaskinSpace.s14)
			.padding(.vertical, MaskinSpace.s9)
		}
	}

	private func list(_ loops: [LoopSummary]) -> some View {
		List(selection: $selection) {
			if !isLive {
				OfflineBanner(message: "Live updates paused. Reconnecting…")
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			if let notice = store.notice {
				FormError(notice)
					.listRowBackground(Color.clear)
					.onTapGesture { store.notice = nil }
			}
			if search.isEmpty, let summary = store.summaryLine {
				Text(summary)
					.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink4)
					.listRowSeparator(.hidden)
					.listRowBackground(Color.clear)
			}
			if search.isEmpty {
				let cards = LoopOutcomes.cards(for: store.loops)
				if !cards.isEmpty {
					OutcomeScoreRow(cards: cards) { selection = $0 }
						.listRowInsets(EdgeInsets())
						.listRowSeparator(.hidden)
						.listRowBackground(Color.clear)
				}
			}
			ForEach(loops) { loop in
				card(loop)
				.tag(loop.id)
				.zoomSource(id: loop.id, in: zoomNamespace)
				.listRowSeparator(.hidden)
				.listRowBackground(Color.clear)
				.listRowInsets(
					EdgeInsets(
						top: MaskinSpace.s3, leading: MaskinSpace.s7, bottom: MaskinSpace.s3,
						trailing: MaskinSpace.s7))
				.swipeActions(edge: .trailing, allowsFullSwipe: true) {
					if loop.status != .draft {
						Button {
							Task { await store.togglePause(loop.id) }
						} label: {
							Label(loop.isPaused ? "Resume" : "Pause", systemImage: loop.isPaused ? "play.fill" : "pause.fill")
						}
						.tint(MaskinColor.ink3)
					}
				}
			}
		}
		.listStyle(.plain)
	}

	@ViewBuilder
	private func overlay(isEmpty: Bool) -> some View {
		switch store.phase {
		case .idle, .loading:
			if store.loops.isEmpty { LoadingSkeleton(rows: 4).padding(MaskinSpace.s9) }
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load flows", message: message) {
				Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if isEmpty {
				if search.isEmpty {
					EmptyState(
						symbol: "arrow.triangle.2.circlepath", title: "No flows running",
						message: "Ask the Chief of Staff to set one up. Nothing runs until you approve it."
					) {
						Button("Build a flow in chat", action: onNew).buttonStyle(.primaryAction)
					}
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}
}
