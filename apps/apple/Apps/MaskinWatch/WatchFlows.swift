import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Flows, read only: a ring and a one-line state per flow, a summary on tap.
struct WatchFlows: View {
	let loops: LoopsStore?

	private var live: [LoopSummary] {
		(loops?.loops ?? []).filter { $0.status != .draft }
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 8) {
					WatchPageTitle(title: "Flows")
					if let loops, live.isEmpty, loops.phase == .loaded {
						EmptyState(symbol: "arrow.triangle.2.circlepath", title: "No flows yet")
					}
					ForEach(live) { flow in
						NavigationLink {
							WatchFlowSummary(flow: flow)
						} label: { row(flow) }
							.buttonStyle(.plain)
					}
				}
				.padding(.horizontal, 2)
			}
			.toolbar(.hidden, for: .navigationBar)
			.containerBackground(for: .navigation) { WatchBackdrop() }
		}
	}

	private func row(_ flow: LoopSummary) -> some View {
		HStack(spacing: 12) {
			WatchRing(progress: flow.ringProgress, paused: flow.status == .paused, size: 36)
			VStack(alignment: .leading, spacing: 2) {
				Text(flow.name ?? "Untitled").font(WatchType.row()).foregroundStyle(MaskinColor.ink).lineLimit(1)
				Text(flow.waitingCount > 0 ? "Needs you" : "On track")
					.font(WatchType.caption())
					.foregroundStyle(flow.waitingCount > 0 ? MaskinColor.sigHi : MaskinColor.ink4)
			}
			Spacer(minLength: 0)
		}
		.padding(.horizontal, 14).padding(.vertical, 12)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
	}
}

private struct WatchFlowSummary: View {
	let flow: LoopSummary

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 10) {
				HStack(spacing: 12) {
					WatchRing(progress: flow.ringProgress, paused: flow.status == .paused, size: 56)
					Text("\(Int(flow.ringProgress * 100))%").font(WatchType.title()).foregroundStyle(MaskinColor.ink)
				}
				Text(flow.name ?? "Untitled").font(WatchType.question()).foregroundStyle(MaskinColor.ink)
				Text(flow.pill.label.uppercased()).font(WatchType.microMono()).foregroundStyle(MaskinColor.ink4)
				Text("\(flow.inProgressCount) in motion · \(flow.closedCount) closed")
					.font(WatchType.caption()).foregroundStyle(MaskinColor.ink3)
				if let latest = flow.content, !latest.isEmpty {
					Text(latest).font(WatchType.caption()).foregroundStyle(MaskinColor.ink3).lineLimit(5)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
		.navigationTitle("Flow")
	}
}

/// The Patina progress ring: the gradient stroke, grey when the flow is paused.
struct WatchRing: View {
	let progress: Double
	let paused: Bool
	let size: CGFloat

	var body: some View {
		ZStack {
			Circle().stroke(MaskinSurface.fillStrong, lineWidth: 4)
			Circle().trim(from: 0, to: max(0.02, progress))
				.stroke(
					paused ? AnyShapeStyle(MaskinGradient.ringPaused) : AnyShapeStyle(MaskinGradient.ring),
					style: StrokeStyle(lineWidth: 4, lineCap: .round)
				)
				.rotationEffect(.degrees(-90))
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}
