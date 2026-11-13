import postgres from 'postgres'

export type ConnectionSnapshotRow = {
	state: string | null
	wait_event_type: string | null
	wait_event: string | null
	connections: number
	longest_in_state_s: number | null
}

/**
 * What the database's own connections are doing right now, grouped by state and wait event.
 * Opens one connection of its own so it does not queue behind a pool that is full, and gives
 * up after `timeoutMs`. For the stall log: a pool stuck in `ClientRead` and a pool busy on
 * slow queries need different fixes, and only the database can tell them apart.
 */
export async function captureConnectionSnapshot(
	url: string,
	timeoutMs = 5_000,
): Promise<ConnectionSnapshotRow[]> {
	const client = postgres(url, { prepare: false, max: 1, connect_timeout: 5 })
	let timer: NodeJS.Timeout | undefined
	try {
		const query = client<ConnectionSnapshotRow[]>`
			select state, wait_event_type, wait_event,
				count(*)::int as connections,
				round(max(extract(epoch from (now() - state_change))))::int as longest_in_state_s
			from pg_stat_activity
			where datname = current_database() and pid <> pg_backend_pid()
			group by state, wait_event_type, wait_event
			order by connections desc`
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs)
			timer.unref?.()
		})
		return Array.from(await Promise.race([query, deadline]))
	} finally {
		clearTimeout(timer)
		void client.end({ timeout: 1 }).catch(() => {})
	}
}
