import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Flows: a 2 x 2 grid of cards (ring, name, state), each opening a read-only detail.
struct TVFlows: View {
	let environment: AppEnvironment
	let loops: LoopsStore?

	private var flows: [LoopSummary] { (loops?.loops ?? []).filter { $0.status != .draft } }
	private let columns = [GridItem(.flexible(), spacing: 40), GridItem(.flexible(), spacing: 40)]

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 40) {
					Text("Flows").font(.system(size: 64, weight: .bold))
					if let loops, flows.isEmpty, loops.phase == .loaded {
						EmptyState(symbol: "arrow.triangle.2.circlepath", title: "No flows yet")
					} else if loops == nil || (flows.isEmpty && loops?.phase != .loaded) {
						ProgressView().frame(maxWidth: .infinity, minHeight: 300)
					} else {
						LazyVGrid(columns: columns, spacing: 40) {
							ForEach(flows) { flow in
								NavigationLink(value: flow.id) { TVFlowCard(flow: flow) }
									.buttonStyle(TVFocusStyle())
							}
						}
						.padding(.vertical, 40)
					}
				}
				.padding(.horizontal, 96)
				.padding(.top, 56)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.navigationDestination(for: String.self) { id in
				if let flow = loops?.loop(id: id) { TVFlowDetail(flow: flow) }
			}
		}
	}
}

struct TVRing: View {
	let progress: Double
	var paused = false
	var size: CGFloat = 84
	var lineWidth: CGFloat = 8

	var body: some View {
		ZStack {
			Circle().stroke(MaskinSurface.fillStrong, lineWidth: lineWidth)
			Circle().trim(from: 0, to: progress)
				.stroke(paused ? MaskinColor.ink5 : MaskinColor.ink,
					style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
				.rotationEffect(.degrees(-90))
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}

private struct TVFlowCard: View {
	let flow: LoopSummary

	var body: some View {
		HStack(alignment: .top, spacing: 28) {
			TVRing(progress: flow.ringProgress, paused: flow.isPaused)
			VStack(alignment: .leading, spacing: 10) {
				Text(flow.displayName).font(.system(size: 30, weight: .bold)).lineLimit(2)
				Text(flow.pill.label).font(.system(size: 24)).foregroundStyle(MaskinColor.ink4)
				if flow.waitingCount > 0 {
					Text("NEEDS YOU")
						.font(.system(size: 22, weight: .semibold, design: .monospaced))
						.padding(.horizontal, 16).padding(.vertical, 6)
						.background(MaskinSurface.inverse, in: Capsule())
						.foregroundStyle(MaskinSurface.onInverse)
				}
				Text(flow.statsLine).font(.system(size: 24)).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
			Spacer(minLength: 0)
		}
		.padding(32)
		.frame(maxWidth: .infinity, minHeight: 220, alignment: .topLeading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
	}
}

struct TVFlowDetail: View {
	let flow: LoopSummary

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 40) {
				HStack(spacing: 40) {
					TVRing(progress: flow.ringProgress, paused: flow.isPaused, size: 200, lineWidth: 16)
					VStack(alignment: .leading, spacing: 12) {
						Text(flow.displayName).font(.system(size: 64, weight: .bold))
						Text("\(Int(flow.ringProgress * 100))% · \(flow.pill.label)")
							.font(.system(size: 32)).foregroundStyle(MaskinColor.ink4)
					}
				}
				HStack(spacing: 32) {
					stat("\(flow.inProgressCount)", "in motion")
					stat("\(flow.closedCount)", "closed")
					stat("\(flow.waitingCount)", "need you")
				}
				if let content = flow.content?.trimmingCharacters(in: .whitespacesAndNewlines), !content.isEmpty {
					Text(content).font(.system(size: 30)).foregroundStyle(MaskinColor.ink3)
						.frame(maxWidth: 1100, alignment: .leading)
				}
				// A read-only page: this focusable row keeps Menu going back and the remote usable.
				Button {} label: { TVCapsuleLabel(title: "Manage on iPhone or iPad", symbol: "iphone") }
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
					.frame(maxWidth: 640)
			}
			.padding(.horizontal, 96)
			.padding(.top, 56)
			.frame(maxWidth: .infinity, alignment: .leading)
		}
	}

	private func stat(_ value: String, _ label: String) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(value).font(.system(size: 48, weight: .bold))
			Text(label).font(.system(size: 24)).foregroundStyle(MaskinColor.ink4)
		}
		.padding(32)
		.frame(width: 280, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
	}
}
