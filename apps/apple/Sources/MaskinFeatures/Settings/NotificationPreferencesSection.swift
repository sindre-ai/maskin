import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the server sends and when: categories, quiet hours, the daily briefing and per-workspace
/// mutes. Everything saves as it changes (optimistic; a refused change snaps back and says so).
struct NotificationPreferencesSection: View {
	let store: NotificationPreferencesStore
	/// Names only: the mute list never shows an id.
	let workspaces: [WorkspaceSummary]

	var body: some View {
		switch store.phase {
		case .idle, .loading:
			PageStatus(text: "Loading your notification settings\u{2026}")
		case .failed:
			VStack(spacing: MaskinSpace.s5) {
				PageStatus(text: "Couldn\u{2019}t load your notification settings.")
				Button("Try again") { Task { await store.load() } }
					.buttonStyle(.primaryAction)
			}
		case .loaded:
			loaded
		}
	}

	@ViewBuilder private var loaded: some View {
		if let error = store.error {
			Button { store.dismissError() } label: {
				Text(error)
					.font(MaskinTypeface.sans(MaskinFontSize.t13))
					.foregroundStyle(MaskinColor.noticeFg3)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(.horizontal, MaskinSpace.s7)
			}
			.buttonStyle(.maskinPressed)
			.accessibilityHint("Dismiss")
		}
		categories
		quietHours
		briefing
		if !workspaces.isEmpty { mutes }
	}

	// MARK: Categories

	private var categories: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			PageGroupLabel(text: "What to send")
			PageCard(rows: [
				// Needs you is not a switch: a decision that waits on you is the one thing this app
				// promises to deliver. Muting a whole workspace (below) is the only way to quiet it.
				PageRowModel(
					id: "needs_you", title: "Needs you",
					subtitle: "Decisions and questions from your agents",
					accessory: .state(PageState("Always on", .active))),
				toggleRow(.conversation, "Chat replies", "When someone answers you in a chat"),
				toggleRow(.digest, "Digests", "Summaries of what your agents got done"),
				toggleRow(.tips, "Tips and updates", "What\u{2019}s new in Maskin"),
			])
			PageFootnote(
				text: "Needs you is always delivered, even in quiet hours. To quiet a workspace, mute it below. Its decisions still arrive, but don\u{2019}t break through Focus.")
		}
	}

	private func toggleRow(_ category: NotificationPreferencesStore.Category, _ title: String, _ subtitle: String)
		-> PageRowModel
	{
		PageRowModel(
			id: category.rawValue, title: title, subtitle: subtitle,
			accessory: .toggle(
				isOn: store.isEnabled(category), set: { store.setCategory(category, enabled: $0) }))
	}

	// MARK: Quiet hours

	private var quietHours: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			PageGroupLabel(text: "Quiet hours")
			PreferenceCard {
				PageCard(rows: [
					PageRowModel(
						id: "quiet", title: "Quiet hours", subtitle: nil,
						accessory: .toggle(
							isOn: store.preferences.quietHours != nil,
							set: { store.setQuietHours(enabled: $0) }))
				])
				if let hours = store.preferences.quietHours {
					TimeRow(
						title: "From", minutes: hours.start,
						set: { store.setQuietHours(start: $0) })
					TimeRow(
						title: "Until", minutes: hours.end,
						set: { store.setQuietHours(end: $0) })
				}
			}
			PageFootnote(
				text: store.preferences.quietHours == nil
					? "Off. Pushes arrive whenever they happen."
					: "Chat replies, digests and tips wait until quiet hours end. Needs you still comes through.")
		}
	}

	// MARK: Daily briefing

	private var briefing: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			PageGroupLabel(text: "Daily briefing")
			PreferenceCard {
				PageCard(rows: [
					PageRowModel(
						id: "briefing", title: "Daily briefing", subtitle: "What needs you today, once a morning",
						accessory: .toggle(
							isOn: store.preferences.briefingEnabled, set: { store.setBriefing(enabled: $0) }))
				])
				if store.preferences.briefingEnabled {
					TimeRow(
						title: "Time", minutes: store.preferences.briefingTime,
						set: { store.setBriefingTime($0) })
				}
			}
			if store.preferences.briefingEnabled {
				PageFootnote(
					text: store.preferences.categories.digest
						? "Arrives at this time by your clock, wherever you are."
						: "Digests are off above, so the briefing won\u{2019}t be sent until you turn them on.")
			}
		}
	}

	// MARK: Mutes

	private var mutes: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			PageGroupLabel(text: "Workspaces")
			PageCard(
				rows: workspaces.map { workspace in
					let muted = store.isMuted(workspaceId: workspace.id)
					return PageRowModel(
						id: workspace.id, title: workspace.name,
						subtitle: muted ? "Muted" : "Notifications on",
						accessory: .toggle(
							isOn: !muted, set: { store.setMuted(!$0, workspaceId: workspace.id) }))
				})
			PageFootnote(
				text: "Turn a workspace off to stop its chat replies, digests and tips. Decisions that need you still arrive quietly.")
		}
	}
}

/// The grouped card chrome of `PageCard`, around rows that aren't `PageRowModel`s.
private struct PreferenceCard<Content: View>: View {
	@ViewBuilder let content: Content

	var body: some View {
		VStack(spacing: 0) { content }
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
	}
}

/// A label and a native time-of-day picker, in the page's row style.
private struct TimeRow: View {
	let title: String
	let minutes: Int
	let set: (Int) -> Void

	var body: some View {
		VStack(spacing: 0) {
			Rectangle().fill(MaskinSurface.separator).frame(height: 1)
				.padding(.leading, MaskinSpace.s9)
			DatePicker(
				selection: Binding(
					get: { MinuteOfDay.date(minutes: minutes) },
					set: { set(MinuteOfDay.minutes(from: $0)) }),
				displayedComponents: .hourAndMinute
			) {
				Text(title)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.ink)
			}
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s5)
			.frame(minHeight: MaskinSpace.touchMin)
		}
	}
}
