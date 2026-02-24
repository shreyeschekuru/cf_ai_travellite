# RPC Call Hang Analysis

## Potential Causes of Infinite RPC Hangs

### 1. **stub.fetch() Hanging** ⚠️ **MOST LIKELY**

**Location**: `src/index.ts:67` in `routeTravelAgentRequest()`

```typescript
const response = await stub.fetch(modifiedRequest); // Could hang here indefinitely
```

**Causes**:
- **Durable Object not responding**: DO crashed, stuck in infinite loop, or overloaded
- **DO processing another request**: Durable Objects are single-threaded - if another request is blocking, new requests queue
- **DO waiting on external resource**: Waiting for API call, database, or network request that never completes
- **DO deadlock**: Multiple requests waiting on each other
- **Network/routing issue**: Cloudflare routing problem between Worker and DO

**Symptoms**:
- Log shows `"[routeTravelAgentRequest] Calling stub.fetch()..."` but never `"stub.fetch() completed"`
- No response from DO's `onRequest()` method

**Fix**: Add timeout wrapper:

```typescript
// Add timeout to stub.fetch()
const timeoutPromise = new Promise<Response>((_, reject) => {
  setTimeout(() => reject(new Error("RPC timeout after 30s")), 30000);
});

const response = await Promise.race([
  stub.fetch(modifiedRequest),
  timeoutPromise
]);
```

---

### 2. **request.text() Hanging in onRequest()**

**Location**: `src/travel-agent.ts:94` in `onRequest()`

```typescript
const body = await request.text(); // Could hang if body stream never closes
```

**Causes**:
- Request body stream not properly closed by sender
- Malformed request with incomplete body
- Network issue causing stream to hang

**Symptoms**:
- Log shows `"[TravelAgent] onRequest called"` but never `"Request body:"`
- Request stuck reading body

**Fix**: Add timeout or use `request.arrayBuffer()` with timeout:

```typescript
const bodyPromise = request.text();
const timeoutPromise = new Promise<string>((_, reject) => {
  setTimeout(() => reject(new Error("Body read timeout")), 5000);
});

const body = await Promise.race([bodyPromise, timeoutPromise]);
```

---

### 3. **setState() Blocking**

**Location**: `src/travel-agent.ts:777` in `handleMessage()`

```typescript
this.setState({ ... }); // Could block if state update hangs
```

**Causes**:
- Durable Object state storage issue
- State too large causing write timeout
- Concurrent state updates causing lock contention

**Symptoms**:
- Log shows `"Step 1 - Updating state"` but never `"Step 2 - Extracting trip info"`

**Fix**: Make state updates non-blocking or add timeout:

```typescript
// Wrap in try-catch and continue even if state update fails
try {
  this.setState({ ... });
} catch (error) {
  console.error("State update failed, continuing:", error);
}
```

---

### 4. **Promise.all() Hanging (RAG/Tools)**

**Location**: `src/travel-agent.ts:817` in `handleMessage()`

```typescript
const [ragResult, toolsResult] = await Promise.all([ragPromise, toolsPromise]);
```

**Causes**:
- **RAG promise never resolves**: `performRAG()` stuck (Vectorize query hangs, embedding generation hangs)
- **Tools promise never resolves**: `useTools()` stuck (Amadeus API call hangs, LLM intent detection hangs)
- **Timeout promises not working**: If `setTimeout` doesn't fire (unlikely but possible)

**Symptoms**:
- Log shows `"Running RAG and tools in parallel..."` but never completes
- One of the promises never resolves

**Fix**: Already has timeouts, but verify they're working:

```typescript
// Verify timeout is actually firing
const ragPromise = needsRAG
  ? Promise.race([
      this.performRAG(input).catch(err => {
        console.error("RAG error:", err);
        return "";
      }),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          console.log("RAG timeout fired");
          resolve("");
        }, 5000);
      }),
    ])
  : Promise.resolve("");
```

---

### 5. **generateLLMResponse() Hanging**

**Location**: `src/travel-agent.ts:826` in `handleMessage()`

```typescript
stream = await this.generateLLMResponse(input, context, toolResults);
```

**Causes**:
- Workers AI API not responding
- LLM request stuck in queue
- Network issue to Workers AI service

**Symptoms**:
- Log shows `"Step 4 - Generating LLM response"` but never completes
- No stream returned

**Fix**: Add timeout to LLM call:

```typescript
const llmPromise = this.generateLLMResponse(input, context, toolResults);
const timeoutPromise = new Promise<ReadableStream>((_, reject) => {
  setTimeout(() => reject(new Error("LLM timeout")), 30000);
});

stream = await Promise.race([llmPromise, timeoutPromise]);
```

---

### 6. **Durable Object Single-Threaded Blocking**

**Root Cause**: Durable Objects process requests sequentially. If one request is stuck, all subsequent requests queue.

**Scenario**:
1. Request A calls `handleMessage()` → starts RAG/Tools/LLM (takes 30s)
2. Request B (RPC) arrives → waits for Request A to complete
3. If Request A hangs, Request B hangs forever

**Symptoms**:
- Multiple RPC calls queue up
- First request never completes
- All subsequent requests hang

**Fix**: Ensure `handleMessageStreaming()` returns immediately (it does), but verify `handleMessage()` is truly fire-and-forget:

```typescript
// In handleMessageStreaming(), verify it's truly fire-and-forget
async handleMessageStreaming(...) {
  // This should return immediately
  this.handleMessage(input)
    .then(...)
    .catch(...);
  
  // Return immediately - don't await handleMessage
  return { success: true, message: "Processing started" };
}
```

---

### 7. **Missing Error Handling in Promise Chain**

**Location**: `src/travel-agent.ts:730` in `handleMessageStreaming()`

If `handleMessage()` throws synchronously (before promise chain), it could hang:

```typescript
this.handleMessage(input)  // If this throws synchronously, promise chain never starts
  .then((stream) => { ... })
  .catch((error) => { ... });
```

**Fix**: Wrap in try-catch:

```typescript
try {
  this.handleMessage(input)
    .then((stream) => { ... })
    .catch((error) => { ... });
} catch (syncError) {
  console.error("Synchronous error in handleMessage:", syncError);
  // Handle error
}
```

---

### 8. **RealtimeConnector Blocking**

**Location**: `src/travel-agent.ts:254` in `streamToRealtime()`

If `RealtimeConnector` stub.fetch() hangs when publishing:

```typescript
await stub.fetch(new Request("https://realtime-connector/publish", ...));
```

**Causes**:
- RealtimeConnector DO not responding
- WebSocket connection issue
- Publishing message hangs

**Fix**: Add timeout and make non-blocking:

```typescript
const publishPromise = stub.fetch(...);
const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error("Publish timeout")), 5000);
});

try {
  await Promise.race([publishPromise, timeoutPromise]);
} catch (error) {
  console.error("Publish failed, continuing:", error);
  // Continue streaming even if publish fails
}
```

---

## Debugging Steps

### 1. Add Comprehensive Logging

Add logs at every step to identify where it hangs:

```typescript
console.log("[DEBUG] Step 1: Before stub.fetch()");
const response = await stub.fetch(modifiedRequest);
console.log("[DEBUG] Step 2: After stub.fetch(), status:", response.status);
```

### 2. Check Durable Object Status

Verify the DO is responding:

```typescript
// Add health check endpoint
if (url.pathname === "/health") {
  return Response.json({ status: "ok", state: this.state });
}
```

### 3. Monitor Request Queue

Check if requests are queuing:

```typescript
// Track active requests
private activeRequests = 0;

async onRequest(request: Request): Promise<Response> {
  this.activeRequests++;
  console.log(`[TravelAgent] Active requests: ${this.activeRequests}`);
  
  try {
    // ... handle request
  } finally {
    this.activeRequests--;
  }
}
```

### 4. Add Timeouts Everywhere

Wrap all async operations with timeouts:

```typescript
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(errorMsg)), timeoutMs);
    })
  ]);
}
```

---

## Recommended Fixes (Priority Order)

1. **Add timeout to stub.fetch()** (HIGHEST PRIORITY)
2. **Add timeout to request.text()** in onRequest()
3. **Add timeout to generateLLMResponse()**
4. **Make all state updates non-blocking**
5. **Add timeout to RealtimeConnector publish**
6. **Add comprehensive error handling**
7. **Add request queue monitoring**

---

## Quick Fix Implementation

Here's a quick fix for the most likely issue (stub.fetch() hanging):

```typescript
async function routeTravelAgentRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  // ... existing code ...
  
  console.log("[routeTravelAgentRequest] Calling stub.fetch()...");
  
  // Add timeout wrapper
  const fetchWithTimeout = async (): Promise<Response> => {
    return stub.fetch(modifiedRequest);
  };
  
  const timeout = new Promise<Response>((_, reject) => {
    setTimeout(() => {
      reject(new Error("RPC call timeout after 30 seconds"));
    }, 30000);
  });
  
  try {
    const response = await Promise.race([fetchWithTimeout(), timeout]);
    console.log("[routeTravelAgentRequest] stub.fetch() completed, status:", response.status);
    return response;
  } catch (error) {
    console.error("[routeTravelAgentRequest] stub.fetch() failed:", error);
    // Return error response instead of hanging
    return new Response(
      JSON.stringify({ error: "RPC timeout", message: error instanceof Error ? error.message : "Unknown" }),
      { status: 504, headers: { "content-type": "application/json" } }
    );
  }
}
```

