import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Flows: a 2 x 2 grid of cards (ring, name, state), each opening a read-only detail.
struct TVFlows: View {
	let environment: AppEnvironment
	let loops: LoopsStore?
	let forYou: ForYouRuntime?
	@Binding var chromeHidden: Bool
	@Binding var openFlow: String?
	/// A decision on For you that a NEEDS YOU row asked to open.
	@Binding var openDecision: String?
	@State private var path: [String] = []

	/// The For you decision behind a flow post (matched by its event), else the first thing waiting.
	private func decide(_ postID: Int) {
		let needs = (forYou?.store.entries ?? []).filter { $0.section == .needs && $0.record == nil }
		let match = needs.first { $0.card.mention?.eventId == postID } ?? needs.first
		openDecision = match?.id
	}

	private var flows: [LoopSummary] { (loops?.loops ?? []).filter { $0.status != .draft } }
	private let columns = [GridItem(.flexible(), spacing: 40), GridItem(.flexible(), spacing: 40)]

	var body: some View {
		NavigationStack(path: $path) {
			ScrollView {
				VStack(alignment: .leading, spacing: 40) {
					VStack(alignment: .leading, spacing: 8) {
						Text("Flows").font(.system(size: 64, weight: .bold))
						if let subtitle = TVFlowsHeader.subtitle(for: flows) {
							Text(subtitle).font(.system(size: 30)).foregroundStyle(MaskinColor.ink4)
						}
					}
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
				.padding(.top, 24)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.ignoresSafeArea(edges: .horizontal)
			.navigationDestination(for: String.self) { id in
				if let loops, let flow = loops.loop(id: id) { TVFlowDetail(environment: environment, flow: flow, directory: loops.directory, onDecide: decide) }
			}
		}
		.onChange(of: path) { _, path in chromeHidden = !path.isEmpty }
		// A briefing's last slide can point at a flow; open it once the flows are in.
		.task(id: "\(openFlow ?? "")|\(flows.count)") {
			guard let id = openFlow, loops?.loop(id: id) != nil else { return }
			path = [id]
			openFlow = nil
		}
		#if DEBUG
		.task(id: flows.first?.id) {
			if ProcessInfo.processInfo.environment["MASKIN_DEMO_SCREEN"] == "flow", let id = flows.first?.id, path.isEmpty {
				path = [id]
			}
		}
		#endif
	}
}

struct TVRing: View {
	let progress: Double
	var paused = false
	var size: CGFloat = 84
	var lineWidth: CGFloat = 8
	/// Draws the percentage in the middle (the flow detail's large ring).
	var showsPercent = false

	var body: some View {
		ZStack {
			Circle().stroke(MaskinSurface.fill, lineWidth: lineWidth)
			Circle().trim(from: 0, to: progress)
				.stroke(paused ? MaskinColor.ink5 : MaskinColor.sigHi,
					style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
				.rotationEffect(.degrees(-90))
			if showsPercent {
				Text("\(Int((progress * 100).rounded()))%")
					.font(.system(size: size * 0.26, weight: .bold))
			}
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
						.font(.system(size: 24, weight: .semibold, design: .monospaced))
						.padding(.horizontal, 16).padding(.vertical, 6)
						.background(MaskinSurface.inverse, in: Capsule())
						.foregroundStyle(MaskinSurface.onInverse)
				}
				// Decision 1: the latest update as one line of secondary text; stats live in the detail.
				if let latest = flow.content.flatMap(WatchSnapshotBuilder.latestSentence) {
					Text(latest).font(.system(size: 24)).foregroundStyle(MaskinColor.ink3).lineLimit(2)
				}
				if let target = flow.targets?.first {
					Text("\(target.label) \(Int(target.actual)) of \(Int(target.target))")
						.font(.system(size: 24, weight: .semibold, design: .monospaced))
						.foregroundStyle(MaskinColor.ink4).lineLimit(1)
				}
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
	let onDecide: (Int) -> Void
	@State private var tab: Tab = .outcome
	@Environment(\.dismiss) private var dismiss

	enum Tab: String, CaseIterable, Identifiable {
		case outcome = "Outcome", actions = "Actions", activity = "Activity"
		var id: String { rawValue }
	}

	init(environment: AppEnvironment, flow: LoopSummary, directory: ActorDirectory, onDecide: @escaping (Int) -> Void = { _ in }) {
		self.onDecide = onDecide
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
		.ignoresSafeArea()
		.task { await store.start() }
		.onDisappear { store.stop() }
	}

	private var header: some View {
		HStack(spacing: 40) {
			TVRing(progress: flow.ringProgress, paused: flow.isPaused, size: 170, lineWidth: 14, showsPercent: true)
			VStack(alignment: .leading, spacing: 8) {
				Text(flow.displayName).font(.system(size: 64, weight: .bold)).lineLimit(2)
				Text(store.verdict).font(.system(size: 34)).foregroundStyle(MaskinColor.ink4)
			}
			Spacer(minLength: 0)
			Button { dismiss() } label: {
				Label("Back", systemImage: "chevron.left").font(.system(size: 34, weight: .semibold))
					.foregroundStyle(MaskinColor.ink3).padding(.horizontal, 28).frame(minHeight: 80)
			}
			.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 40))
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
		HStack(alignment: .top, spacing: 32) {
			if let target = flow.targets?.first { targetCard(target) }
			stat("\(flow.inProgressCount)", "In motion")
			stat("\(flow.closedCount)", "Closed")
			stat("\(flow.waitingCount)", "Needs you")
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
				Button { onDecide(post.id) } label: { row(title: post.text, trailing: "Decide ›") }
					.buttonStyle(TVFocusStyle(scale: 1.02, cornerRadius: 28))
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
				HStack(spacing: 24) {
					if let name = store.actorName(entry) {
						Text(String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased())
							.font(.system(size: 24, weight: .bold)).foregroundStyle(MaskinColor.avFg)
							.frame(width: 56, height: 56)
							.background(MaskinGradient.avatar, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
							.accessibilityHidden(true)
					}
					VStack(alignment: .leading, spacing: 6) {
						Text(entry.description ?? entry.action.replacingOccurrences(of: "_", with: " "))
							.font(.system(size: 28, weight: .semibold)).lineLimit(2)
						HStack(spacing: 12) {
							if let name = store.actorName(entry) { Text(name) }
							if let when = entry.createdAt { RelativeTime(when, style: .compact) }
						}
						.font(.system(size: 24)).foregroundStyle(MaskinColor.ink4)
					}
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
			Text(value).font(.system(size: 56, weight: .bold))
			Text(label).font(.system(size: 26)).foregroundStyle(MaskinColor.ink4)
			Spacer(minLength: 0)
		}
		.padding(32)
		.frame(width: 240, height: 340, alignment: .topLeading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 40, style: .continuous))
	}

	/// The flow's first measurable target: where it stands, what it counts, and progress to the goal.
	private func targetCard(_ target: LoopTarget) -> some View {
		VStack(alignment: .leading, spacing: 18) {
			label("TARGET")
			Text("\(Int(target.actual)) / \(Int(target.target))").font(.system(size: 88, weight: .bold))
			Text(target.label).font(.system(size: 32)).foregroundStyle(MaskinColor.ink2)
			Capsule().fill(MaskinSurface.fill).frame(height: 14)
				.overlay(alignment: .leading) {
					GeometryReader { proxy in
						Capsule().fill(MaskinColor.sigHi).frame(width: proxy.size.width * target.fraction)
					}
				}
			Spacer(minLength: 0)
		}
		.padding(42)
		.frame(maxWidth: .infinity, minHeight: 340, alignment: .topLeading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 40, style: .continuous))
	}
}
