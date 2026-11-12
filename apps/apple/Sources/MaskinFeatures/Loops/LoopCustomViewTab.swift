import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One custom view of a loop, full width in its own tab: the agent-built page with live numbers.
/// If the page cannot be shown the tab says why in plain words and offers Try again. Same words as
/// the web loop page.
struct LoopCustomViewTab: View {
	let view: LoopView
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.scenePhase) private var scenePhase
	@State private var model: LoopCustomViewModel?
	@State private var isRetrying = false

	var body: some View {
		Group {
			if let model {
				LoopCustomViewBody(model: model, isRetrying: isRetrying) { retry(model) }
			} else if runtime != nil {
				LoadingSkeleton(rows: 6)
			} else {
				LoopBlockError(message: "Views aren't available here.", onRetry: {})
			}
		}
		.task {
			guard model == nil, let environment = runtime?.environment else { return }
			let made = LoopCustomViewModel(
				fileID: view.fileID,
				files: APIFilesRemote(client: environment.client, credentials: environment.auth.credentialsProvider),
				queries: URLSessionLoopDataQuery(
					baseURL: environment.baseURL, clientSource: environment.clientSource,
					credentials: environment.auth.credentialsProvider))
			model = made
			await made.load()
		}
		// Every 30 seconds while the tab is open and the app is in front.
		.task(id: scenePhase == .active && model != nil) {
			guard scenePhase == .active, let model else { return }
			while !Task.isCancelled {
				try? await Task.sleep(for: LoopCustomViewModel.refreshEvery)
				if Task.isCancelled { return }
				await model.refresh()
			}
		}
	}

	private func retry(_ model: LoopCustomViewModel) {
		guard !isRetrying else { return }
		isRetrying = true
		Task {
			await model.load()
			isRetrying = false
		}
	}
}

private struct LoopCustomViewBody: View {
	let model: LoopCustomViewModel
	let isRetrying: Bool
	let onRetry: () -> Void

	var body: some View {
		switch model.phase {
		case .loading:
			LoadingSkeleton(rows: 6)
		case .failed(let message):
			LoopBlockError(message: message, isRetrying: isRetrying, onRetry: onRetry)
		case .ready:
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				status
				if let document = model.document {
					LoopViewWebView(model: model, document: document, generation: model.generation)
						.frame(height: model.height)
						.frame(maxWidth: .infinity)
						.background(MaskinSurface.card)
						.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
						.overlay(
							RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)
								.strokeBorder(MaskinSurface.line, lineWidth: 1)
						)
						.accessibilityIdentifier("loop-custom-view")
				}
			}
		}
	}

	/// When the numbers were fetched, and what is wrong with them if anything. Shown by the app,
	/// outside the page, so a view cannot hide it.
	@ViewBuilder
	private var status: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			if let updatedAt = model.updatedAt {
				HStack(spacing: MaskinSpace.s1) {
					Text("Updated").maskinText(.caption).foregroundStyle(MaskinColor.ink5)
					RelativeTime(updatedAt, style: .compact).maskinText(.caption).foregroundStyle(MaskinColor.ink5)
				}
			}
			if model.partial {
				note(
					"Some numbers in this view are partial: the data hit its size limit, so counts may be lower than the real totals."
				)
			}
			if model.queryFailed { note("Some numbers in this view could not be loaded.") }
			if model.refreshFailed {
				note("Live updates are failing, so this view may be out of date.")
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
	}

	private func note(_ text: String) -> some View {
		Text(text).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			.fixedSize(horizontal: false, vertical: true)
	}
}
