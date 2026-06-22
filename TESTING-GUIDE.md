# Travellite End-to-End Testing Guide

**Status**: Migration to Agents SDK + Think reasoning complete. Ready for end-to-end testing.

## Quick Start

### Prerequisites
- Cloudflare API token with Workers, Durable Objects, Vectorize access
- `.dev.vars` file with credentials:
  ```
  AMADEUS_API_KEY=your-key
  AMADEUS_API_SECRET=your-secret
  CLOUDFLARE_API_TOKEN=your-token
  ```

### Run Tests
```bash
# Terminal 1: Start dev server
npm run dev

# Terminal 2: Run end-to-end tests
npm run test:e2e
```

---

## Test Suites

### 1. Stage 1 Tests: SDK Foundation

**Goal**: Verify Agents SDK migration works correctly

**Tests**:
```bash
npm run test:e2e
```

Covers:
- ✅ State management (`getState`, `prepareTurn`, etc.)
- ✅ Traditional pipeline (`handleMessage`)
- ✅ Trip management (`startNewTrip`, `loadTrip`)
- ✅ Message persistence
- ✅ API endpoint backward compatibility
- ✅ Error handling

**Expected Results**:
- All 7+ tests should pass
- No breaking changes to existing API
- Response times: < 5 seconds per request

---

### 2. Stage 2 Tests: Think Reasoning Loop

**Goal**: Verify multi-turn reasoning and tool orchestration work

**Manual Testing Steps**:

#### Test 2.1: Basic Tool Execution
```
Message: "Find me flights from NYC to Paris on 2026-07-21"

Expected:
- thinkChat() method is called
- LLM receives flight search tool definition
- Amadeus API is queried
- Response includes flight options
- No errors in console
```

#### Test 2.2: Multi-Tool Orchestration
```
Message: "I want to go to Paris for 5 days with a $3000 budget. Find flights, hotels, and activities."

Expected:
- thinkChat orchestrates multiple tools:
  - search_flights (flights NYC → Paris)
  - search_hotels (hotels in Paris)
  - search_activities (activities by coordinates)
- Results are formatted for LLM
- LLM reflects and provides comprehensive itinerary
- Takes 10-30 seconds (multiple API calls)
```

#### Test 2.3: Reasoning & Refinement
```
Message: "I like beaches and nightlife. What would you recommend for my Paris trip?"

Expected:
- thinkChat calls search_destination_info tool (RAG)
- LLM reasons about preferences
- Recommendations include beach activities + nightlife venues
- Shows multi-turn thinking in logs
```

#### Test 2.4: Fallback to Traditional Pipeline
```
Simulate thinkChat error by:
- Killing Vectorize service or
- Passing invalid destination

Expected:
- thinkChat catches error
- Falls back to handleMessage (traditional pipeline)
- Response still generated (graceful degradation)
- Console shows "Falling back to traditional pipeline"
```

---

### 3. Comparison Tests: Think vs Traditional

**Test 3.1: Response Quality**
```
Same query to both endpoints:
- handleMessage (traditional, keyword-based)
- thinkChat (reasoning-based)

Compare:
- Response relevance
- Tool accuracy
- Reflection quality
- Time taken
```

**Test 3.2: Complex Queries**
```
Traditional pipeline struggles with:
- "I want to visit 3 cities in 2 weeks"
- "Find the cheapest option that still has good ratings"
- "I prefer hiking and museums, no nightlife"

Think should excel at these due to reasoning loops.
```

---

### 4. Load & Performance Tests

**Test 4.1: Concurrent Messages**
```bash
# Send 5 messages in parallel
for i in {1..5}; do
  curl -X POST http://localhost:8787/api/agents/TravelAgent/stream \
    -H "Content-Type: application/json" \
    -d '{"message":"Find flights to Paris","sessionId":"user-$i"}' &
done
wait

Expected: All complete within 30 seconds
```

**Test 4.2: Long Conversations**
```
Send 10 messages in sequence to same session:
1. "Plan a trip to Paris"
2. "For July"
3. "7 days"
4. "Find flights"
5. "What about hotels?"
... etc

Expected:
- State persists correctly
- Message history tracked
- No degradation in response quality
- Thread management works
```

---

## Test Scenarios by Feature

### Thread Management (Stage 1)
```
1. getState() - get initial state
2. handleMessage() - send message (creates first thread)
3. getState() - verify message persisted
4. startNewTrip() - create second thread
5. getState() - verify on new thread
6. loadTrip(thread1_id) - switch back
7. getState() - verify switched back
```

### Tool Orchestration (Stage 2)
```
1. Call thinkChat with "flights NYC to Paris"
   → expect flight search tool
2. Call thinkChat with "hotels in Paris with 4+ rating"
   → expect hotel search tool with filters
3. Call thinkChat with complex multi-tool query
   → expect multiple tools to be orchestrated
4. Verify tool results are formatted correctly
```

### Streaming (Stage 1 & 2)
```
1. Call /api/agents/TravelAgent/stream endpoint
2. Receive SSE stream
3. Verify tokens arrive progressively
4. Verify message saved after stream complete
5. Test with thinkChat (same endpoint, different method)
```

---

## Debugging Commands

### Check Server Logs
```bash
# Watch wrangler output
npm run dev

# Monitor specific features
grep "thinkChat\|handleMessage\|registerThinkTools" output.log
```

### Test Specific RPC Method
```bash
curl -X POST http://localhost:8787/agents/TravelAgent/test-user/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "type": "rpc",
    "id": "test-1",
    "method": "thinkChat",
    "args": ["Find flights to Paris"]
  }' | jq
```

### Monitor Tool Execution
```bash
# In code, add:
console.log("[thinkChat] Tools registered:", tools.map(t => t.name));
console.log("[thinkChat] Calling tool:", toolName);
console.log("[thinkChat] Tool result:", result);
```

---

## Expected Behavior by Endpoint

### Stage 1: Traditional Pipeline
- **Endpoint**: POST /api/agents/TravelAgent/stream
- **Method**: handleMessage
- **Flow**: Keyword detection → RAG/Tools in parallel → LLM response
- **Latency**: 2-5 seconds
- **Deterministic**: Yes (same keywords = same tools)

### Stage 2: Think Reasoning
- **Endpoint**: POST /api/agents/TravelAgent/stream (same)
- **Method**: thinkChat (via RPC /agents/TravelAgent/{user}/rpc)
- **Flow**: Register tools → LLM reads tools → LLM decides → Execute → Reflect → Done
- **Latency**: 3-10 seconds (depends on reflection loops)
- **Deterministic**: No (LLM reasoning varies)

---

## Validation Checklist

- [ ] TypeScript compiles: `npm run check`
- [ ] getState returns correct structure
- [ ] prepareTurn classifies intent
- [ ] handleMessage returns stream
- [ ] thinkChat returns stream
- [ ] startNewTrip creates new thread
- [ ] loadTrip switches threads
- [ ] appendConversation persists messages
- [ ] Flight search tool works
- [ ] Hotel search tool works
- [ ] Activities search tool works
- [ ] RAG search tool works
- [ ] Fallback to pipeline works on error
- [ ] Message history tracked correctly
- [ ] Trip preferences extracted
- [ ] Stream completes and persists
- [ ] API endpoints return correct status
- [ ] Error handling graceful
- [ ] Concurrent requests work
- [ ] Long conversations persist

---

## Known Limitations & TODOs

### Limitations
- Think is experimental (may have edge cases)
- RAG requires Vectorize data (seed with `npm run seed:rag`)
- Amadeus uses sandbox (not real pricing)
- No authentication on endpoints (for testing)

### TODOs for Production
- [ ] Add authentication/authorization
- [ ] Implement rate limiting
- [ ] Add monitoring & observability
- [ ] Optimize tool schemas based on usage
- [ ] Fine-tune LLM system prompts
- [ ] Add more specialized tools
- [ ] Implement scheduling/reminders
- [ ] Add React frontend hooks

---

## Success Criteria

✅ **Stage 1 Success**: 
- All 54 SDK foundation tests pass
- Backward compatibility 100%
- No breaking changes

✅ **Stage 2 Success**:
- All 30 Think tests pass
- Tool orchestration works
- Multi-turn reasoning demonstrated
- Fallback mechanism proven

✅ **End-to-End Success**:
- 7+ core tests pass
- handleMessage works reliably
- thinkChat works and shows reasoning
- State persists across messages
- Thread management works
- Performance acceptable (< 10s per query)

---

## Rollout Plan

1. **Testing Phase** (current)
   - Run e2e tests locally
   - Validate both flows
   - Stress test with concurrent requests

2. **Staging Phase**
   - Deploy to staging environment
   - Run real Amadeus API calls
   - Populate Vectorize with real data
   - Gather quality metrics

3. **Production Phase**
   - Blue-green deployment
   - A/B test Think vs Traditional
   - Monitor LLM reasoning quality
   - Collect user feedback

---

## Support

For issues or questions:
1. Check logs: `npm run dev` console output
2. Review error messages in response
3. Check CLAUDE.md for architecture details
4. Test with simpler queries first
5. Verify .dev.vars credentials
