# RAG and Tool Calling Execution Flow

## Overview

This document explains when and how RAG (Retrieval-Augmented Generation) and tool calling (Amadeus API) occur in the TravelAgent system, particularly in the context of the fire-and-forget architecture that prevents CPU time limit errors.

## High-Level Architecture

```
Webhook → RPC Call → handleMessageStreaming() → handleMessage() → Stream to Realtime
   ↓           ↓              ↓ (returns immediately)     ↓ (background)
 200 OK    {success: true}                      RAG + Tools + LLM
```

## Execution Timeline

### Phase 1: Webhook Reception (Immediate Return)

**Location**: `src/index.ts` - `handleRealtimeWebhook()`

1. Realtime webhook receives user message
2. Creates RPC request to `TravelAgent.handleMessageStreaming()`
3. **Returns immediately** with `{ success: true, message: "Processing started" }`
4. Work continues in background

**Key Point**: The webhook does NOT wait for processing to complete.

### Phase 2: RPC Call (Immediate Return)

**Location**: `src/travel-agent.ts` - `handleMessageStreaming()`

1. Receives RPC call from webhook
2. Calls `handleMessage(input)` **without await** (fire-and-forget)
3. **Returns immediately** with `{ success: true, message: "Processing started" }`
4. Processing continues in background via promise chain

**Key Point**: The RPC call does NOT wait for `handleMessage()` to complete.

### Phase 3: Background Processing (RAG + Tools + LLM)

**Location**: `src/travel-agent.ts` - `handleMessage()`

This is where all the heavy work happens:

#### Step 1: State Update
```typescript
// Update state with user message
this.setState({
  ...this.state,
  recentMessages: [
    ...this.state.recentMessages,
    { role: "user", content: input },
  ],
});
```

#### Step 2: Extract Trip Info
```typescript
// Extract destination, dates, etc. from message
this.extractTripInfo(input);
```

#### Step 3: Determine if RAG/Tools Needed

**RAG Detection** (`shouldUseRAG()`):
- Checks for keywords: `"recommend"`, `"suggest"`, `"what to do"`, `"attractions"`, `"places to visit"`, `"activities"`, `"things to see"`
- Returns `true` if any keyword matches

**Tools Detection** (`shouldUseTools()`):
- Checks for keywords: `"flight"`, `"hotel"`, `"book"`, `"search"`, `"price"`, `"availability"`, `"recommend"`, `"find"`, etc.
- Returns `true` if any keyword matches

#### Step 4: Execute RAG and Tools in Parallel

**Critical**: RAG and tools run **simultaneously**, not sequentially.

```typescript
// RAG promise with 5s timeout
const ragPromise = needsRAG
  ? Promise.race([
      this.performRAG(input),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 5000)),
    ])
  : Promise.resolve("");

// Tools promise with 10s timeout
const toolsPromise = needsTools
  ? Promise.race([
      this.useTools(input),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 10000)),
    ])
  : Promise.resolve("");

// Wait for both in parallel
const [ragResult, toolsResult] = await Promise.all([ragPromise, toolsPromise]);
```

**Timeouts**:
- RAG: 5 seconds max
- Tools: 10 seconds max
- If timeout occurs, returns empty string and continues

#### Step 5: Generate LLM Response

```typescript
stream = await this.generateLLMResponse(
  input,
  context,        // From RAG
  toolResults,    // From Amadeus API
);
```

The LLM receives:
- User's original message
- RAG context (from Vectorize search)
- Tool results (from Amadeus API calls)

#### Step 6: Stream to Realtime

The stream is passed to `streamToRealtime()`, which:
1. Reads chunks from the LLM stream
2. Publishes each chunk to Realtime via `RealtimeConnector`
3. Sends final completion message when done

## Detailed RAG Process

**Location**: `src/travel-agent.ts` - `performRAG()`

1. **Generate Embedding**: Uses Workers AI (`@cf/baai/bge-base-en-v1.5`) to create vector embedding of user query
2. **Query Vectorize**: Searches vector database with:
   - Query embedding
   - Top K: 5 results
   - Optional filter by destination city (if available in state)
3. **Format Context**: Combines top matches into formatted context paragraphs
4. **Return**: Returns formatted context string (or empty string if no results/timeout)

**Example Output**:
```
[1] Information about Eiffel Tower (attraction) (Source: travel knowledge base, Score: 0.892)
[2] Best restaurants in Paris (Source: travel knowledge base, Score: 0.856)
...
```

## Detailed Tool Calling Process

**Location**: `src/travel-agent.ts` - `useTools()`

1. **Determine API Call**: Uses LLM to determine which Amadeus API to call
   - Falls back to keyword-based detection if LLM doesn't determine an API
   - Common routes: flights, hotels, activities
2. **Execute API Call**: Calls Amadeus API via `AmadeusClient`
3. **Format Results**: Formats API response into readable text
4. **Return**: Returns formatted tool results string (or empty string if no API needed/timeout)

**Supported APIs** (30+ Amadeus APIs):
- Flight search
- Hotel search
- Activities/Tours
- Airport information
- And more...

## Parallel Execution Benefits

### Before (Sequential):
```
RAG (5s) → Tools (10s) → LLM (3s) = 18 seconds total
```

### After (Parallel):
```
RAG (5s) ┐
         ├→ max(5s, 10s) = 10s → LLM (3s) = 13 seconds total
Tools (10s) ┘
```

**Time Saved**: ~5 seconds per request

## Timeout Protection

Both RAG and tools have timeouts to prevent CPU time limit errors:

- **RAG Timeout**: 5 seconds
  - If Vectorize search takes longer, returns empty string
  - LLM continues without RAG context

- **Tools Timeout**: 10 seconds
  - If Amadeus API call takes longer, returns empty string
  - LLM continues without tool results

**Why This Matters**: Durable Objects have CPU time limits. If RAG or tools hang, the entire request would fail. Timeouts ensure the LLM can still generate a response.

## Error Handling

### RAG Errors
- If embedding generation fails → returns empty string
- If Vectorize query fails → returns empty string
- Logs error but continues processing

### Tool Errors
- If API call fails → returns empty string
- If API returns error → formats error message
- Logs error but continues processing

### LLM Errors
- If LLM generation fails → error is caught and published to Realtime
- User receives error message via Realtime

## Complete Flow Example

### User Message: "I want to find flights to Paris and get recommendations for attractions"

1. **Webhook** receives message → Returns `200 OK` immediately
2. **RPC Call** to `handleMessageStreaming()` → Returns `{ success: true }` immediately
3. **Background Processing Starts**:
   - `handleMessage()` begins execution
   - Updates state with user message
   - Extracts: destination="Paris"
   - Detects: `needsRAG=true` (keyword: "recommendations", "attractions")
   - Detects: `needsTools=true` (keyword: "flights", "find")
4. **Parallel Execution**:
   - **RAG**: Searches Vectorize for "attractions in Paris" → Returns top 5 results
   - **Tools**: Calls Amadeus Flight Search API for flights to Paris → Returns flight options
   - Both complete in ~8 seconds (parallel)
5. **LLM Generation**:
   - Receives: user message + RAG context + flight results
   - Generates streaming response
6. **Streaming**:
   - Chunks published to Realtime as they're generated
   - User sees response appear progressively

## Key Takeaways

1. **Fire-and-Forget Architecture**: Webhook and RPC return immediately, work happens in background
2. **Parallel Execution**: RAG and tools run simultaneously, reducing total time
3. **Timeout Protection**: Both RAG and tools have timeouts to prevent CPU limit errors
4. **Graceful Degradation**: If RAG or tools fail/timeout, LLM continues with available context
5. **Streaming**: LLM response streams to Realtime in real-time chunks

## Code Locations

- **Webhook Handler**: `src/index.ts` - `handleRealtimeWebhook()` (line ~280)
- **RPC Entry Point**: `src/travel-agent.ts` - `handleMessageStreaming()` (line ~720)
- **Main Processing**: `src/travel-agent.ts` - `handleMessage()` (line ~772)
- **RAG Logic**: `src/travel-agent.ts` - `performRAG()` (line ~978)
- **Tools Logic**: `src/travel-agent.ts` - `useTools()` (line ~1270)
- **Streaming**: `src/travel-agent.ts` - `streamToRealtime()` (line ~250)

