# Query Flow Architecture

## Current Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Application                        │
│                    (WebSocket Connection)                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ WebSocket: ws://localhost:8787/api/gateway/ws?userId=xxx
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Worker (index.ts)                           │
│  - handleGatewayWebSocket()                                      │
│  - Routes WebSocket to TravelAgent Durable Object                │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ Forwards WebSocket connection
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              TravelAgent Durable Object                          │
│              (src/travel-agent.ts)                               │
│                                                                   │
│  State:                                                          │
│  - basics: { destination, dates, budget }                        │
│  - preferences: ["nightlife", "museums", ...]                   │
│  - recentMessages: [{ role, content }, ...]                      │
│  - currentItinerary: {...}                                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ onMessage() receives user query
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    handleMessage() Flow                           │
└─────────────────────────────────────────────────────────────────┘
```

## Detailed Query Processing Flow

### Step-by-Step: What Happens When a User Sends a Message

```
User Query: "I want to plan a trip to Paris. Recommend activities and find flights."
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 1: Message Reception (onMessage)                           │
│ - Parse WebSocket message                                        │
│ - Extract text: "I want to plan a trip to Paris..."             │
│ - Call handleMessage(input)                                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 2: State Update                                            │
│ - Add user message to recentMessages                            │
│ - Extract trip info: destination="Paris"                        │
│ - Update state.basics                                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3: Decision Logic - Should we use RAG?                     │
│                                                                   │
│ shouldUseRAG(input) checks for keywords:                         │
│ - "recommend", "suggest", "what to do", "attractions",          │
│   "places to visit", "activities", "things to see"              │
│                                                                   │
│ Result: YES (contains "Recommend activities")                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 4: RAG Retrieval (performRAG)                              │
│                                                                   │
│ 1. Generate embedding for query:                                │
│    - AI.run("@cf/baai/bge-base-en-v1.5", { text: [query] })    │
│                                                                   │
│ 2. Query Vectorize index:                                       │
│    - VECTORIZE.query(embedding, { topK: 5, filter: {city} })   │
│                                                                   │
│ 3. Format results:                                              │
│    - Extract top 5 similar documents                            │
│    - Format as context paragraphs                               │
│    - Return: "[1] Information about activities in Paris..."      │
│                                                                   │
│ Context retrieved from:                                          │
│ - Base RAG files (pre-seeded travel knowledge)                  │
│ - Live-learned content (previously ingested Amadeus results)   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ context = "RAG results..."
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 5: Decision Logic - Should we use Tools?                   │
│                                                                   │
│ shouldUseTools(input) checks for keywords:                       │
│ - "flight", "hotel", "activity", "book", "search",              │
│   "price", "availability", "find", etc.                          │
│                                                                   │
│ Result: YES (contains "find flights")                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 6: Tool Calling (useTools)                                 │
│                                                                   │
│ 6a. Intent Detection (LLM-based):                               │
│     - determineAmadeusAPICall(message)                          │
│     - LLM analyzes query and returns:                          │
│       { apiName: "searchFlightOffers", params: {...} }          │
│                                                                   │
│ 6b. API Call:                                                    │
│     - callAmadeusAPI("searchFlightOffers", params)              │
│     - AmadeusClient.searchFlightOffers({...})                   │
│     - Returns flight data                                        │
│                                                                   │
│ 6c. Result Ingestion (Automatic):                               │
│     - Extract top 5 results from API response                   │
│     - For each result:                                          │
│       * Summarize: "Flight from NYC to Paris for $450..."      │
│       * Generate embedding                                       │
│       * Upsert to Vectorize with metadata                       │
│       * Store in KV for deduplication                           │
│                                                                   │
│ 6d. Format tool results:                                         │
│     - Return: "[Tool Results: Found 10 result(s) from          │
│                 searchFlightOffers]"                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ toolResults = "Found 10 flights..."
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 7: LLM Generation (generateLLMResponse)                    │
│                                                                   │
│ Inputs:                                                          │
│ - userMessage: "I want to plan a trip to Paris..."             │
│ - ragContext: "RAG results about activities..."                │
│ - toolResults: "Found 10 flights..."                           │
│ - conversationHistory: last 5 messages                           │
│ - tripState: { destination: "Paris", ... }                      │
│                                                                   │
│ System Prompt includes:                                          │
│ - Current trip information (destination, dates, budget)         │
│ - RAG context (relevant travel knowledge)                        │
│ - Tool results (flight data from Amadeus)                       │
│                                                                   │
│ LLM Call:                                                        │
│ - AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {               │
│     messages: [system, history, user],                          │
│     max_tokens: 1024,                                           │
│     stream: true  ← STREAMING ENABLED                            │
│   })                                                             │
│                                                                   │
│ Returns: ReadableStream (SSE format)                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ ReadableStream (SSE chunks)
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 8: Stream Transformation (transformStreamForState)         │
│                                                                   │
│ - Parse SSE chunks from Workers AI                               │
│ - Extract text content from each chunk                           │
│ - Forward chunks as plain text (for WebSocket)                   │
│ - Accumulate full text for state update                          │
│                                                                   │
│ Returns: ReadableStream (plain text chunks)                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ Plain text stream
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 9: WebSocket Streaming (streamToWebSocket)                 │
│                                                                   │
│ - Read chunks from stream                                        │
│ - Send each chunk immediately:                                   │
│   { type: "response", text: "I", chunk: true, ... }            │
│   { type: "response", text: " would", chunk: true, ... }         │
│   { type: "response", text: " be", chunk: true, ... }           │
│   ...                                                            │
│ - Send final complete message:                                  │
│   { type: "response", text: "full response", complete: true }   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ Progressive chunks → Client
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 10: State Update (After Streaming Completes)               │
│                                                                   │
│ - Accumulated full response text                                 │
│ - Update state.recentMessages with assistant response           │
│ - State persists in Durable Object                              │
└─────────────────────────────────────────────────────────────────┘
```

## RAG and Tool Calling Connection

### Are They Connected? YES - They Work Together

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONNECTED FLOW                                │
└─────────────────────────────────────────────────────────────────┘

User Query
    │
    ├─→ RAG Retrieval (if keywords detected)
    │   │
    │   └─→ Vectorize Search
    │       │
    │       ├─→ Base RAG Files (pre-seeded knowledge)
    │       │   - budget_travel_strategies.txt
    │       │   - trip_planning_by_duration.txt
    │       │   - when_to_visit_cities.txt
    │       │   - etc.
    │       │
    │       └─→ Live-Learned Content (from previous tool calls)
    │           - Previously ingested flight results
    │           - Previously ingested hotel results
    │           - Previously ingested activity results
    │
    ├─→ Tool Calling (if keywords detected)
    │   │
    │   └─→ Amadeus API Call
    │       │
    │       ├─→ Get Results (flights, hotels, activities)
    │       │
    │       └─→ INGEST TOP 5 RESULTS INTO VECTORIZE
    │           │
    │           ├─→ Generate embedding for each result
    │           ├─→ Summarize result (hotel/flight/activity)
    │           ├─→ Upsert to Vectorize with metadata
    │           └─→ Store in KV for deduplication
    │
    └─→ LLM Generation
        │
        └─→ Combines:
            - User query
            - RAG context (from Vectorize)
            - Tool results (from Amadeus)
            - Conversation history
            - Trip state
```

### Key Connection Points

1. **RAG feeds into LLM**: RAG context is included in the LLM system prompt
2. **Tool results feed into LLM**: Tool results are included in the LLM system prompt
3. **Tool results feed into RAG**: Top 5 tool results are automatically ingested into Vectorize
4. **RAG can retrieve tool results**: Previously ingested tool results can be retrieved by RAG search

### Example: Full Cycle

```
Query: "Find flights to Paris and recommend activities"

1. RAG Retrieval:
   - Searches Vectorize for "recommend activities"
   - Finds: Base RAG files about activities
   - Finds: Previously ingested activity results from Amadeus (if any)

2. Tool Calling:
   - Calls searchFlightOffers API
   - Gets 10 flight results
   - Ingests top 5 flights into Vectorize
   - Returns: "Found 10 flights..."

3. LLM Generation:
   - Receives: RAG context + Tool results
   - Generates response combining both

4. Future Queries:
   - "What flights did you find earlier?"
   - RAG can now retrieve the ingested flight data!
```

## Data Flow Diagram

```
┌──────────────┐
│   User Query │
└──────┬───────┘
       │
       ├─────────────────────────────────────┐
       │                                     │
       ▼                                     ▼
┌──────────────┐                    ┌──────────────┐
│  RAG Search  │                    │ Tool Calling │
│  (Vectorize) │                    │  (Amadeus)   │
└──────┬───────┘                    └──────┬───────┘
       │                                     │
       │ context                             │ toolResults
       │                                     │
       │                                     │
       │                                     │ (Top 5 results)
       │                                     │
       │                                     ▼
       │                            ┌──────────────┐
       │                            │   Ingest to   │
       │                            │   Vectorize   │
       │                            └──────┬───────┘
       │                                     │
       │                                     │ (Available for
       │                                     │  future RAG)
       │                                     │
       ▼                                     ▼
┌──────────────────────────────────────────────┐
│         LLM Generation                        │
│  Input: query + context + toolResults        │
│  Output: ReadableStream (streaming)          │
└──────────────────┬───────────────────────────┘
                   │
                   │ Stream chunks
                   │
                   ▼
┌──────────────────────────────────────────────┐
│      WebSocket Streaming                      │
│  Progressive chunks → Client                 │
└──────────────────────────────────────────────┘
```

## Current Implementation Status

✅ **RAG Integration**: Fully implemented
- Keyword-based detection (`shouldUseRAG()`)
- Vectorize search with embeddings
- Top 5 results retrieved
- Context formatted and passed to LLM

✅ **Tool Calling Integration**: Fully implemented
- Keyword-based detection (`shouldUseTools()`)
- LLM-based intent detection (`determineAmadeusAPICall()`)
- 30 Amadeus APIs supported
- Results automatically ingested into Vectorize

✅ **Streaming**: Fully implemented
- LLM responses stream token-by-token
- Chunks sent progressively via WebSocket
- Full response accumulated for state

✅ **Connection Between RAG and Tools**: YES
- Tool results (top 5) automatically ingested into Vectorize
- Future RAG searches can retrieve previously ingested tool results
- Both RAG context and tool results included in LLM prompt
- They work together to provide comprehensive responses

## Example Query Flow

**Query**: "I want to visit Paris. Recommend budget activities and find hotels."

1. **State Update**: destination="Paris"
2. **RAG Triggered**: "Recommend" keyword detected
   - Searches Vectorize for "budget activities"
   - Returns: Base RAG + any previously ingested activities
3. **Tools Triggered**: "find hotels" keyword detected
   - LLM determines: `searchHotelOffers` API
   - Calls Amadeus API
   - Gets 10 hotel results
   - Ingests top 5 hotels into Vectorize
4. **LLM Generation**: 
   - System prompt includes:
     - RAG context (budget activity tips)
     - Tool results (hotel data)
     - Trip state (destination: Paris)
   - Generates streaming response
5. **Streaming**: Chunks sent progressively to client
6. **State Update**: Full response saved after streaming

**Next Query**: "What hotels did you find?"
- RAG can now retrieve the ingested hotel data from Vectorize!
- No need to call Amadeus API again (if data is still relevant)

