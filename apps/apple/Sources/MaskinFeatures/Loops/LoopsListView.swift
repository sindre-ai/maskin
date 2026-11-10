import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Flows list, with loading, empty, error and offline states. The header is the title alone;
/// when a running flow needs the viewer a "{n} need you ›" pill appears under it and filters the
/// list to those flows (handoff `7-Chat.md` §10). Flows carry no tags, so there is no filter bar.
struct LoopsListView: View {
	@Environment(\.horizontalSizeClass) private var sizeClass
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
	}

	private func card(_ loop: LoopSummary) -> LoopCard {
		LoopCard(
			loop: loop, needsYou: store.needsYou(loop),
			hasUpdate: store.installs[loop.id]?.hasUpdate == true,
			update: store.display.showsSummary ? store.latestUpdate(for: loop) : nil)
	}

	/// The one-line summary and the tag chips above the cards.
	@ViewBuilder
	private var header: some View {
		if search.isEmpty {
			if let line = FlowsOverview.needsYouLine(store.loops) {
				Text(line)
					.font(MaskinTypeface.sans(MaskinFontSize.t24, weight: .semibold, relativeTo: .title2))
					.tracking(-0.02 * MaskinFontSize.t24)
					.foregroundStyle(MaskinColor.ink)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			FlowTagChips(tags: store.tags, selection: Binding(get: { store.tagFilter }, set: { store.tagFilter = $0 }))
		}
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
				header
				LazyVGrid(
					columns: sizeClass == .regular
						? Array(repeating: GridItem(.flexible(), spacing: MaskinSpace.s9, alignment: .top), count: 2)
						: [GridItem(.adaptive(minimum: 340, maximum: 520), spacing: MaskinSpace.s9, alignment: .top)],
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
			header
				.listRowInsets(EdgeInsets(top: 0, leading: MaskinSpace.s9, bottom: MaskinSpace.s4, trailing: MaskinSpace.s9))
				.listRowSeparator(.hidden)
				.listRowBackground(Color.clear)
			ForEach(loops) { loop in
				card(loop)
				.tag(loop.id)
				.zoomSource(id: loop.id, in: zoomNamespace)
				.listRowSeparator(.hidden)
				.listRowBackground(Color.clear)
				.listRowInsets(
					EdgeInsets(
						top: MaskinSpace.s3, leading: MaskinSpace.s9, bottom: MaskinSpace.s3,
						trailing: MaskinSpace.s9))
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
				if store.needsYouOnly {
					// The pill is on but every flow that needed you was handled meanwhile.
					EmptyState(symbol: "checkmark", title: "Nothing needs you right now") {
						Button("Show all flows") { store.needsYouOnly = false }.buttonStyle(.secondaryAction)
					}
				} else if store.runningOnly {
					EmptyState(symbol: "pause.circle", title: "No flows are running") {
						Button("Show all flows") { store.filter = .everything }.buttonStyle(.secondaryAction)
					}
				} else if search.isEmpty {
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

/// "All" and one chip per tag on any flow; hidden when no flow has a tag.
struct FlowTagChips: View {
	let tags: [String]
	@Binding var selection: String?

	var body: some View {
		if !tags.isEmpty {
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: MaskinSpace.s4) {
					AgentFilterChip(label: "All", selected: selection == nil) { selection = nil }
					ForEach(tags, id: \.self) { tag in
						AgentFilterChip(label: tag, selected: selection?.lowercased() == tag.lowercased()) {
							selection = tag
						}
					}
				}
			}
		}
	}
}
