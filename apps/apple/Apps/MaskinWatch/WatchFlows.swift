import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Flows, read only: a ring and a one-line state per flow, a summary on tap.
struct WatchFlows: View {
	let flows: [WatchSnapshot.Flow]
	/// False while the first load is still on its way, so "No flows yet" is not shown prematurely.
	let loaded: Bool

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
					WatchPageTitle(title: "Flows", count: flows.filter(\.needsYou).count)
					if flows.isEmpty, loaded {
						EmptyState(symbol: "arrow.triangle.2.circlepath", title: "No flows yet")
					}
					ForEach(flows) { flow in
						NavigationLink {
							WatchFlowSummary(flow: flow)
						} label: { row(flow) }
							.buttonStyle(.plain)
					}
				}
				.padding(.horizontal, MaskinSpace.s1)
			}
			.toolbar(.hidden, for: .navigationBar)
			.containerBackground(for: .navigation) { WatchBackdrop() }
		}
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

/// Ring %, cycle · stage, the first target and the latest update. Read only.
private struct WatchFlowSummary: View {
	let flow: WatchSnapshot.Flow

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				HStack(spacing: MaskinSpace.gapLoose) {
					WatchRing(progress: flow.progress, paused: flow.paused, size: 56)
					Text("\(Int((flow.progress * 100).rounded()))%").font(WatchType.title()).foregroundStyle(MaskinColor.ink)
				}
				Text(flow.name).font(WatchType.question()).foregroundStyle(MaskinColor.ink)
				Text(flow.cycleStage).font(WatchType.microMono()).foregroundStyle(MaskinColor.ink4)
				Text(flow.needsYou ? "NEEDS YOU" : "ON TRACK")
					.font(WatchType.microMono()).tracking(0.6)
					.foregroundStyle(flow.needsYou ? MaskinColor.sigHi : MaskinColor.ink4)
				if let target = flow.target {
					Text(target).font(WatchType.row()).foregroundStyle(MaskinColor.ink2)
				}
				if let latest = flow.latest {
					Text(latest).font(WatchType.caption()).foregroundStyle(MaskinColor.ink3).lineLimit(5)
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
