import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A session's log: what the agent said and did (Readable), the untouched rows (Raw), or only
/// what went wrong (Problems). Follows the tail while the session is alive.
struct SessionLogsView: View {
	let store: SessionLogsStore
	let session: AgentSession

	var body: some View {
		VStack(spacing: 0) {
			Picker("View", selection: Bindable(store).filter) {
				ForEach(SessionLogFilter.allCases) { Text($0.rawValue).tag($0) }
			}
			.pickerStyle(.segmented)
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s5)
			if let notice = store.notice {
				Text(notice).maskinText(.caption).foregroundStyle(MaskinColor.danger)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(.horizontal, MaskinSpace.s9)
					.accessibilityLabel("Problem: \(notice)")
			}
			content
		}
		.background(MaskinSurface.grouped)
		.navigationTitle(session.prompt.isEmpty ? "Session log" : session.prompt)
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.task { await store.start(live: session.isActive) }
		.task(id: session.isActive) { await store.setLive(session.isActive) }
		.onDisappear { store.stop() }
		.refreshable { await store.refresh() }
	}

	@ViewBuilder private var content: some View {
		switch store.phase {
		case .idle, .loading:
			VStack(spacing: MaskinSpace.s5) {
				ForEach(0..<6, id: \.self) { _ in LoadingSkeleton() }
			}
			.padding(MaskinSpace.s9)
			.frame(maxHeight: .infinity, alignment: .top)
			.accessibilityLabel("Loading the log")
		case .failed(let message):
			EmptyState(symbol: "exclamationmark.triangle", title: "Couldn't load the log", message: message) {
				Button("Try again") { Task { await store.start(live: session.isActive) } }
					.buttonStyle(.secondaryAction)
			}
		case .loaded:
			loaded
		}
	}

	@ViewBuilder private var loaded: some View {
		if store.rows.isEmpty {
			EmptyState(
				symbol: "text.alignleft", title: "Nothing logged yet",
				message: session.isActive ? "Lines show up here as the agent works." : "This session wrote no log.")
		} else {
			ScrollViewReader { proxy in
				ScrollView {
					LazyVStack(alignment: .leading, spacing: MaskinSpace.s3) {
						SessionLogsLines(store: store)
						Color.clear.frame(height: 1).id("tail")
					}
					.padding(MaskinSpace.s9)
					.frame(maxWidth: 820, alignment: .leading)
					.frame(maxWidth: .infinity)
				}
				.onChange(of: store.rows.last?.id) { _, _ in
					if store.live { proxy.scrollTo("tail") }
				}
			}
		}
	}
}

private struct ReadableLogLine: View {
	let line: SessionLogLine

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
			Image(systemName: symbol).foregroundStyle(tint).frame(width: MaskinSpace.s9)
				.accessibilityHidden(true)
			Text(line.text)
				.maskinText(line.kind == .tool || line.kind == .system ? .caption : .subhead)
				.foregroundStyle(line.kind == .error ? MaskinColor.danger : MaskinColor.ink2)
				.textSelection(.enabled)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(spoken): \(line.text)")
	}

	private var symbol: String {
		switch line.kind {
		case .agent: "bubble.left"
		case .tool: "wrench.and.screwdriver"
		case .result: "checkmark.circle"
		case .error: "exclamationmark.triangle"
		case .system: "gearshape"
		case .output: "terminal"
		}
	}

	private var tint: Color {
		switch line.kind {
		case .error: MaskinColor.danger
		case .result: MaskinColor.success
		default: MaskinColor.ink4
		}
	}

	private var spoken: String {
		switch line.kind {
		case .agent: "Agent"
		case .tool: "Tool"
		case .result: "Result"
		case .error: "Error"
		case .system: "System"
		case .output: "Output"
		}
	}
}

private struct RawLogLine: View {
	let row: SessionLogRow

	var body: some View {
		Text(row.content)
			.maskinText(.mono)
			.foregroundStyle(row.stream == "stderr" ? MaskinColor.danger : MaskinColor.ink2)
			.textSelection(.enabled)
			.lineLimit(12)
			.frame(maxWidth: .infinity, alignment: .leading)
			.accessibilityLabel("\(row.stream) line: \(row.content)")
	}
}

/// The rows of the log under the filter picker, without a scroll container so a snapshot can draw them.
struct SessionLogsLines: View {
	let store: SessionLogsStore

	var body: some View {
		if store.hasOlder {
			Button {
				Task { await store.loadOlder() }
			} label: {
				if store.loadingOlder { ProgressView() } else { Text("Load earlier lines") }
			}
			.buttonStyle(.secondaryAction)
			.frame(maxWidth: .infinity)
		}
		switch store.filter {
		case .readable: ForEach(store.lines) { ReadableLogLine(line: $0) }
		case .problems:
			let problems = store.visibleRows.flatMap(SessionLogLine.lines(from:))
			if problems.isEmpty {
				Text("No problems in this log.").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			}
			ForEach(problems) { ReadableLogLine(line: $0) }
		case .raw: ForEach(store.rows, id: \.id) { RawLogLine(row: $0) }
		}
	}
}
