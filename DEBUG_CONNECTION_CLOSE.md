# Debug: Connection Close (Code 1006) Analysis

## What's Happening

The WebSocket connection is closing with code **1006** (abnormal closure) immediately after sending the first message. This indicates an unhandled error or exception is occurring during message processing.

## Code Flow Analysis

### Step-by-Step Execution Path

```
1. Client sends message via WebSocket
   ↓
2. onMessage() receives message (line 171)
   ↓
3. Parses message → extracts text
   ↓
4. Calls handleMessage(text) (line 216)
   ↓
5. handleMessage() orchestrates:
   - State update
   - RAG check (if needed)
   - Tools check (if needed)
   - generateLLMResponse() (line 706)
   ↓
6. generateLLMResponse() calls:
   - AI.run() with stream: true (line 1277)
   ↓
7. Returns ReadableStream
   ↓
8. transformStreamForState() transforms stream (line 714)
   ↓
9. streamToWebSocket() reads and sends chunks (line 219)
   ↓
10. Connection closes with 1006
```

## Potential Failure Points

### 1. AI.run() with stream: true (Most Likely)

**Location**: `src/travel-agent.ts:1277`

```typescript
const stream = await this.env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct-fp8",
    {
        messages,
        max_tokens: 1024,
        stream: true, // Enable streaming
    },
);
```

**Possible Issues**:
- Workers AI might not support `stream: true` for this model
- The model might return a different format than expected
- The response might not be a ReadableStream

**Check**: Look for errors in server logs like:
- `"AI.run did not return ReadableStream"`
- `"AI.run returned null or undefined"`
- Any Workers AI errors

### 2. Stream Transformation Error

**Location**: `src/travel-agent.ts:237-313` (`transformStreamForState`)

**Possible Issues**:
- SSE parsing fails
- Stream reader error
- Controller error

**Check**: Look for:
- `"[TravelAgent] Stream transform error:"`
- `"[TravelAgent] Error closing stream controller:"`

### 3. WebSocket Send Error

**Location**: `src/travel-agent.ts:344-400` (`streamToWebSocket`)

**Possible Issues**:
- Connection already closed when trying to send
- `connection.send()` throws unhandled error
- Stream reading fails

**Check**: Look for:
- `"[TravelAgent] Error streaming to WebSocket:"`
- `"[TravelAgent] Failed to send message to WebSocket:"`

### 4. RAG or Tool Execution Error

**Location**: `src/travel-agent.ts:696-703`

**Possible Issues**:
- RAG search fails (Vectorize error)
- Tool calling fails (Amadeus API error)
- Error not caught properly

**Check**: Look for:
- `"RAG search error:"`
- `"Tool execution error:"`

## Debugging Steps

### Step 1: Check Server Logs

When you run `npm run dev`, watch the terminal for:

```
[TravelAgent] onMessage: Starting message processing
[TravelAgent] onMessage: Parsing message...
[TravelAgent] handleMessage: Starting...
[TravelAgent] generateLLMResponse: Starting...
[TravelAgent] generateLLMResponse: Calling AI.run...
```

**Look for**:
- Where the logs stop (indicates where error occurs)
- Any error messages
- Stack traces

### Step 2: Verify AI.run() Returns ReadableStream

The most likely issue is that `AI.run()` with `stream: true` might:
1. Not be supported for this model
2. Return a different format
3. Throw an error

**Check the logs for**:
```
[TravelAgent] generateLLMResponse: AI.run returned, type: ...
```

If it says anything other than `ReadableStream`, that's the issue.

### Step 3: Test Without Streaming

Temporarily disable streaming to see if that's the issue:

```typescript
// In generateLLMResponse(), change:
stream: false, // Temporarily disable streaming
```

Then accumulate the response and return as string (like before).

## Most Likely Cause

Based on the symptoms (connection closes immediately after message), the most likely cause is:

**`AI.run()` with `stream: true` is either:**
1. Not supported for `@cf/meta/llama-3.1-8b-instruct-fp8`
2. Returning a different format than ReadableStream
3. Throwing an error that's not being caught properly

## Quick Fix to Test

Add this check in `generateLLMResponse()`:

```typescript
const aiResponse = await this.env.AI.run(...);

console.log("AI response type:", typeof aiResponse);
console.log("AI response constructor:", aiResponse?.constructor?.name);
console.log("Is ReadableStream?", aiResponse instanceof ReadableStream);

if (!(aiResponse instanceof ReadableStream)) {
    // Fallback: return as string and convert to stream
    const text = typeof aiResponse === 'string' 
        ? aiResponse 
        : JSON.stringify(aiResponse);
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        }
    });
}
```

## Next Steps

1. **Run the test again** and check server logs
2. **Look for the last log message** before connection closes
3. **Check if AI.run() returns ReadableStream** or something else
4. **If not ReadableStream**, implement fallback or check Workers AI docs for correct streaming format

