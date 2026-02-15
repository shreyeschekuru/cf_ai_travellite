# Tool Calling and HTTP Client Testing Guide

This guide explains how to test the RPC (Remote Procedure Call) functionality for calling TravelAgent methods via HTTP.

## Prerequisites

1. **Start the development server:**
   ```bash
   npm run dev
   ```
   The server should be running on `http://localhost:8787`

## Testing Methods

### Method 1: Node.js Test Script (Recommended)

**File:** `test/test-tool-calling.js`

**Usage:**
```bash
npm run test:tools [sessionName]
# OR
node test/test-tool-calling.js [sessionName]
```

**Example:**
```bash
npm run test:tools test-session
# OR
node test/test-tool-calling.js test-session
```

**What it does:**
- Tests multiple RPC calls to TravelAgent methods
- Tests `handleMessage()` with various inputs
- Tests `searchFlights()` tool directly
- Tests error handling for invalid methods
- Displays comprehensive test results

### Method 2: Manual Testing with `curl`

**Test handleMessage:**
```bash
curl -X POST http://localhost:8787/agents/TravelAgent/test-session/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "type": "rpc",
    "id": "test-1",
    "method": "handleMessage",
    "args": ["Hello, I want to plan a trip to Paris"]
  }'
```

**Test searchFlights:**
```bash
curl -X POST http://localhost:8787/agents/TravelAgent/test-session/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "type": "rpc",
    "id": "test-2",
    "method": "searchFlights",
    "args": [{
      "origin": "NYC",
      "destination": "LAX",
      "departureDate": "2025-12-01",
      "adults": 1
    }]
  }'
```

## Valid Output Examples

### Successful RPC Response

**Response Format:**
```json
{
  "type": "rpc",
  "id": "test-1-1234567890",
  "success": true,
  "result": {
    "success": true,
    "message": "Flight search functionality to be implemented",
    "params": {
      "origin": "NYC",
      "destination": "LAX",
      "departureDate": "2025-12-01",
      "adults": 1
    }
  }
}
```

**For handleMessage:**
```json
{
  "type": "rpc",
  "id": "test-1-1234567890",
  "success": true,
  "result": "Paris, the City of Light! I'd be delighted to help you plan a trip..."
}
```

### Error Response Format

**Method Not Found:**
```json
{
  "type": "rpc",
  "id": "test-1-1234567890",
  "success": false,
  "error": "Method nonExistentMethod not found or not callable"
}
```

**Invalid Request:**
```json
{
  "type": "rpc",
  "id": "test-1-1234567890",
  "success": false,
  "error": "Error message here"
}
```

## Test Cases Covered

### 1. handleMessage Tests
- Basic trip planning request
- Flight search request (triggers tool usage)
- Budget query
- Complex request with dates and budget

### 2. searchFlights Tests
- Direct tool call (one-way flight)
- Round trip with multiple passengers

### 3. Error Handling Tests
- Invalid method name
- Network errors
- Parse errors

## Expected Behavior

### 1. RPC Request Format
```json
{
  "type": "rpc",
  "id": "unique-request-id",
  "method": "methodName",
  "args": [arg1, arg2, ...]
}
```

### 2. RPC Response Format
```json
{
  "type": "rpc",
  "id": "same-request-id",
  "success": true,
  "result": { ... }
}
```

### 3. Callable Methods

**handleMessage(input: string): Promise<string>**
- Processes user messages through RAG, tools, and LLM
- Updates agent state
- Returns agent response string

**searchFlights(params: {...}): Promise<{...}>**
- Searches for flights using Amadeus API
- Returns flight search results
- Currently returns placeholder (to be implemented)

## Testing Checklist

- [ ] Development server is running (`npm run dev`)
- [ ] RPC endpoint is accessible (`/agents/TravelAgent/{session}/rpc`)
- [ ] `handleMessage` method works correctly
- [ ] `searchFlights` method works correctly
- [ ] Error handling works for invalid methods
- [ ] Multiple sequential calls work
- [ ] Different sessions create separate agent instances
- [ ] Response format is valid JSON
- [ ] Request/response IDs match

## Advanced Testing

### Test with Multiple Sessions

Open multiple terminals and run:
```bash
# Terminal 1
npm run test:tools session-1

# Terminal 2
npm run test:tools session-2
```

Each session should have independent agent state.

### Test Error Scenarios

**Missing method:**
```bash
curl -X POST http://localhost:8787/agents/TravelAgent/test/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "type": "rpc",
    "id": "test-1",
    "method": "invalidMethod",
    "args": []
  }'
```

**Invalid JSON:**
```bash
curl -X POST http://localhost:8787/agents/TravelAgent/test/rpc \
  -H "Content-Type: application/json" \
  -d 'invalid json'
```

**Missing required fields:**
```bash
curl -X POST http://localhost:8787/agents/TravelAgent/test/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "type": "rpc",
    "id": "test-1"
  }'
```

## Troubleshooting

1. **Check server logs:** Look at the terminal running `npm run dev` for errors
2. **Verify endpoint:** Ensure the RPC endpoint path is correct
3. **Check session name:** Different session names create different agent instances
4. **Network issues:** Ensure port 8787 is not blocked by firewall
5. **Method availability:** Verify the method is marked with `@callable` decorator

## RPC vs WebSocket

| Feature | RPC (HTTP) | WebSocket |
|---------|------------|-----------|
| **Connection** | Request/Response | Persistent |
| **Latency** | Higher (per request) | Lower (persistent) |
| **Use Case** | One-off calls, tools | Real-time chat |
| **State** | Stateless | Stateful |
| **Error Handling** | Per request | Connection-level |

## Next Steps

After successful testing:
- Integrate RPC calls into your frontend application
- Add authentication/authorization
- Implement rate limiting
- Add request validation
- Monitor RPC call performance

