import { z } from 'zod'

// Path param shared by all three star endpoints
// (`POST/DELETE/GET /api/objects/:id/star`). Same UUID shape as the objects
// routes — kept local rather than pulled from `schemas/objects` because the
// star endpoints live in their own route file.
export const starObjectParamsSchema = z.object({
	id: z.string().uuid(),
})

// Uniform response body for every star endpoint. `starred` reflects the
// current state after the request completes (POST → true, DELETE → false,
// GET → whatever's in the DB), which is what the card toggle in Task 4 needs
// to render the filled/empty icon without a follow-up read.
export const starObjectResponseSchema = z.object({
	starred: z.boolean(),
})

export type StarObjectResponse = z.infer<typeof starObjectResponseSchema>
