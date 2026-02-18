# Testing Realtime Streaming

## Overview

The app now uses Realtime webhooks for streaming. Messages flow through:
1. Realtime webhook (HTTP POST) → Worker
2. Worker → TravelAgent (RPC call)
3. TravelAgent → Streams chunks via RealtimeConnector
4. RealtimeConnector → Publishes to Realtime room
5. Realtime → Delivers to frontend clients

## Quick Test (Without Realtime Setup)

### Option 1: Test Script

```bash
# Make sure dev server is running in another terminal
npm run dev

# In another terminal, run the test
npm run test:realtime
```

This will:
- Send webhook requests to `/api/realtime/webhook`
- Show request/response details
- Stream chunks happen in background (check server logs)

### Option 2: Manual cURL Test

```bash
curl -X POST http://localhost:8787/api/realtime/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "type": "message",
    "room": "test-room-123",
    "userId": "test-user-456",
    "message": {
      "text": "Plan a trip to Paris"
    },
    "timestamp": 1234567890
  }'
```

Expected response:
```json
{
  "success": true
}
```

**Note**: The webhook returns immediately. Streaming happens in the background via `ctx.waitUntil()`.

## What to Check

### 1. Server Logs

Watch the terminal where `npm run dev` is running. You should see:

```
[TravelAgent] handleMessageStreaming: Starting
[TravelAgent] handleMessage: Starting, input: Plan a trip to Paris
[TravelAgent] streamToRealtime: Starting
[TravelAgent] streamToRealtime: Publishing initial streaming message
[TravelAgent] streamToRealtime: Starting to read stream
[TravelAgent] streamToRealtime: Published chunk 1: "I'd be happy to help..."
[TravelAgent] streamToRealtime: Published chunk 2: " you plan..."
[TravelAgent] streamToRealtime: Stream complete. Total chunks: X, Total length: Y
```

### 2. RealtimeConnector Status

If RealtimeConnector is configured, check its status:

```bash
curl http://localhost:8787/api/realtime/connect/status
```

### 3. Error Handling

If RealtimeConnector is not configured, you'll see warnings in logs:
```
RealtimeConnector not available, falling back to HTTP API
```

## Testing with Actual Realtime

### Prerequisites

1. Set up Cloudflare Realtime:
   - Get `REALTIME_API_TOKEN`
   - Get `REALTIME_NAMESPACE_ID`
   - Get `REALTIME_ACCOUNT_ID`

2. Add to `wrangler.toml` or set as secrets:
   ```bash
   wrangler secret put REALTIME_API_TOKEN
   wrangler secret put REALTIME_NAMESPACE_ID
   wrangler secret put REALTIME_ACCOUNT_ID
   ```

3. Configure Realtime webhook:
   - Point webhook URL to: `https://your-worker.workers.dev/api/realtime/webhook`
   - Set webhook to trigger on "message" events

### Frontend Integration

Use Realtime SDK in your frontend:

```javascript
import { RealtimeClient } from '@cloudflare/realtime-client';

const client = new RealtimeClient({
  namespaceId: 'your-namespace-id',
  token: 'user-token'
});

// Connect and join room
await client.connect();
await client.joinRoom('user-123');

// Send message
client.publish('user-123', {
  type: 'message',
  text: 'Plan a trip to Paris'
});

// Listen for streaming chunks
client.on('message', (message) => {
  if (message.type === 'agent_response') {
    if (message.chunk) {
      // Progressive chunk
      console.log('Chunk:', message.text);
    } else if (message.complete) {
      // Complete response
      console.log('Complete:', message.text);
    } else if (message.streaming) {
      // Streaming started
      console.log('Streaming started...');
    }
  }
});
```

## Troubleshooting

### Issue: Webhook returns 200 but no streaming

**Check:**
1. Server logs for errors
2. RealtimeConnector is available: `(env as any).RealtimeConnector`
3. RPC call succeeds: Look for `handleMessageStreaming` logs

### Issue: "RealtimeConnector not available"

**Solution:**
- RealtimeConnector DO must be defined in `wrangler.toml`
- Check bindings in dev server output

### Issue: Chunks not appearing in Realtime

**Check:**
1. RealtimeConnector WebSocket connection is open
2. Room subscription is active
3. Realtime API credentials are correct
4. Webhook is properly configured in Realtime dashboard

## Testing Flow Summary

```
1. Send webhook → POST /api/realtime/webhook
   ↓
2. Webhook handler → Calls TravelAgent.handleMessageStreaming() (RPC)
   ↓
3. TravelAgent → Processes message (RAG/tools/LLM)
   ↓
4. TravelAgent → Streams chunks via streamToRealtime()
   ↓
5. RealtimeConnector → Publishes each chunk to Realtime room
   ↓
6. Realtime → Delivers chunks to frontend clients
```

## Next Steps

1. ✅ Test webhook endpoint works
2. ✅ Verify streaming logs appear
3. ⏳ Set up Realtime credentials (if needed)
4. ⏳ Integrate Realtime SDK in frontend
5. ⏳ Test end-to-end streaming

