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
			List {
				if let loops, live.isEmpty, loops.phase == .loaded {
					EmptyState(symbol: "arrow.triangle.2.circlepath", title: "No flows yet")
				}
				ForEach(live) { flow in
					NavigationLink {
						WatchFlowSummary(flow: flow)
					} label: {
						HStack(spacing: MaskinSpace.s4) {
							WatchRing(progress: flow.ringProgress, paused: flow.status == .paused, size: 36)
							VStack(alignment: .leading, spacing: 2) {
								Text(flow.name ?? "Untitled").font(.system(size: 14, weight: .semibold)).lineLimit(1)
								Text(flow.waitingCount > 0 ? "Needs you" : "On track")
									.font(.caption2)
									.foregroundStyle(flow.waitingCount > 0 ? MaskinColor.ink : MaskinColor.ink4)
							}
						}
					}
				}
			}
			.navigationTitle("Flows")
		}
	}
}

private struct WatchFlowSummary: View {
	let flow: LoopSummary

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				HStack(spacing: MaskinSpace.s4) {
					WatchRing(progress: flow.ringProgress, paused: flow.status == .paused, size: 56)
					Text("\(Int(flow.ringProgress * 100))%").font(.title3.weight(.bold))
				}
				Text(flow.name ?? "Untitled").font(.headline)
				Text(flow.status.label).font(.caption2.monospaced()).foregroundStyle(MaskinColor.ink4)
				Text("\(flow.inProgressCount) in motion · \(flow.closedCount) closed").font(.footnote)
				if let latest = flow.content, !latest.isEmpty {
					Text(latest).font(.footnote).foregroundStyle(MaskinColor.ink3).lineLimit(5)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.navigationTitle("Flow")
	}
}

extension LoopSummary {
	/// Share of the flow's work that has closed: the ring.
	var ringProgress: Double {
		let total = inProgressCount + closedCount
		return total == 0 ? 0 : Double(closedCount) / Double(total)
	}
}

private struct WatchRing: View {
	let progress: Double
	let paused: Bool
	let size: CGFloat

	var body: some View {
		ZStack {
			Circle().stroke(MaskinSurface.fillStrong, lineWidth: 4)
			Circle().trim(from: 0, to: progress)
				.stroke(paused ? MaskinColor.ink5 : MaskinColor.ink, style: StrokeStyle(lineWidth: 4, lineCap: .round))
				.rotationEffect(.degrees(-90))
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}
