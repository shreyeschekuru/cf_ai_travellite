# Realtime Streaming Diagnostic

## Issue Identified

The webhook returns `200 OK` but no LLM responses appear. The root cause is **RealtimeConnector requires Realtime credentials** that are likely not configured.

## Architecture Flow

```
1. Webhook receives POST → /api/realtime/webhook
   ↓
2. Webhook calls TravelAgent.handleMessageStreaming() via RPC
   ↓
3. TravelAgent processes message (RAG/tools/LLM) → Returns ReadableStream
   ↓
4. TravelAgent.streamToRealtime() tries to publish chunks
   ↓
5. Calls RealtimeConnector.publishToRoom()
   ↓
6. RealtimeConnector.connect() requires:
   - REALTIME_API_TOKEN
   - REALTIME_NAMESPACE_ID
   ↓
7. If credentials missing → Connection fails → Streaming fails silently
```

## Root Causes

### 1. Missing Realtime Credentials

**Problem**: RealtimeConnector tries to connect to Cloudflare Realtime but credentials are not set.

**Location**: `src/realtime-connector.ts:36-38`
```typescript
if (!this.env.REALTIME_API_TOKEN || !this.env.REALTIME_NAMESPACE_ID) {
    throw new Error("Realtime not configured");
}
```

**Impact**: When `publishToRoom()` is called, it tries to `connect()`, which throws an error if credentials are missing.

### 2. Silent Failure in Streaming

**Problem**: When RealtimeConnector fails, the error is caught but the LLM response is lost.

**Location**: `src/travel-agent.ts:386-410`
- Error is caught and logged
- But the accumulated response is not returned anywhere
- Frontend never receives the response

### 3. No Fallback Mechanism

**Problem**: If RealtimeConnector is unavailable, there's no way to get the response.

**Current behavior**: 
- Streaming fails
- Response is lost
- No error message to frontend

## Solutions Implemented

### 1. Added Credential Checks

**File**: `src/travel-agent.ts:267-274`
- Checks if RealtimeConnector is available
- Checks if Realtime credentials are configured
- Logs warnings if not available

### 2. Graceful Fallback

**File**: `src/travel-agent.ts:270-277`
- If RealtimeConnector not available:
  - Accumulates the stream
  - Logs the response
  - Returns early (doesn't throw)

### 3. Better Error Handling

**File**: `src/realtime-connector.ts:203-230`
- Checks credentials before attempting publish
- Returns warning response if not configured
- Detailed error logging

**File**: `src/travel-agent.ts:279-296, 363-378`
- Try-catch around each publish call
- Continues streaming even if publish fails
- Logs errors without breaking the stream

### 4. Enhanced Logging

Added detailed logging at every step:
- `[Webhook]` - Webhook handler logs
- `[TravelAgent]` - Agent processing logs
- `[RealtimeConnector]` - Connector operation logs

## How to Fix

### Option 1: Configure Realtime (For Production)

1. Get Realtime credentials from Cloudflare Dashboard
2. Set as secrets:
   ```bash
   wrangler secret put REALTIME_API_TOKEN
   wrangler secret put REALTIME_NAMESPACE_ID
   wrangler secret put REALTIME_ACCOUNT_ID
   ```

3. Or add to `wrangler.jsonc` (for local dev):
   ```jsonc
   "vars": {
     "REALTIME_API_TOKEN": "your-token",
     "REALTIME_NAMESPACE_ID": "your-namespace-id",
     "REALTIME_ACCOUNT_ID": "your-account-id"
   }
   ```

### Option 2: Test Without Realtime (Current State)

With the fixes:
- Streaming will still work
- Responses will be logged to console
- RealtimeConnector will return warnings but not fail
- You can see the LLM responses in server logs

**Check server logs for**:
```
[TravelAgent] streamToRealtime: Realtime credentials configured: false
[RealtimeConnector] Realtime not configured - message not published
[TravelAgent] streamToRealtime: Accumulated response: "..."
```

## Testing

1. **Send webhook request**:
   ```bash
   curl -X POST http://localhost:8787/api/realtime/webhook \
     -H "Content-Type: application/json" \
     -d '{"type":"message","room":"test-room","userId":"test-user","message":{"text":"Hello"}}'
   ```

2. **Check server logs** for:
   - `[Webhook] Starting background streaming RPC call`
   - `[TravelAgent] RPC call received: handleMessageStreaming`
   - `[TravelAgent] handleMessageStreaming: Starting`
   - `[TravelAgent] streamToRealtime: Starting`
   - `[RealtimeConnector] Realtime not configured` (if credentials missing)
   - `[TravelAgent] streamToRealtime: Accumulated response` (if RealtimeConnector unavailable)

3. **Expected behavior**:
   - Webhook returns `200 OK` immediately
   - Background processing logs appear
   - If Realtime configured: chunks published to Realtime
   - If Realtime not configured: response logged to console

## Current Status

✅ **Fixed**: Error handling and logging
✅ **Fixed**: Graceful fallback when RealtimeConnector unavailable
✅ **Fixed**: Detailed logging at each step
⏳ **Pending**: Realtime credentials configuration (optional)

## Next Steps

1. **Test the fixes**: Send a webhook and check logs
2. **Verify**: Look for `[TravelAgent]` and `[RealtimeConnector]` logs
3. **Configure Realtime** (optional): If you want actual Realtime publishing
4. **Check logs**: The LLM response should now appear in logs even if Realtime isn't configured

