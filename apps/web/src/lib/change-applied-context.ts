import { createContext, useContext } from 'react'

export interface ChangeAppliedState {
	/** A review wrote at least one change to the file and no autosave has said "Saved" since. */
	applied: boolean
	/** Called once the editor has saved, which replaces "Change applied" with "Saved". */
	clear: () => void
}

export const ChangeAppliedContext = createContext<ChangeAppliedState | null>(null)

/** Lets the editor's status line show "Change applied" after a review. Null when the flag is off. */
export function useChangeApplied(): ChangeAppliedState | null {
	return useContext(ChangeAppliedContext)
}
