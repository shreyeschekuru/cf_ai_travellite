# Architecture Overview

This project implements two different approaches for real-time communication with the TravelAgent:

1. **WebSocket Gateway** - Direct WebSocket connection
2. **Realtime Integration** - Cloudflare Realtime service with webhooks

## How the Application Works

### Application Overview

TravelLite is an AI-powered travel planning assistant built on Cloudflare Workers. Users can interact with the TravelAgent through two communication channels, each optimized for different use cases. The agent maintains persistent state per user, remembers conversation context, and can perform actions like searching for flights using external APIs.

### User Query Flow

#### Path 1: WebSocket Gateway (Direct Connection)

**Step-by-Step Flow:**

1. **User Initiates Connection**
   - Client application connects to `ws://your-domain.com/api/gateway/ws?userId=user123`
   - Worker receives WebSocket upgrade request

2. **Connection Routing**
   - Worker extracts `userId` from query parameter
   - Creates or retrieves TravelAgent Durable Object instance for that user
   - Forwards WebSocket connection to the TravelAgent Durable Object
   - Connection is now established directly between client and Durable Object

3. **User Sends Query**
   ```
   User: "I want to plan a trip to Paris in December"
   ```
   - Message sent over WebSocket to TravelAgent
   - TravelAgent's `onMessage()` handler receives the message

4. **Agent Processing**
   - TravelAgent parses the message (JSON or plain text)
   - Calls `handleMessage()` method which:
     - Updates conversation state (destination: Paris, month: December)
     - Uses RAG (Retrieval-Augmented Generation) to search Vectorize index for relevant travel information
     - Calls Workers AI LLM with context and user query
     - May trigger tool calls (e.g., `searchFlights()`) if needed
     - Generates natural language response

5. **Response Delivery**
   - TravelAgent sends response back through the same WebSocket connection
   - Response format: `{ type: "response", text: "...", userId: "user123", timestamp: ... }`
   - Client receives response in real-time

6. **State Persistence**
   - TravelAgent state (trip preferences, conversation history) persists in Durable Object
   - Subsequent messages maintain context
   - State survives across connection reconnects

**Example Conversation:**
```
User → "I want to plan a trip to Paris"
Agent → "Great! I'd be happy to help you plan your trip to Paris. When are you planning to travel?"

User → "December 15th to 22nd"
Agent → "Perfect! A week in Paris in December sounds lovely. What's your budget for this trip?"

User → "Around $3000"
Agent → [Updates state: destination=Paris, dates=Dec 15-22, budget=$3000]
        "Excellent! With a $3000 budget, you have great options. Let me search for flights..."
        [Calls searchFlights tool]
        "I found several flight options. Here are the best deals..."
```

#### Path 2: Realtime Integration (Managed Service)

**Step-by-Step Flow:**

1. **User Connects to Realtime**
   - Client application connects to Cloudflare Realtime service
   - Realtime manages the WebSocket connection
   - User joins a room (e.g., `room:user123` or `room:travel-session-abc`)

2. **User Sends Message**
   ```
   User: "What flights are available from NYC to Paris?"
   ```
   - Message sent to Realtime service
   - Realtime receives message and triggers webhook

3. **Webhook Processing**
   - Realtime sends HTTP POST to `/api/realtime/webhook` with event:
     ```json
     {
       "type": "message",
       "room": "user123",
       "userId": "user123",
       "message": { "text": "What flights are available from NYC to Paris?" }
     }
     ```
   - Worker's `handleRealtimeWebhook()` processes the event

4. **Agent Processing**
   - Worker extracts message text and userId
   - Gets or creates TravelAgent Durable Object for the user
   - Makes RPC call to `handleMessage()` method
   - Same processing as WebSocket Gateway:
     - State updates
     - RAG search
     - LLM generation
     - Tool calls if needed

5. **Response Publishing**
   - Agent generates response
   - Worker calls `publishToRealtime()` function
   - RealtimeConnector Durable Object is accessed
   - Response published via persistent WebSocket connection to Realtime:
     ```json
     {
       "type": "agent_response",
       "text": "I'll search for flights from NYC to Paris...",
       "userId": "user123",
       "timestamp": 1234567890
     }
     ```
   - If WebSocket unavailable, falls back to HTTP API

6. **Message Delivery**
   - Realtime service receives the message
   - Delivers to all clients subscribed to the room
   - Client receives response in real-time

**Example Multi-User Scenario:**
```
Room: "trip-planning-session-123"
- User A: "Let's plan a group trip to Tokyo"
- User B: "I'm in! When are we going?"
- Agent: "Great! I'd be happy to help plan your group trip to Tokyo..."
- User A: "How about March?"
- Agent: "March is a great time to visit Tokyo! Let me check flight availability..."
```

### Key Components

#### 1. TravelAgent Durable Object
- **Purpose**: Maintains per-user state and handles conversation logic
- **State**: Trip preferences, conversation history, current itinerary
- **Methods**:
  - `handleMessage(text)`: Processes user queries, calls LLM, manages state
  - `searchFlights(params)`: Tool for searching flights via Amadeus API
  - `onMessage(connection, message)`: Handles WebSocket messages directly
- **Persistence**: State survives across requests and reconnects

#### 2. WebSocket Gateway Handler
- **Endpoint**: `/api/gateway/ws?userId=...`
- **Function**: Routes WebSocket connections to appropriate TravelAgent instance
- **Benefits**: Direct connection, lowest latency, simple architecture

#### 3. Realtime Webhook Handler
- **Endpoint**: `/api/realtime/webhook`
- **Function**: Receives events from Realtime service, routes to TravelAgent
- **Benefits**: Managed infrastructure, presence features, message history

#### 4. RealtimeConnector Durable Object
- **Purpose**: Maintains persistent WebSocket connection to Realtime service
- **Function**: Publishes agent responses back to Realtime rooms
- **Features**: Automatic reconnection, room subscription management, HTTP fallback

### State Management

Each user gets their own TravelAgent Durable Object instance, identified by `userId`. The state includes:

- **Trip Basics**: Destination, dates, budget
- **Preferences**: User interests (nightlife, museums, beaches, etc.)
- **Conversation History**: Recent messages for context
- **Current Itinerary**: Planned activities and schedule

This state persists across:
- Multiple messages in the same session
- Connection reconnects
- Worker restarts (Durable Objects are persistent)

### Tool Integration

The TravelAgent can call external tools:

- **`searchFlights()`**: Searches Amadeus API for flight options
  - Parameters: origin, destination, dates, passengers
  - Returns: Flight options with prices and details
  - Automatically called by LLM when user asks about flights

- **Future Tools**: Hotels, activities, weather, etc.

### Error Handling

- **Connection Failures**: Automatic reconnection with exponential backoff
- **Agent Errors**: Graceful error messages sent back to user
- **Tool Failures**: Agent explains the issue and suggests alternatives
- **Realtime Fallback**: If WebSocket fails, automatically uses HTTP API

### Performance Characteristics

**WebSocket Gateway:**
- First message latency: ~50-200ms (mostly LLM processing)
- Subsequent messages: ~50-150ms (state already loaded)
- Connection overhead: Minimal (direct connection)

**Realtime Integration:**
- First message latency: ~80-250ms (includes webhook + publish)
- Subsequent messages: ~80-200ms
- Connection overhead: Managed by Realtime service

## Architecture Comparison

### 1. WebSocket Gateway (`/api/gateway/ws`)

**Architecture Flow:**
```
Client → WebSocket → Worker → TravelAgent Durable Object → Response → Client
```

**Characteristics:**
- **Direct Connection**: Client connects directly to your Worker via WebSocket
- **Low Latency**: Minimal hops - direct path from client to Durable Object
- **Simple Architecture**: No intermediate services
- **Stateful**: WebSocket connection maintained in Durable Object
- **Bidirectional**: Real-time two-way communication
- **Self-Managed**: You handle connection management, reconnection, etc.

**Latency Path:**
1. Client sends message → Worker (1 hop)
2. Worker → TravelAgent Durable Object (internal, very fast)
3. TravelAgent processes → Response
4. TravelAgent → Worker → Client (1 hop)

**Total Latency:** ~2-3 network hops + processing time

### 2. Realtime Integration (Optimized with WebSocket)

**Architecture Flow (Optimized):**
```
Client → Realtime Service (WebSocket) → Webhook (HTTP POST) → Worker → TravelAgent → 
RealtimeConnector (WebSocket) → Realtime Service → Client
```

**Characteristics:**
- **Managed Service**: Cloudflare Realtime handles client WebSocket connections
- **Webhook-Based Input**: Realtime sends HTTP POST to your Worker when messages arrive
- **WebSocket-Based Output**: Worker maintains persistent WebSocket connection via RealtimeConnector Durable Object
- **Additional Features**: Built-in presence, rooms, message history
- **Scalability**: Realtime service handles connection scaling
- **Optimized Publishing**: Response published via persistent WebSocket connection (lower latency than HTTP)

**Latency Path (Optimized):**
1. Client sends message → Realtime Service (1 hop)
2. Realtime Service → Webhook HTTP POST → Worker (1 hop)
3. Worker → TravelAgent Durable Object (internal)
4. TravelAgent processes → Response
5. TravelAgent → Worker → RealtimeConnector (internal Durable Object)
6. RealtimeConnector → Realtime Service via WebSocket (1 hop, persistent connection)
7. Realtime Service → Client (1 hop)

**Total Latency:** ~4-5 network hops + processing time (reduced from 5-6 with HTTP)

**Fallback:**
- If WebSocket connection unavailable, automatically falls back to HTTP API publish

## Key Differences

| Aspect | WebSocket Gateway | Realtime Integration |
|--------|------------------|---------------------|
| **Connection Type** | Direct WebSocket | Managed via Realtime Service |
| **Latency** | Lower (fewer hops) | Higher (more hops) |
| **Complexity** | Self-managed | Managed service |
| **Features** | Basic WebSocket | Presence, rooms, history |
| **Scalability** | Manual | Automatic via Realtime |
| **Cost** | Included in Workers | Additional Realtime service cost |
| **Response Method** | Direct WebSocket send | WebSocket (via RealtimeConnector) with HTTP fallback |

## How They Can Work Together

### Hybrid Approach (Recommended for Production)

You can use **both** together for different use cases:

```
┌─────────────────────────────────────────────────────────┐
│                    Client Application                    │
└──────────────┬──────────────────────────┬────────────────┘
               │                          │
               │ WebSocket                │ Realtime WebSocket
               │ (Low-latency agent)      │ (Presence, rooms)
               │                          │
       ┌───────▼────────┐        ┌────────▼──────────┐
       │ WebSocket      │        │ Realtime Service  │
       │ Gateway        │        │                   │
       │ /api/gateway/ws│        │                   │
       └───────┬────────┘        └────────┬─────────┘
               │                           │
               │ Direct                    │ Webhook (HTTP POST)
               │                           │
       ┌───────▼───────────────────────────▼────────┐
       │         Worker (index.ts)                   │
       │  - handleGatewayWebSocket()                 │
       │  - handleRealtimeWebhook()                 │
       │  - publishToRealtime() (WebSocket)        │
       └───────────────┬────────────────────────────┘
                       │
                       │ Routes to
                       │
       ┌───────────────▼───────────────┐
       │   TravelAgent Durable Object   │
       │   - onMessage() (WebSocket)    │
       │   - handleMessage() (RPC)      │
       └───────────────┬───────────────┘
                       │
                       │ Publishes via
                       │
       ┌───────────────▼───────────────┐
       │ RealtimeConnector Durable Object│
       │   - Maintains WebSocket to       │
       │     Realtime Service            │
       │   - publishToRoom()            │
       └───────────────────────────────┘
```

### Use Cases

**WebSocket Gateway** - Best for:
- ✅ Low-latency agent interactions
- ✅ Direct, simple communication
- ✅ When you need full control over connections
- ✅ Cost-sensitive applications
- ✅ Single-user agent sessions

**Realtime Integration** - Best for:
- ✅ Multi-user rooms/chat
- ✅ Presence features (who's online)
- ✅ Message history
- ✅ When you want managed WebSocket infrastructure
- ✅ Complex real-time features

## Latency Optimization Strategies

### Current Implementation Analysis

**WebSocket Gateway:**
- **Message → Response**: Direct path through Durable Object
- **Latency**: ~50-200ms (depending on LLM processing)
- **Bottleneck**: LLM inference time (not network)

**Realtime Integration (Optimized):**
- **Message → Response**: HTTP webhook + WebSocket publish (via RealtimeConnector)
- **Latency**: ~80-250ms (reduced from 100-300ms with HTTP-only)
- **Bottleneck**: LLM inference time (network overhead minimized with persistent WebSocket)
- **Fallback**: Automatically falls back to HTTP API if WebSocket unavailable

### Optimization Opportunities

1. **Hybrid Approach**:
   - Use WebSocket Gateway for agent interactions (low latency)
   - Use Realtime for presence/rooms (rich features)
   - Both can connect to the same TravelAgent instance

2. **Realtime Optimization** (✅ Implemented):
   - ✅ RealtimeConnector Durable Object maintains persistent WebSocket connection to Realtime
   - ✅ Publishing via WebSocket instead of HTTP API (reduces latency)
   - ✅ Automatic reconnection with exponential backoff
   - ✅ Automatic fallback to HTTP API if WebSocket unavailable
   - ✅ Room subscription management

3. **Future Optimizations**:
   - Stream responses instead of single message publish
   - Batch multiple messages for efficiency
   - Connection pooling for multiple Realtime namespaces

## Recommendation

For **maximum performance and lowest latency**:
- Use **WebSocket Gateway** for agent interactions
- The direct connection provides the fastest path

For **rich features and managed infrastructure**:
- Use **Realtime Integration** 
- Accept slightly higher latency for additional features

For **best of both worlds**:
- Use **WebSocket Gateway** for agent communication
- Use **Realtime** for presence, rooms, and social features
- Both can coexist and connect to the same TravelAgent

## Current Implementation Status

✅ **WebSocket Gateway**: Fully implemented and tested
✅ **Realtime Integration**: Fully implemented with WebSocket optimization
   - ✅ Webhook handler for incoming messages (`/api/realtime/webhook`)
   - ✅ RealtimeConnector Durable Object for persistent WebSocket connections
   - ✅ WebSocket-based publishing (with HTTP fallback)
   - ✅ Automatic reconnection and error handling
✅ **Hybrid Usage**: Both approaches can coexist and connect to the same TravelAgent

## Implementation Details

### RealtimeConnector Durable Object

The `RealtimeConnector` Durable Object (`src/realtime-connector.ts`) maintains a persistent WebSocket connection to Cloudflare Realtime:

- **Connection Management**: Automatically connects and reconnects with exponential backoff
- **Room Subscription**: Tracks and manages subscriptions to Realtime rooms
- **Message Publishing**: Publishes agent responses via WebSocket (lower latency than HTTP)
- **Error Handling**: Gracefully handles connection failures and falls back to HTTP if needed

### Publishing Flow

1. Agent processes message and generates response
2. `publishToRealtime()` is called with room ID and response text
3. RealtimeConnector Durable Object is accessed (or created)
4. Message is published via persistent WebSocket connection
5. If WebSocket unavailable, automatically falls back to HTTP API

### Configuration

Required environment variables:
- `REALTIME_API_TOKEN`: API token for Cloudflare Realtime
- `REALTIME_NAMESPACE_ID`: Your Realtime namespace ID
- `REALTIME_ACCOUNT_ID`: (Optional) Your Cloudflare account ID

### Performance Benefits

- **Reduced Latency**: WebSocket publishing eliminates HTTP request/response overhead
- **Persistent Connection**: No connection establishment delay for each message
- **Automatic Fallback**: HTTP API ensures reliability if WebSocket fails
- **Scalability**: Durable Object handles connection management automatically

