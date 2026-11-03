import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Flows, read only: the ones that need the wearer first, each with a ring; the rest fold into one
/// quiet row. A summary on tap.
struct WatchFlows: View {
	let flows: [WatchSnapshot.Flow]
	/// False while the first load is still on its way, so "No flows yet" is not shown prematurely.
	let loaded: Bool
	/// The live feed, so a flow that needs the wearer can open its decision; nil offline.
	let store: ForYouStore?
	/// The flow a complication asked to open, by id; cleared once it is showing.
	@Binding var openFlow: String?

	@State private var showOnTrack = false

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
					WatchPageTitle(title: "Flows", count: WatchFlowsLayout.needsYou(flows).count)
					if flows.isEmpty, loaded {
						EmptyState(symbol: "arrow.triangle.2.circlepath", title: "No flows yet")
					}
					ForEach(WatchFlowsLayout.needsYou(flows)) { flow in link(flow) }
					let onTrack = WatchFlowsLayout.onTrack(flows)
					if !onTrack.isEmpty {
						Button { showOnTrack.toggle() } label: {
							Text(WatchFlowsLayout.onTrackLabel(count: onTrack.count, othersNeedYou: flows.contains(where: \.needsYou)))
								.font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
								.frame(maxWidth: .infinity, minHeight: WatchMetrics.target)
								.contentShape(Rectangle())
						}
						.buttonStyle(.plain)
						if showOnTrack { ForEach(onTrack) { flow in link(flow) } }
					}
				}
				.padding(.horizontal, MaskinSpace.s1)
			}
			.toolbar(.hidden, for: .navigationBar)
			.containerBackground(for: .navigation) { WatchBackdrop() }
			.navigationDestination(item: $openFlow) { id in
				if let flow = flows.first(where: { $0.id == id }) { WatchFlowSummary(flow: flow, store: store) }
			}
		}
	}

	private func link(_ flow: WatchSnapshot.Flow) -> some View {
		NavigationLink {
			WatchFlowSummary(flow: flow, store: store)
		} label: { row(flow) }
			.buttonStyle(.plain)
	}

	private func row(_ flow: WatchSnapshot.Flow) -> some View {
		HStack(spacing: MaskinSpace.gapLoose) {
			WatchRing(progress: flow.progress, paused: flow.paused, size: 36)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(flow.name).font(WatchType.row()).foregroundStyle(MaskinColor.ink).lineLimit(1)
				Text(flow.needsYou ? "Needs you" : "On track")
					.font(WatchType.caption())
					.foregroundStyle(flow.needsYou ? MaskinColor.sigHi : MaskinColor.ink4)
			}
			Spacer(minLength: 0)
		}
		.padding(.horizontal, MaskinSpace.s8).padding(.vertical, MaskinSpace.s7)
		.frame(minHeight: WatchMetrics.target)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.contentShape(Rectangle())
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
