# Smart Window latency experiment

Experiment branch. Nine changes aimed at the delay between submitting a prompt
and seeing a rendered answer. Measured against the real MLPA endpoint on a
signed-in profile, plus a Firefox profile of a full search-shaped turn.

Every commit on this branch carries a placeholder `Bug XXXXXXX` and an empty
`r=`. Nothing here is ready to land as-is.

## What the turn actually costs

From a profiled search-shaped turn, time-to-first-token was **14.1s**:

| Phase | Duration |
|---|---|
| Submit to request leaving | 0.11s |
| Round 1 (model decides to search) | 2.01s |
| `search_the_web` | 10.61s |
| Round 2 to first token | ~1.4s |

Inside that 10.61s: one `/v1/search` call plus **five more** chat completions —
the search flow runs its own agentic loop. So one search turn is roughly seven
model round trips, each carrying ~10k prompt tokens.

Everything on this branch optimizes the 0.11s slice.

## What works

| Change | Evidence |
|---|---|
| Engine prewarm | Chat engine live at window open; embeddings 168ms cold, 6-12ms warm |
| Memories off critical path | Retrieval wait 795/366ms -> 78ms (confounded with prewarm) |
| Stream coalescing | 397 chunks -> ~109 dispatches (2.4-4.9x); nothing truncated |
| Stream markers (bug 2058755) | Instrumentation - how everything else got measured |

Combined: **~250ms of a 14.1s turn.**

## What didn't

| Change | Why |
|---|---|
| Endpoint connection warm | Right key, right cadence, socket never created. Request 404ms after a warm paid 95.6ms including DNS |
| Prompt cache prefix | Mechanism airtight (byte-identical prompt, 5 reuse markers). Payoff `cached=3/prompt=9839` |
| Parallel tool calls | 0 executions, ever. Model won't emit >1; `search_the_web` not on the allowlist |
| SERP host warming | Fires, reuse never verified, warms `anonymous=false` - the assumption that was wrong for chat |
| FxA prefetch | ~3ms |

Open defect: duplicate `connectedCallback` -> 2 warms + 2 prewarms per window
open. It is one element connecting twice, not two elements.

Notes on the two that are built but inert:

- The connection warm reaches `nsHttpConnectionMgr::SpeculativeConnect` (its
  marker fires) but the socket is created later, behind a
  `mNumDnsAndConnectSockets < parallelSpeculativeConnectLimit` gate. A marker
  therefore does not prove a socket exists. Either
  `network.http.speculative-parallel-limit` was 0, or the limit was already
  reached - the profile had 41 peak concurrent requests. DNS being paid on the
  post-warm request shows it never got as far as resolving.
- The prompt cache premise is real: an earlier session reached
  `cached=11614/prompt=11655`, 99.6%. The collapse to `cached=3` is unexplained
  and is the highest-value open question here, because it multiplies across all
  seven round trips.

## What can be done

Ranked by payoff over effort.

| # | Action | Gain |
|---|---|---|
| 1 | Start SERP page reads when the SERP lands, parallel to the read decision | 1-3s |
| 2 | Prompt the search model to batch all URLs into one `readPage` (already takes an array) | 2-3s |
| 3 | Fix prompt caching | compounds x7 round trips |
| 4 | Live progress during the 10.6s dead air | biggest perceived win |
| 5 | Wire the unwired `IntentClassifier` -> start search during round 1 | ~2s |
| 6 | Find why the 15.622s call cancels | 0.9s + a handshake |
| 7 | Cut `response-rules` (19KB of the 23.5KB system prompt) | x7 per turn |
| 8 | Stream the search flow's answer instead of a 2nd chat round | 3.3s (product call) |
| 9 | HTTP/2 at the Fastly edge | ~150ms, kills cancel + concurrency churn; cheap |
| 10 | Server-side session, tool results on one stream | kills prompt re-send |

Do 1 and 2 first: same 10.6s attacked from both sides, no server cooperation,
and one is a prompt edit. Then 3, because it is already built and returning
nothing, and it tells you what a round trip really costs before considering 10.

Do not spend more on speculative connect or parallel tool calls. Both have cost
more investigation than they can return.

## How to re-measure

- `chat-prompt-cache(cached=N/prompt=M)` per turn, in the `SmartWindow` marker
  category. Blind to tool rounds, which carry no `usage` chunk - so it misses the
  rounds with the largest prompts.
- `Time to first token (TTFT)` and `ServerE2E`, same category.
- `Raw chunk #N <kind>` in `MLEngine:OpenAI` for chunk counts.
- Connection reuse: `nsIDashboard.requestHttpConnections`. One pooled entry whose
  `ttl` goes 4 -> 114 means the warm served the request; two entries means it did
  not. Markers alone cannot tell you this.
- `network.http.speculative-parallel-limit` must be non-zero, or speculative
  connect is a silent no-op while markers still fire.
