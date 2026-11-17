import Foundation

/// A schedule of the shapes the Maskin apps generate themselves: hourly, daily, weekly or
/// monthly at a fixed time. A Swift port of `apps/web/src/lib/cron.ts` — anything outside those
/// shapes (steps, lists, ranges, day names, a restricted month) parses to `nil`, so callers show
/// the raw expression instead of a confidently wrong description.
///
/// The server evaluates every cron expression in **UTC** (`trigger-runner.ts`), so every hour,
/// weekday and day-of-month here is a UTC value, never the device's.
public struct CronSchedule: Equatable, Sendable {
	public enum Frequency: String, CaseIterable, Sendable, Identifiable {
		case hourly, daily, weekly, monthly
		public var id: String { rawValue }
		public var label: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
	}

	public var frequency: Frequency
	/// 0–59.
	public var minute: Int
	/// 0–23 (unused when hourly).
	public var hour: Int
	/// 0 = Sunday … 6 = Saturday (weekly only).
	public var dayOfWeek: Int
	/// 1–31 (monthly only).
	public var dayOfMonth: Int

	public init(
		frequency: Frequency = .daily, minute: Int = 0, hour: Int = 9, dayOfWeek: Int = 1,
		dayOfMonth: Int = 1
	) {
		self.frequency = frequency
		self.minute = minute
		self.hour = hour
		self.dayOfWeek = dayOfWeek
		self.dayOfMonth = dayOfMonth
	}

	static let dayNames = [
		"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
	]

	public static func dayName(_ index: Int) -> String {
		dayNames.indices.contains(index) ? dayNames[index] : "Monday"
	}

	// MARK: Parse

	/// Standard 5-field cron (`minute hour day-of-month month day-of-week`). A 6-field expression
	/// is accepted only when its leading seconds field is `0` (the same schedule); any other
	/// seconds value fires more often than a minute-resolution schedule can describe.
	public init?(expression: String) {
		let parts = expression.split(whereSeparator: \.isWhitespace).map(String.init)
		if parts.count == 6, parts[0] != "0" { return nil }
		let fields = parts.count == 6 ? Array(parts.dropFirst()) : parts
		guard fields.count == 5 else { return nil }
		let (minute, hour, dom, month, dow) = (fields[0], fields[1], fields[2], fields[3], fields[4])
		guard month == "*" else { return nil }
		guard Self.valid(minute, 0, 59), Self.valid(hour, 0, 23), Self.valid(dom, 1, 31),
			Self.valid(dow, 0, 7)
		else { return nil }
		let normalizedDow = dow == "7" ? "0" : dow
		// With both day fields restricted cron fires when EITHER matches (croner's default), which
		// neither the weekly nor the monthly shape describes.
		if normalizedDow != "*", dom != "*" { return nil }

		// A wildcard hour/minute would fire more than once inside the bucket the other fields
		// imply; the apps never generate that, so refuse rather than guess a time.
		if normalizedDow != "*" {
			guard hour != "*", minute != "*" else { return nil }
			self.init(
				frequency: .weekly, minute: Int(minute)!, hour: Int(hour)!,
				dayOfWeek: Int(normalizedDow)!)
		} else if dom != "*" {
			guard hour != "*", minute != "*" else { return nil }
			self.init(
				frequency: .monthly, minute: Int(minute)!, hour: Int(hour)!, dayOfMonth: Int(dom)!)
		} else if hour != "*" {
			guard minute != "*" else { return nil }
			self.init(frequency: .daily, minute: Int(minute)!, hour: Int(hour)!)
		} else {
			guard minute != "*" else { return nil }
			self.init(frequency: .hourly, minute: Int(minute)!)
		}
	}

	private static func valid(_ field: String, _ lo: Int, _ hi: Int) -> Bool {
		if field == "*" { return true }
		guard !field.isEmpty, field.allSatisfy(\.isASCII), field.allSatisfy(\.isNumber),
			let n = Int(field)
		else { return false }
		return (lo...hi).contains(n)
	}

	// MARK: Output

	/// The 5-field expression for this schedule.
	public var expression: String {
		switch frequency {
		case .hourly: "\(minute) * * * *"
		case .daily: "\(minute) \(hour) * * *"
		case .weekly: "\(minute) \(hour) * * \(dayOfWeek)"
		case .monthly: "\(minute) \(hour) \(dayOfMonth) * *"
		}
	}

	/// "5:00 PM"-style time, locale independent so summaries read the same everywhere. This is a
	/// UTC clock time; `summary` adds the zone. The schedule editor uses it because its hour picker
	/// writes UTC; lists use `describe`, which is Copenhagen time.
	public var timeLabel: String {
		let h12 = hour == 0 ? 12 : (hour > 12 ? hour - 12 : hour)
		let mm = minute < 10 ? "0\(minute)" : "\(minute)"
		return "\(h12):\(mm) \(hour < 12 ? "AM" : "PM")"
	}

	/// "every Sunday at 5:00 PM UTC".
	public var summary: String {
		switch frequency {
		case .hourly: "every hour at minute \(minute)"
		case .daily: "every day at \(timeLabel) UTC"
		case .weekly: "every \(Self.dayName(dayOfWeek)) at \(timeLabel) UTC"
		case .monthly: "on day \(dayOfMonth) of each month at \(timeLabel) UTC"
		}
	}

	// MARK: Copenhagen wording

	/// The calendar every schedule is shown in. The server runs schedules in UTC; the lists show
	/// Copenhagen time (summer and winter), like the web app.
	static let copenhagenCalendar: Calendar = {
		var c = Calendar(identifier: .gregorian)
		c.timeZone = TimeZone(identifier: "Europe/Copenhagen") ?? TimeZone(secondsFromGMT: 3600)!
		return c
	}()

	private static let monthNames = [
		"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
	]

	/// 24-hour `09:00`, locale independent.
	static func clock24(hour: Int, minute: Int) -> String {
		"\(hour < 10 ? "0" : "")\(hour):\(minute < 10 ? "0" : "")\(minute)"
	}

	/// "3 Nov at 09:00" in Copenhagen time. The year is added only when it is not the current one.
	public static func copenhagenDateTime(_ date: Date, now: Date = Date()) -> String {
		let calendar = copenhagenCalendar
		let at = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
		let year = at.year == calendar.component(.year, from: now) ? "" : " \(at.year ?? 0)"
		let month = monthNames.indices.contains((at.month ?? 1) - 1) ? monthNames[(at.month ?? 1) - 1] : ""
		return "\(at.day ?? 1) \(month)\(year) at \(clock24(hour: at.hour ?? 0, minute: at.minute ?? 0))"
	}

	/// "every Sunday at 18:00": the wording of `describe`, in Copenhagen time. The time is the one of
	/// the next firing after `now`, so summer and winter time are right, and a weekly or monthly
	/// schedule that lands on another day after the conversion takes that weekday or day number.
	/// `nil` when there is no next firing.
	public func copenhagenSummary(now: Date = Date()) -> String? {
		if frequency == .hourly { return "every hour at minute \(minute)" }
		guard let next = nextFire(after: now) else { return nil }
		let at = Self.copenhagenCalendar.dateComponents([.day, .weekday, .hour, .minute], from: next)
		guard let day = at.day, let weekday = at.weekday, let hour = at.hour, let minute = at.minute
		else { return nil }
		let time = Self.clock24(hour: hour, minute: minute)
		switch frequency {
		case .hourly: return nil
		case .daily: return "every day at \(time)"
		case .weekly: return "every \(Self.dayName(weekday - 1)) at \(time)"
		case .monthly: return "on day \(day) of each month at \(time)"
		}
	}

	/// A fixed day and month, e.g. `0 8 3 11 *`. The app treats it as a one-time date (UTC).
	private struct OneTime {
		var minute: Int, hour: Int, dayOfMonth: Int, month: Int

		init?(expression: String) {
			let parts = expression.split(whereSeparator: \.isWhitespace).map(String.init)
			if parts.count == 6, parts[0] != "0" { return nil }
			let fields = parts.count == 6 ? Array(parts.dropFirst()) : parts
			guard fields.count == 5, fields[4] == "*",
				CronSchedule.valid(fields[0], 0, 59), fields[0] != "*",
				CronSchedule.valid(fields[1], 0, 23), fields[1] != "*",
				CronSchedule.valid(fields[2], 1, 31), fields[2] != "*",
				CronSchedule.valid(fields[3], 1, 12), fields[3] != "*"
			else { return nil }
			minute = Int(fields[0])!
			hour = Int(fields[1])!
			dayOfMonth = Int(fields[2])!
			month = Int(fields[3])!
		}

		/// The next instant after `from`. Looks a few years ahead so 29 Feb still resolves; `nil`
		/// for a date that never exists (31 Nov).
		func nextFire(after from: Date) -> Date? {
			let calendar = CronSchedule.utcCalendar
			let year = calendar.component(.year, from: from)
			for y in year...(year + 8) {
				let parts = DateComponents(year: y, month: month, day: dayOfMonth, hour: hour, minute: minute)
				guard let candidate = calendar.date(from: parts) else { continue }
				let back = calendar.dateComponents([.month, .day], from: candidate)
				guard back.month == month, back.day == dayOfMonth else { continue }
				if candidate > from { return candidate }
			}
			return nil
		}
	}

	/// Human description of a raw expression in Copenhagen time, worded like the web list; the
	/// expression itself when it is outside the shapes this type models.
	public static func describe(_ expression: String, now: Date = Date()) -> String {
		if let schedule = CronSchedule(expression: expression) {
			return schedule.copenhagenSummary(now: now) ?? expression
		}
		if let once = OneTime(expression: expression), let next = once.nextFire(after: now) {
			return "once on \(copenhagenDateTime(next, now: now))"
		}
		return expression
	}

	/// The UTC calendar the server evaluates schedules in.
	public static let utcCalendar: Calendar = {
		var c = Calendar(identifier: .gregorian)
		c.timeZone = TimeZone(secondsFromGMT: 0)!
		return c
	}()

	/// The first firing strictly after `date`, computed in UTC like the server.
	public func nextFire(after date: Date, calendar: Calendar = CronSchedule.utcCalendar) -> Date? {
		var parts = DateComponents(minute: minute)
		switch frequency {
		case .hourly: break
		case .daily: parts.hour = hour
		case .weekly:
			parts.hour = hour
			parts.weekday = dayOfWeek + 1
		case .monthly:
			parts.hour = hour
			parts.day = dayOfMonth
		}
		// `.strict` skips months that lack the day (31st) rather than rolling into the next one.
		return calendar.nextDate(
			after: date, matching: parts, matchingPolicy: .strict, direction: .forward)
	}

	/// The next firing's clock time in the viewer's zone, e.g. "11:00 AM" or "11:00 AM, Tuesday"
	/// when the zone shifts the day. `nil` for hourly schedules (the minute is the same everywhere
	/// bar odd-offset zones) and when the viewer's zone matches UTC at that moment. Uses the offset
	/// in force at the next firing, so DST is accounted for.
	public func localEquivalent(
		after date: Date, timeZone: TimeZone = .current
	) -> String? {
		guard frequency != .hourly, let fire = nextFire(after: date) else { return nil }
		var local = Calendar(identifier: .gregorian)
		local.timeZone = timeZone
		let l = local.dateComponents([.hour, .minute, .weekday, .day], from: fire)
		let u = Self.utcCalendar.dateComponents([.day], from: fire)
		guard let lh = l.hour, let lm = l.minute, let lw = l.weekday, let ld = l.day,
			let ud = u.day
		else { return nil }
		if lh == hour && lm == minute && ld == ud { return nil }
		var label = Self.clock(hour: lh, minute: lm)
		if ld != ud {
			label += frequency == .monthly ? ", day \(ld)" : ", \(Self.dayName(lw - 1))"
		}
		return label
	}

	static func clock(hour: Int, minute: Int) -> String {
		let h12 = hour == 0 ? 12 : (hour > 12 ? hour - 12 : hour)
		return "\(h12):\(minute < 10 ? "0\(minute)" : "\(minute)") \(hour < 12 ? "AM" : "PM")"
	}
}
