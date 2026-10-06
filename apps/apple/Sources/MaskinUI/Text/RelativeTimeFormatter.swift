import Foundation

/// Pure time formatting shared by `RelativeTime`; mirrors `relative-time.tsx` on the web.
public enum RelativeTimeFormatter {
	public enum Style: Sendable {
		/// "2h ago"
		case relative
		/// "2h" — age-column form; dates beyond `compactDayLimit` collapse to "Jan 15".
		case compact
		/// "08:44" today, "MON 14:12" within a week, "JUN 24" beyond.
		case clock
	}

	public static func string(
		for date: Date, now: Date = Date(), style: Style = .relative, compactDayLimit: Int = 30,
		calendar: Calendar = .current, locale: Locale = .current
	) -> String {
		switch style {
		case .relative: relative(date, now: now, calendar: calendar, locale: locale)
		case .compact: compact(date, now: now, dayLimit: compactDayLimit, calendar: calendar, locale: locale)
		case .clock: clock(date, now: now, calendar: calendar, locale: locale)
		}
	}

	private static func parts(_ date: Date, now: Date) -> (seconds: Int, minutes: Int, hours: Int, days: Int) {
		// Clamp so a date a few seconds in the future (clock skew) reads as "now".
		let seconds = max(0, Int(now.timeIntervalSince(date)))
		let minutes = seconds / 60
		let hours = minutes / 60
		return (seconds, minutes, hours, hours / 24)
	}

	static func relative(_ date: Date, now: Date, calendar: Calendar, locale: Locale) -> String {
		let p = parts(date, now: now)
		if p.seconds < 10 { return "now" }
		if p.seconds < 60 { return "\(p.seconds)s ago" }
		if p.minutes < 60 { return "\(p.minutes)m ago" }
		if p.hours < 24 { return "\(p.hours)h ago" }
		if p.days < 30 { return "\(p.days)d ago" }
		return format(date, template: "yMMMd", calendar: calendar, locale: locale)
	}

	static func compact(_ date: Date, now: Date, dayLimit: Int, calendar: Calendar, locale: Locale) -> String {
		let p = parts(date, now: now)
		if p.minutes < 1 { return "now" }
		if p.minutes < 60 { return "\(p.minutes)m" }
		if p.hours < 24 { return "\(p.hours)h" }
		if p.days < dayLimit { return "\(p.days)d" }
		return format(date, template: "MMMd", calendar: calendar, locale: locale)
	}

	static func clock(_ date: Date, now: Date, calendar: Calendar, locale: Locale) -> String {
		let time = format(date, template: "Hm", calendar: calendar, locale: locale)
		let days =
			calendar.dateComponents(
				[.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)
			).day ?? 0
		if days <= 0 { return time }
		if days <= 6 {
			return "\(format(date, template: "EEE", calendar: calendar, locale: locale).uppercased()) \(time)"
		}
		return format(date, template: "MMMd", calendar: calendar, locale: locale).uppercased()
	}

	private static func format(_ date: Date, template: String, calendar: Calendar, locale: Locale) -> String {
		let f = DateFormatter()
		f.calendar = calendar
		f.timeZone = calendar.timeZone
		f.locale = locale
		f.setLocalizedDateFormatFromTemplate(template)
		return f.string(from: date)
	}
}
