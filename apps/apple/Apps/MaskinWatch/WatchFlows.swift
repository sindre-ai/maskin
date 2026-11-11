import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Where the Flows page can push to.
enum WatchFlowsRoute: Hashable {
	/// The daily briefing, playing.
	case daily
	case flow(String)
}

/// Flows: one full-height card per page, swiped sideways and wrapping. The daily briefing comes
/// first and plays; a flow's card opens its summary. Each card is a big figure over what it counts.
struct WatchFlows: View {
	let flows: [WatchSnapshot.Flow]
	/// How many decisions wait on the wearer: the daily card's figure.
	let needsCount: Int
	/// False while the first load is still on its way, so an empty pager is not shown prematurely.
	let loaded: Bool
	/// The live feed, so a flow that needs the wearer can open its decision; nil offline.
	let store: ForYouStore?
	let watch: MaskinWatchStore
	/// What a complication or the wearer asked to open, cleared once it is showing.
	@Binding var route: WatchFlowsRoute?

	@State private var index = WatchFlows.startingIndex

	/// Design review only: `MASKIN_DEMO_CARD=1` opens that card, because a simulator cannot swipe.
	/// Always the first card in Release.
	private static var startingIndex: Int {
		#if DEBUG
			return max(0, ProcessInfo.processInfo.environment["MASKIN_DEMO_CARD"].flatMap(Int.init) ?? 0)
		#else
			return 0
		#endif
	}

	private var tiles: [WatchFlowsLayout.Tile] {
		WatchFlowsLayout.tiles(flows: flows, needsCount: needsCount)
	}

	var body: some View {
		let tiles = tiles
		let current = min(index, tiles.count - 1)
		NavigationStack {
			VStack(spacing: MaskinSpace.s3) {
				header(count: tiles.count, current: current)
				card(tiles[current])
			}
			.padding(.horizontal, MaskinSpace.s1)
			// A swipe pages; a tap on the card or the dots is not a swipe, so it opens or advances.
			.simultaneousGesture(
				DragGesture(minimumDistance: 30).onEnded { drag in
					guard abs(drag.translation.width) > abs(drag.translation.height) else { return }
					page(drag.translation.width < 0 ? 1 : -1, count: tiles.count)
				})
			.toolbar(.hidden, for: .navigationBar)
			.containerBackground(for: .navigation) { WatchBackdrop() }
			.navigationDestination(item: $route) { route in
				switch route {
				case .daily:
					WatchPlayer(store: store, watch: watch)
				case .flow(let id):
					if let flow = flows.first(where: { $0.id == id }) { WatchFlowSummary(flow: flow, store: store) }
				}
			}
		}
	}

	private func page(_ delta: Int, count: Int) {
		index = WatchFlowsLayout.wrapped(min(index, count - 1), by: delta, count: count)
	}

	/// "Flows" and one dot per card (the current one long); a tap on the dots moves to the next card.
	private func header(count: Int, current: Int) -> some View {
		HStack {
			Text("Flows").font(WatchType.title()).foregroundStyle(MaskinColor.ink)
			Spacer(minLength: 0)
			Button { page(1, count: count) } label: {
				HStack(spacing: MaskinSpace.s2) {
					ForEach(0..<count, id: \.self) { dot in
						Capsule()
							.fill(dot == current ? MaskinColor.ink : MaskinColor.ink.opacity(0.35))
							.frame(width: dot == current ? MaskinSpace.s7 : MaskinSpace.s2 + 1, height: MaskinSpace.s2 + 1)
					}
				}
				.frame(minHeight: WatchMetrics.target)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Next card, \(current + 1) of \(count)")
		}
		// Clear of the page indicator the Digital Crown draws on the right edge.
		.padding(.trailing, MaskinSpace.s5)
	}

	private func card(_ tile: WatchFlowsLayout.Tile) -> some View {
		Button {
			route = tile.flowID.map(WatchFlowsRoute.flow) ?? .daily
		} label: {
			VStack(alignment: .leading, spacing: 0) {
				Text(tile.big)
					.font(MaskinTypeface.sans(MaskinFontSize.t34, weight: .bold, relativeTo: .largeTitle))
					.tracking(-0.03 * MaskinFontSize.t34)
					.foregroundStyle(MaskinColor.stFg)
					.lineLimit(1)
					.minimumScaleFactor(0.5)
				Text(tile.caption)
					.font(WatchType.row())
					.foregroundStyle(MaskinColor.stLab)
					.multilineTextAlignment(.leading)
					.lineLimit(3)
					.padding(.top, MaskinSpace.s2)
				Spacer(minLength: 0)
				Text(tile.tag)
					.font(WatchType.microMono()).tracking(0.7)
					.foregroundStyle(MaskinColor.stLab)
					.lineLimit(1)
					.padding(.horizontal, MaskinSpace.s4).padding(.vertical, MaskinSpace.s2)
					.background(MaskinColor.pill, in: Capsule())
			}
			.padding(MaskinSpace.s7)
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
			.background(
				MaskinGradient.unseenBrief, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous)
			)
			.contentShape(RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		}
		.buttonStyle(.plain)
		.accessibilityLabel("\(tile.big) \(tile.caption), \(tile.tag)")
	}
}

/// Ring %, cycle · stage and the first target. "Review decision" opens what the flow is waiting on.
private struct WatchFlowSummary: View {
	let flow: WatchSnapshot.Flow
	let store: ForYouStore?

	/// The open decision about this flow, from the live feed.
	private var waiting: FeedEntry? {
		guard let store else { return nil }
		let open = store.entries.filter { $0.section == .needs && $0.record == nil }
		guard let id = WatchFlowsLayout.waitingCard(for: flow, objectTitles: open.map { (id: $0.id, title: $0.card.objectTitle) })
		else { return nil }
		return open.first { $0.id == id }
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				HStack(spacing: MaskinSpace.gapLoose) {
					WatchRing(progress: flow.progress, paused: flow.paused, size: 56)
					Text(WatchFlowsLayout.percent(flow.progress)).font(WatchType.title()).foregroundStyle(MaskinColor.ink)
				}
				Text(flow.name).font(WatchType.question()).foregroundStyle(MaskinColor.ink)
				Text(flow.cycleStage).font(WatchType.microMono()).tracking(0.6).textCase(.uppercase)
					.foregroundStyle(MaskinColor.ink4)
				Text(flow.needsYou ? "NEEDS YOU" : "ON TRACK")
					.font(WatchType.microMono()).tracking(0.6)
					.foregroundStyle(flow.needsYou ? MaskinColor.sigHi : MaskinColor.ink4)
				if let target = flow.target {
					Text(target).font(WatchType.row()).foregroundStyle(MaskinColor.ink2)
				}
				if let store, let waiting {
					NavigationLink {
						WatchDecisionPage(
							store: store, entry: waiting, workspaceId: nil, position: "1 of 1", next: nil)
					} label: { WatchCapsule(title: "Review decision", prominent: true) }
						.buttonStyle(.plain)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
		.navigationTitle("Flow")
	}
}

/// The Patina progress ring: the gradient stroke, grey when the flow is paused. Patina is signal
/// only, so the ring is the one place the accent is drawn.
struct WatchRing: View {
	let progress: Double
	let paused: Bool
	let size: CGFloat

	var body: some View {
		ZStack {
			Circle().stroke(MaskinSurface.fillStrong, lineWidth: WatchMetrics.ringStroke)
			Circle().trim(from: 0, to: max(0.02, progress))
				.stroke(
					paused ? AnyShapeStyle(MaskinGradient.ringPaused) : AnyShapeStyle(MaskinGradient.ring),
					style: StrokeStyle(lineWidth: WatchMetrics.ringStroke, lineCap: .round)
				)
				.rotationEffect(.degrees(-90))
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}
