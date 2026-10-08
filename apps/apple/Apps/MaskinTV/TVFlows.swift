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
				if let loops, let flow = loops.loop(id: id) { TVFlowDetail(environment: environment, flow: flow, directory: loops.directory) }
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

/// A flow on the big screen, read only: Outcome, Actions and Activity as focusable tabs. Deciding
/// goes through For you; changing a flow stays on the iPhone and iPad.
struct TVFlowDetail: View {
	@State private var store: LoopDetailStore
	@State private var tab: Tab = .outcome

	enum Tab: String, CaseIterable, Identifiable {
		case outcome = "Outcome", actions = "Actions", activity = "Activity"
		var id: String { rawValue }
	}

	init(environment: AppEnvironment, flow: LoopSummary, directory: ActorDirectory) {
		let credentials = environment.auth.credentialsProvider
		_store = State(
			initialValue: LoopDetailStore(
				loop: flow, directory: directory,
				api: APILoopsSource(
					client: environment.client, workspaceID: environment.workspaceId ?? "",
					objects: APIObjectsRemote(client: environment.client, credentials: credentials),
					files: APIFilesRemote(client: environment.client, credentials: credentials)),
				events: environment.events))
	}

	private var flow: LoopSummary { store.loop }

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 40) {
				header
				tabs
				switch tab {
				case .outcome: outcome
				case .actions: actions
				case .activity: activity
				}
			}
			.padding(.horizontal, 96)
			.padding(.top, 56)
			.padding(.bottom, 56)
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.task { await store.start() }
		.onDisappear { store.stop() }
	}

	private var header: some View {
		HStack(spacing: 40) {
			TVRing(progress: flow.ringProgress, paused: flow.isPaused, size: 170, lineWidth: 14)
			VStack(alignment: .leading, spacing: 12) {
				Text(flow.displayName).font(.system(size: 64, weight: .bold)).lineLimit(2)
				Text("\(Int(flow.ringProgress * 100))% · \(store.verdict)")
					.font(.system(size: 32)).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	private var tabs: some View {
		HStack(spacing: 16) {
			ForEach(Tab.allCases) { item in
				Button { tab = item } label: {
					Text(item.rawValue)
						.font(.system(size: 30, weight: tab == item ? .bold : .regular))
						.padding(.horizontal, 36).frame(minHeight: 80)
						.background(tab == item ? MaskinSurface.fillStrong : Color.clear, in: Capsule())
				}
				.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 40))
			}
		}
	}

	// MARK: Outcome

	@ViewBuilder private var outcome: some View {
		HStack(spacing: 32) {
			stat("\(flow.inProgressCount)", "in motion")
			stat("\(flow.closedCount)", "closed")
			stat("\(flow.waitingCount)", "need you")
		}
		if let content = flow.content?.trimmingCharacters(in: .whitespacesAndNewlines), !content.isEmpty {
			Text(content).font(.system(size: 30)).foregroundStyle(MaskinColor.ink3)
				.frame(maxWidth: 1200, alignment: .leading)
		}
		if !store.outputs.isEmpty {
			label("WHAT IT PRODUCES")
			ForEach(store.outputs.prefix(6)) { output in
				row(title: output.name, trailing: output.isHTML ? "Page" : "PDF")
			}
		}
	}

	// MARK: Actions

	@ViewBuilder private var actions: some View {
		let asks = store.posts.filter(\.isDecision)
		label("NEEDS YOU")
		if asks.isEmpty {
			Text("Nothing needs you on this flow right now.").font(.system(size: 30)).foregroundStyle(MaskinColor.ink4)
		} else {
			ForEach(asks.prefix(5)) { post in
				row(title: post.text, trailing: "Decide on iPhone or Watch")
			}
		}
		if !store.steps.isEmpty {
			label("IN MOTION")
			ForEach(store.steps) { step in
				row(title: step.name ?? "Step", trailing: step.agentName ?? "")
			}
		}
	}

	// MARK: Activity

	@ViewBuilder private var activity: some View {
		if store.activity.isEmpty {
			Text("No activity yet.").font(.system(size: 30)).foregroundStyle(MaskinColor.ink4)
		} else {
			ForEach(store.activity.prefix(12)) { entry in
				VStack(alignment: .leading, spacing: 6) {
					Text(entry.description ?? entry.action.replacingOccurrences(of: "_", with: " "))
						.font(.system(size: 28, weight: .semibold)).lineLimit(2)
					HStack(spacing: 12) {
						if let name = store.actorName(entry) { Text(name) }
						if let when = entry.createdAt { RelativeTime(when, style: .compact) }
					}
					.font(.system(size: 24)).foregroundStyle(MaskinColor.ink4)
				}
				.padding(.horizontal, 32).padding(.vertical, 20)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
				.focusable()
			}
		}
	}

	// MARK: Pieces

	private func label(_ text: String) -> some View {
		Text(text).font(.system(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
	}

	private func row(title: String, trailing: String) -> some View {
		HStack(spacing: 24) {
			Text(title).font(.system(size: 30, weight: .semibold)).lineLimit(2)
			Spacer(minLength: 0)
			if !trailing.isEmpty { Text(trailing).font(.system(size: 26)).foregroundStyle(MaskinColor.ink4) }
		}
		.padding(.horizontal, 32).padding(.vertical, 22)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
		.focusable()
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
