## Project Overview

**Travellite** is a travel assistant chat app built on Cloudflare Workers. It features:
- Real-time streaming chat with a travel agent powered by Workers AI
- Per-user conversation threads stored in Durable Objects
- RAG (Retrieval-Augmented Generation) using Vectorize for destination context
- Amadeus APIs integration for flights, hotels, and activities
- Two real-time communication paths: direct WebSocket or Cloudflare Realtime

The app is a Cloudflare Workers project written in TypeScript, deployed as a Worker with two Durable Objects (TravelAgent and RealtimeConnector).

---

## Key Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start local dev with remote bindings (`wrangler dev --remote`). Sets secrets from `.dev.vars` first. |
| `npm run dev:local` | Local-only dev (no remote bindings; limited Amadeus/Realtime). |
| `npm run deploy` | Deploy to Cloudflare Workers. |
| `npm run check` | TypeScript check + dry-run deploy. |
| `npm run cf-typegen` | Regenerate Worker environment types after `wrangler.jsonc` changes. |
| `npm run set-secrets` | Push secrets from `.dev.vars` into Wrangler. |
| `npm test` | Run Vitest unit tests. |
| `npm run test:ws` | Test WebSocket direct connection (`test/test-websocket.js`). |
| `npm run test:tools` | Test LLM tool calling (`test/test-tool-calling.js`). |
| `npm run test:amadeus` | Test Amadeus API client (`test/test-amadeus-apis.js`). |
| `npm run test:llm-rag-tools` | Integration test: LLM + RAG + tools (`test/test-llm-rag-tools.js`). |
| `npm run seed:rag` | Populate Vectorize index with destination data. |

---

## Architecture at a Glance

### High-level flow

```
Browser (public/index.html)
  ↓ HTTP/SSE or WebSocket
Worker (src/index.ts)
  ↓ RPC or WebSocket upgrade
TravelAgent Durable Object (src/travel-agent.ts)
  ↓ State load / prepareTurn
Worker runs Pipeline (src/pipeline.ts)
  ↓ RAG + Amadeus tools + LLM streaming
Response streams back
  ↓ appendConversation (persist to DO storage)
```

### Two real-time paths

1. **WebSocket Gateway** (`/api/gateway/ws`): Direct WebSocket from client to TravelAgent Durable Object (low latency, self-managed).
2. **Realtime Integration** (`/api/realtime/webhook`): Cloudflare Realtime service with webhook ingestion and RealtimeConnector DO for publishing (managed, feature-rich, slightly higher latency).

Both paths flow through the same TravelAgent and pipeline code; they differ only in how messages enter and exit.

---

## Core Files and Responsibilities

| File | Role |
|------|------|
| **src/index.ts** | Worker entry point. Routes HTTP requests, handles `/api/agents/TravelAgent/*` and `/api/realtime/*`, serves static assets. |
| **src/travel-agent.ts** | TravelAgent Durable Object. One instance per user (session id). Holds conversation threads, state (trip preferences, currentIntent). Implements RPC methods: `getState`, `prepareTurn`, `loadTrip`, `startNewTrip`, `appendConversation`. Handles WebSocket upgrade for gateway path. |
| **src/pipeline.ts** | Core agent logic: `runPipeline(env, message, tripState)`. Orchestrates RAG (Vectorize) and Amadeus tool calls in parallel, then generates LLM response with streaming. Also exports `classifyConversation()` for intent/new-trip detection. |
| **src/amadeus-client.ts** | REST client for Amadeus APIs (flight search, hotel search, activities). Used by pipeline tools. |
| **src/realtime-connector.ts** | RealtimeConnector Durable Object. Maintains persistent WebSocket to Cloudflare Realtime service. Publishes agent responses to rooms. Includes automatic reconnection and HTTP fallback. |
| **src/types.ts** | Shared TypeScript types (Message, TripThread, TripState, etc.). |
| **public/index.html** | Frontend: React-based chat UI with trip threads sidebar. Uses SSE to stream LLM responses and Realtime SDK for optional collaborative features. |
| **wrangler.jsonc** | Cloudflare Worker config. Binds AI, Vectorize, KV, Durable Objects. Defines migrations for DO SQLite schemas. |

---

## Important Concepts

### Durable Objects and State Storage

- **TravelAgent**: One instance per user (identified by `sessionId`). In-memory state: current thread messages, preferences, currentIntent. Persistent storage: thread history in key-value store (`thread:<id>`, `threads`, `currentThreadId`).
- **RealtimeConnector**: One instance per Realtime namespace. Maintains persistent WebSocket to Cloudflare Realtime. Managed via `.get(id)` in index.ts.
- **Storage Keys**: `threads` (list of trip summaries), `currentThreadId`, `thread:<id>` (full conversation + metadata).

### Trip Threads and Intent

- A "trip" is a thread of conversation around a travel topic.
- `currentIntent` in TravelAgent tracks the active topic (e.g., "plan a trip", "search flights").
- When a message implies a new topic (detected by `classifyConversation`), a new thread is created automatically or via `/startNewTrip` endpoint.
- Thread switching loads prior messages and preferences from storage.

### RAG and Vectorize

- Pipeline optionally queries Vectorize index `travellite-index` when the user mentions a destination.
- RAG results are included in the LLM system prompt for context.
- Index population: run `npm run seed:rag` to load destination docs.

### Tool Calling

- Amadeus tools (searchFlights, searchHotels, etc.) are exposed to the LLM.
- When the user asks about flights or hotels, the LLM calls the tool, pipeline executes it, and results are passed back to the LLM to generate a response.
- Tools are defined in `pipeline.ts` and executed before LLM inference.

### Streaming

- LLM responses stream via Server-Sent Events (SSE) or WebSocket depending on the path.
- Frontend (public/index.html) renders tokens as they arrive.

---

## Development Workflow

### Adding a new feature or fixing a bug

1. **Understand the flow**: Is this in the Worker handler, Durable Object, pipeline, or frontend?
2. **Make changes**: Edit TypeScript files in `src/`. Update types in `types.ts` if needed.
3. **Test locally**: 
   - For pipeline/LLM/tools: `npm run test:llm-rag-tools` or similar.
   - For WebSocket: `npm run test:ws`.
   - For Amadeus: `npm run test:amadeus`.
4. **Run dev server**: `npm run dev` (remote bindings) or `npm run dev:local`.
5. **Check types**: `npm run check` (includes TypeScript check).
6. **Deploy**: `npm run deploy` after testing.

### Changing Durable Object schema

- Update the class in `src/travel-agent.ts` or `src/realtime-connector.ts`.
- If you add new storage keys or fields, increment the migration version in `wrangler.jsonc`.
- Test locally with `npm run dev:local` or `npm run dev`.

### Adding Amadeus tools

- Add a new function in `src/amadeus-client.ts`.
- Export a tool object in `src/pipeline.ts` with `function`, `description`, and `inputSchema`.
- The LLM will use it automatically when relevant.

### Updating RAG index

- Modify seed script or add new destination docs.
- Rerun `npm run seed:rag`.

---

## Testing Strategy

- **Unit tests** (`vitest`): Run with `npm test`.
- **Integration tests** (Node.js scripts in `test/`): 
  - `test-llm-rag-tools.js`: End-to-end pipeline (RAG + tools + LLM).
  - `test-websocket.js`: Direct WebSocket connection.
  - `test-amadeus-apis.js`: Amadeus client.
  - `test-tool-calling.js`: LLM tool invocation.
  - `test-realtime-webhook.js`: Realtime webhook ingestion.
  - `test-do-stub.js`: Durable Object stubs.

**Key testing note**: Tests that hit Amadeus or Workers AI require valid credentials in `.dev.vars`. Local tests can mock or stub responses.

---

## Deployment Checklist

1. **Secrets**: Ensure production secrets are set in Cloudflare dashboard:
   - `AMADEUS_API_KEY`, `AMADEUS_API_SECRET`
   - `REALTIME_API_TOKEN`, `REALTIME_NAMESPACE_ID` (if using Realtime)
   - Any other environment variables used in `wrangler.jsonc`.

2. **RAG Index**: Create `travellite-index` in Vectorize if not already present. Seed with data via `npm run seed:rag` (can be run post-deploy).

3. **Bindings**: Verify KV namespace and Vectorize index IDs in `wrangler.jsonc` match Cloudflare account.

4. **Run checks**: `npm run check` (TypeScript + dry-run deploy).

5. **Deploy**: `npm run deploy`.

6. **Verify**: Test the deployed Worker URL in a browser or via curl/Postman.

---

## Key Gotchas and Patterns

### Message vs. Conversation Flow

- `prepareTurn()` is called *before* the pipeline runs; it sets up state and loads the current thread.
- `appendConversation()` is called *after* the LLM response is ready; it persists user and assistant messages.
- If you modify state in the pipeline, changes are lost unless you call `appendConversation()` afterward.

### Realtime vs. WebSocket Gateway

- Both route to the same `TravelAgent` instance via `sessionId` / user ID.
- WebSocket Gateway: client → Worker → TravelAgent (direct WebSocket).
- Realtime: client → Realtime → webhook → Worker → TravelAgent (HTTP), response → RealtimeConnector (WebSocket) → Realtime.
- Choose based on latency vs. features tradeoff.

### Handling Long-Running Requests

- Workers have a CPU time limit (default 30s, can be raised in `wrangler.jsonc` under `limits.cpu_ms`).
- LLM streaming helps keep responses within time limits by flushing tokens early.
- Amadeus API calls may timeout; implement retry logic in `amadeus-client.ts` if needed.

### Storage Consistency

- TravelAgent Durable Object storage is eventually consistent.
- If you read and write in the same request, reads see stale data; use in-memory state for the current session.
- For cross-session reads (e.g., loading an old trip), data is consistent.

---

## Documentation References

- **ARCHITECTURE.md**: Deep dive into WebSocket vs. Realtime, latency analysis, and state management.
- **REALTIME_FLOW.md**: Realtime-specific message flow and webhook handling.
- **RPC_HANG_ANALYSIS.md**: Analysis of RPC call timing and troubleshooting.
- **RAG_README.md**: Vectorize setup and RAG query patterns.
- **test/**: Individual test files document their use cases and command invocations.

---

## Common Tasks

### Debug a message flow

1. Check Worker logs: `wrangler tail` or Cloudflare dashboard.
2. Add console.log in relevant handler (index.ts, travel-agent.ts, pipeline.ts).
3. Run `npm run dev` and reproduce the issue.
4. Check browser network tab (SSE events, WebSocket frames).

### Add a new API endpoint

1. Add route in `src/index.ts` (e.g., `if (path === '/api/my-endpoint')`).
2. Implement handler (may call TravelAgent RPC or pipeline).
3. Return Response with appropriate headers.
4. Test with curl or Postman.

### Inspect Durable Object storage

1. Use `wrangler tail` to see logs.
2. Add a temporary endpoint in `src/index.ts` to read and return storage contents (e.g., `/debug/state`).
3. Deploy locally or to staging, make request, inspect response.
4. Remove after debugging.

### Scale to multiple users

- Durable Objects scale automatically; each user gets their own instance.
- No code changes needed for multi-user; the `sessionId` isolation handles it.
- Monitor for storage size limits (soft limits don't apply to DO storage in practice; consider cleanup if threads grow unbounded).
