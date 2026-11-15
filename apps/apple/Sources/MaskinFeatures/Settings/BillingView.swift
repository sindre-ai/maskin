import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Billing (2C): the plan, its state and this period's usage, read-only. Owners get the mockup's
/// "Manage on web" button; there is no in-app purchase. Whether App Review 3.1.1 accepts that link
/// is the open question from the D2 report: pass `manageURL: nil` to drop it.
struct BillingView: View {
	@State private var store: BillingStore
	@Environment(\.openURL) private var openURL
	/// The web billing page, set only for owners (2C: non-owners see the summary without the button).
	private let manageURL: URL?

	init(store: BillingStore, manageURL: URL? = nil) {
		_store = State(initialValue: store)
		self.manageURL = manageURL
	}

	var body: some View {
		WorkspacePage(title: "Billing") {
			if let usage = store.usage {
				if store.percentDisplay, let banner = Self.limitBanner(usage) {
					PlanLimitBanner(
						title: banner.title, detail: banner.detail,
						actionTitle: manageURL == nil ? nil : banner.action
					) {
						if let manageURL { openURL(manageURL) }
					}
				} else if let banner = Self.trialBanner(usage) {
					TrialBanner(title: banner.title, detail: banner.detail, actionTitle: manageURL == nil ? nil : "Choose") {
						if let manageURL { openURL(manageURL) }
					}
				}
				PageGroupLabel(text: "Plan")
				PageCard(rows: rows(usage))
				if store.percentDisplay {
					percentMeter(usage)
				} else if let cap = usage.capCents, let fraction = usage.usedFraction {
					UsageMeter(
						title: "Credits this month", used: BillingUsage.dollars(usage.usedCents),
						of: BillingUsage.dollars(cap), fraction: fraction)
					if let manageURL {
						Button("Buy credits") { openURL(manageURL) }.buttonStyle(.secondaryAction)
					}
				}
				PageFootnote(
					text: "Usage by model, agent and flow is not in the app yet. This is a summary of your plan and this period's usage.")
				if let manageURL, usage.usedFraction == nil {
					Button("Manage on web") { openURL(manageURL) }.buttonStyle(.primaryAction)
				}
			} else {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				default: PageStatus(text: "Loading your plan")
				}
			}
		}
		.task { await store.load() }
		.refreshable { await store.load() }
	}

	/// The percent view: "N% of plan used", a meter, and what happens at 100%. No dollars, no tokens.
	@ViewBuilder
	private func percentMeter(_ usage: BillingUsage) -> some View {
		if let text = usage.percentText, let percent = usage.percent, let tone = usage.percentTone {
			PlanPercentMeter(
				text: text, percent: percent, tone: tone,
				caption: Self.percentCaption(usage))
		} else if usage.plan != "enterprise" {
			PageStatus(text: "Usage is unavailable right now. We do not show a figure because none is known.")
		}
	}

	private func rows(_ usage: BillingUsage) -> [PageRowModel] {
		let healthy = usage.status == .active
		var rows = [
			PageRowModel(
				id: "plan", title: "Plan",
				subtitle: [usage.statusLabel, usage.resetsText].compactMap { $0 }.joined(separator: " · "),
				accessory: .state(PageState(usage.planLabel, healthy ? .active : .muted)))
		]
		// The percent view shows usage in its own meter below, never as dollars.
		if store.percentDisplay { return rows }
		let spent = BillingUsage.dollars(usage.usedCents)
		if let fraction = usage.usedFraction, let cap = usage.capCents {
			rows.append(
				PageRowModel(
					id: "usage", title: "Agent usage",
					subtitle: "\(spent) of \(BillingUsage.dollars(cap)) this period",
					accessory: .state(PageState("\(Int(fraction * 100))%", .plain))))
		} else {
			rows.append(
				PageRowModel(
					id: "usage", title: "Agent usage", subtitle: "This period",
					accessory: .state(PageState(spent, .plain))))
		}
		// Invoices, auto top-up and the credit balance have no usable API field yet (the balance has
		// no currency), so those rows stay hidden.
		return rows
	}
}

extension BillingView {
	/// "Trial ends in 5 days" while on a trial; nil on any paid plan.
	static func trialBanner(_ usage: BillingUsage) -> (title: String, detail: String)? {
		guard usage.plan == "trial", usage.status == .active else { return nil }
		let detail = "Choose a plan to keep your agents running."
		// No end date from the server is not the same as an ended trial: say only what is known.
		guard let ms = usage.resetsInMs else { return ("You are on a trial", detail) }
		guard ms > 0 else { return ("Your trial has ended", detail) }
		let days = Int((Double(ms) / 86_400_000).rounded(.up))
		return ("Trial ends in \(days) \(days == 1 ? "day" : "days")", detail)
	}

	/// The line under the meter: the 80% warning, else when the usage resets.
	static func percentCaption(_ usage: BillingUsage, now: Date = Date()) -> String? {
		if let percent = usage.percent, percent >= BillingUsage.warnPercent {
			return "Work will wait at 100%. Choose a plan to keep going."
		}
		if usage.plan == "trial" { return "Resets when your trial ends." }
		return usage.periodEndLabel(now: now).map { "Resets \($0)" }
	}

	/// The 100% screen: the banner sentence, the paused notice and the button label. Nil unless the
	/// plan is used up and nothing lets new work start.
	static func limitBanner(_ usage: BillingUsage, now: Date = Date()) -> (title: String, detail: String, action: String)? {
		guard usage.isPaused else { return nil }
		let copy = usage.limitCopy(now: now)
		return (copy.banner, copy.notice, copy.button)
	}
}

/// The trial notice at the top of Billing (the same words the app-wide banner uses).
private struct TrialBanner: View {
	let title: String
	let detail: String
	let actionTitle: String?
	let action: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s8) {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(title)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.ink)
				Text(detail)
					.font(MaskinTypeface.sans(MaskinFontSize.t13))
					.foregroundStyle(MaskinColor.ink3)
			}
			Spacer(minLength: MaskinSpace.s4)
			if let actionTitle {
				Button(actionTitle, action: action).buttonStyle(.secondaryAction)
			}
		}
		.padding(MaskinSpace.s9)
		.background(MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .combine)
	}
}

/// A used-of-total line with a bar underneath.
private struct UsageMeter: View {
	let title: String
	let used: String
	let of: String
	let fraction: Double

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			Text(title).maskinText(.microLabelLarge).textCase(.uppercase).foregroundStyle(MaskinColor.ink4)
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
				Text(used)
					.font(MaskinTypeface.sans(MaskinFontSize.t20, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.ink)
				Text("of \(of)")
					.font(MaskinTypeface.sans(MaskinFontSize.t14))
					.foregroundStyle(MaskinColor.ink4)
			}
			ProgressView(value: fraction)
				.tint(fraction >= 0.9 ? MaskinColor.noticeFg3 : MaskinColor.sig)
		}
		.padding(MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .combine)
		.accessibilityValue("\(Int(fraction * 100)) percent used")
	}
}

/// The 100% notice: the plan is used up and agents are paused. Warning tint, an icon, and a way to
/// the plan picker (the web plan page) for people who can change the plan.
private struct PlanLimitBanner: View {
	let title: String
	let detail: String
	let actionTitle: String?
	let action: () -> Void

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s8) {
			Image(systemName: "exclamationmark.triangle.fill")
				.foregroundStyle(MaskinColor.warning)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				Text(title)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.warning)
				Text(detail)
					.font(MaskinTypeface.sans(MaskinFontSize.t13))
					.foregroundStyle(MaskinColor.ink3)
				if let actionTitle {
					Button(actionTitle, action: action).buttonStyle(.secondaryAction)
				}
			}
			Spacer(minLength: 0)
		}
		.padding(MaskinSpace.s9)
		.background(MaskinColor.warningTint, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .contain)
	}
}

/// "N% of plan used" with a bar. Colour follows the tone, and the number is always written, so
/// colour is never the only signal.
private struct PlanPercentMeter: View {
	let text: String
	let percent: Int
	let tone: BillingUsage.PercentTone
	let caption: String?

	private var tint: Color {
		switch tone {
		case .primary: MaskinColor.sig
		case .warning: MaskinColor.warning
		case .error: MaskinColor.danger
		}
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			Text("Plan usage").maskinText(.microLabelLarge).textCase(.uppercase).foregroundStyle(MaskinColor.ink4)
			Text(text)
				.font(MaskinTypeface.sans(MaskinFontSize.t20, weight: MaskinFontWeight.semibold))
				.foregroundStyle(MaskinColor.ink)
			ProgressView(value: Double(percent), total: 100)
				.tint(tint)
			if let caption {
				Text(caption)
					.font(MaskinTypeface.sans(MaskinFontSize.t13))
					.foregroundStyle(MaskinColor.ink3)
			}
		}
		.padding(MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .combine)
		.accessibilityValue("\(percent) percent used")
	}
}
