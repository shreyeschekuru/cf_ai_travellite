# WebSocket Gateway Testing Guide

This guide explains how to test the WebSocket Gateway implementation for the TravelAgent.

## Prerequisites

1. **Start the development server:**
   ```bash
   npm run dev
   ```
   The server should be running on `http://localhost:8787`

2. **Install WebSocket dependency (for Node.js test script):**
   ```bash
   npm install --save-dev ws
   ```

## Testing Methods

### Method 1: Node.js Test Script (Recommended)

**File:** `test/test-websocket.js`

**Usage:**
```bash
npm run test:ws [userId]
# OR
node test/test-websocket.js [userId]
```

**Example:**
```bash
npm run test:ws test-user-123
# OR
node test/test-websocket.js test-user-123
```

**What it does:**
- Connects to the WebSocket Gateway endpoint
- Sends 3 test messages sequentially
- Displays responses in the console
- Automatically closes after all messages are processed


### Method 2: Manual Testing with `curl` (WebSocket upgrade test)

**Note:** `curl` doesn't support WebSocket directly, but you can test the HTTP upgrade:

```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: test" \
  "http://localhost:8787/api/gateway/ws?userId=test-user"
```

## Valid Output Examples

### ✅ Successful Connection

**Node.js Script Output:**
```
🚀 Testing WebSocket Gateway
📍 Connecting to: ws://localhost:8787/api/gateway/ws?userId=test-user
👤 User ID: test-user

✅ WebSocket connection established!

📤 Sending test messages...

📤 Sending message #1:
   Type: message
   Text: Hello, I want to plan a trip to Paris

📥 Response #1:
   Type: response
   ✅ Text: Hello! I'd be happy to help you plan your trip to Paris. Let me gather some information about your preferences and requirements...

📤 Sending message #2:
   Type: message
   Text: What flights are available from NYC to Paris on December 1st?

📥 Response #2:
   Type: response
   ✅ Text: I'll search for flights from NYC to Paris on December 1st. Let me check the available options for you...

📤 Sending message #3:
   Type: message
   Text: What is my budget?

📥 Response #3:
   Type: response
   ✅ Text: Based on our conversation, I don't have a budget specified yet. Would you like to set a budget for your trip?

✅ All test messages sent and received!
🔌 Closing connection...
🔌 Connection closed (code: 1000, reason: none)
```

### ✅ Valid Response Format

**JSON Structure:**
```json
{
  "type": "response",
  "text": "Agent's response text here...",
  "userId": "test-user"  // Optional
}
```

**Error Response Format:**
```json
{
  "type": "response",
  "error": "Error message here"
}
```

### ❌ Common Errors and Solutions

#### Error: "Expected WebSocket upgrade"
- **Cause:** Request missing `Upgrade: websocket` header
- **Solution:** Ensure you're using a WebSocket client, not a regular HTTP request

#### Error: "Missing userId parameter"
- **Cause:** `userId` query parameter not provided
- **Solution:** Add `?userId=your-user-id` to the WebSocket URL

#### Error: "Connection refused" or "ECONNREFUSED"
- **Cause:** Development server not running
- **Solution:** Run `npm run dev` in a separate terminal

#### Error: "Cannot find module 'ws'"
- **Cause:** `ws` package not installed
- **Solution:** Run `npm install --save-dev ws`

#### Error: "onRequest hasn't been implemented"
- **Cause:** Durable Object routing issue
- **Solution:** Verify `wrangler.jsonc` has correct Durable Object binding

## Expected Behavior

### 1. Connection Flow
1. Client connects to `/api/gateway/ws?userId=xxx`
2. Gateway validates WebSocket upgrade request
3. Gateway routes connection to TravelAgent Durable Object
4. Connection established successfully

### 2. Message Flow
1. Client sends JSON message: `{"type": "message", "text": "..."}`
2. `TravelAgent.onMessage()` receives and parses message
3. `TravelAgent.handleMessage()` processes the message:
   - Updates state with user message
   - Extracts trip information
   - Decides on RAG/tools/LLM usage
   - Generates response
4. Response sent back through WebSocket: `{"type": "response", "text": "..."}`

### 3. Response Characteristics

**Valid responses should:**
- ✅ Be JSON-formatted
- ✅ Include `type: "response"`
- ✅ Include `text` field with agent's response
- ✅ Optionally include `userId` field
- ✅ Be received within 1-5 seconds (depending on LLM/tool calls)

**Response content may include:**
- Trip planning suggestions
- Flight search results (if Amadeus tool is called)
- Questions to gather more information
- Confirmation of extracted trip details

## Testing Checklist

- [ ] Development server is running (`npm run dev`)
- [ ] WebSocket connection establishes successfully
- [ ] Messages can be sent from client
- [ ] Responses are received from agent
- [ ] Response format is valid JSON
- [ ] Error handling works (test with invalid messages)
- [ ] Multiple messages can be sent sequentially
- [ ] Connection closes gracefully
- [ ] Different user IDs create separate agent instances

## Advanced Testing

### Test with Multiple Users

Open multiple terminals and run:
```bash
# Terminal 1
npm run test:ws user-1

# Terminal 2
npm run test:ws user-2
```

Each user should have independent conversation state.

### Test Error Handling

Send invalid messages to test error responses:
```javascript
// Missing text field
ws.send(JSON.stringify({ type: "message" }));

// Empty text
ws.send(JSON.stringify({ type: "message", text: "" }));

// Invalid JSON
ws.send("not valid json");
```

## Troubleshooting

1. **Check server logs:** Look at the terminal running `npm run dev` for errors
2. **Verify bindings:** Ensure all bindings in `wrangler.jsonc` are correct
3. **Check `.dev.vars`:** Verify API keys are set for local development
4. **Network issues:** Ensure port 8787 is not blocked by firewall

## Next Steps

After successful testing:
- Integrate WebSocket client into your frontend application
- Add authentication/authorization
- Implement reconnection logic
- Add message queuing for offline scenarios
- Monitor WebSocket connection health

