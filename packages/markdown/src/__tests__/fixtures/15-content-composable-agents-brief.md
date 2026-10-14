# Brief for the writer

**Primary keyword:** composable AI agents vs AI employees  
**Cluster:** "composable AI agents", "AI employees vs AI agents", "agent workspace architecture", "two camps AI agent workspace", "full-company simulation vs composable infrastructure"  
**Content type:** article  
**JTBD:** A technical buyer / founder trying to make sense of the split between the "AI employees / full-company simulation" camp (Paperclip et al.) and the "composable infrastructure" camp wants a single page that names both honestly, explains the architectural stakes, and gives them a way to choose.

**Why this exists (dispatch reasoning):** [Insight 9249d0dd](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/9249d0dd-bc8f-4336-b5de-43c7eb978d23) and positioning [bet 078b5ddf](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/078b5ddf-e96c-4470-9983-a8fe005a6db0) validate the two-camps frame; several live pieces already cite it (MCP-native, Cowork alt, BYOM) but none owns it as primary topic.

**Positioning:** Camps, not takedown. Paperclip and the simulation camp are a real, interesting bet — do not strawman. The argument is architectural: the composable camp treats agents as scoped, event-driven capabilities over typed objects with bounded human gates; the simulation camp treats agents as personas populating a synthetic org chart. Different production properties, different failure modes, different buyers. Frame both honestly, then argue which one holds up under determinism / safety / scale.

**Argument spine (reuse verbatim from [MCP-native](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/21b484a6-e598-49e0-badf-755d58db06df) — Writer's ratified spine):**
- The protocol/sandbox split: "what an agent can reach" (protocol / MCP) vs "how much it can touch while working" (sandbox / autonomy dial). This is the load-bearing structural cut.
- Three production properties the composable camp treats as first-class: **determinism** (typed objects + event-driven triggers = reproducible outcomes), **safety** (bounded human-gated loops = named escalation), **scale** (small auditable agents = orchestration, not personas).
- The simulation camp's honest strengths (demos well, natural mental model, low ramp) and honest costs (opaque state, entangled autonomy, hard to audit outcomes).
- Paperclip (~38K stars) as the emblem of the simulation camp — cite by name, link fairly, no strawman.
