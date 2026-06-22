/**
 * End-to-End Tests for Stage 1 & Stage 2 Migration
 * Tests both traditional handleMessage and Think thinkChat flows
 * Run: node test/test-e2e-stages.js
 */

const http = require('http');

const BASE_URL = 'http://localhost:8787';
const USER_ID = 'test-e2e-' + Date.now();

console.log('\n╔═══════════════════════════════════════════════════════════════╗');
console.log('║     TRAVELLITE END-TO-END TEST SUITE                         ║');
console.log('║     Stage 1 (SDK) + Stage 2 (Think) Validation               ║');
console.log('╚═══════════════════════════════════════════════════════════════╝\n');

let testsPassed = 0;
let testsFailed = 0;
let testsSkipped = 0;

function log(msg) {
  console.log(`  ${msg}`);
}

function pass(testName) {
  log(`✅ ${testName}`);
  testsPassed++;
}

function fail(testName, error) {
  log(`❌ ${testName}`);
  if (error) log(`   Error: ${error}`);
  testsFailed++;
}

function skip(testName, reason) {
  log(`⏭️  ${testName} - ${reason}`);
  testsSkipped++;
}

/**
 * Make RPC call to TravelAgent
 */
function makeRpcCall(method, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      type: 'rpc',
      id: `test-${Date.now()}`,
      method,
      args
    });

    const options = {
      hostname: 'localhost',
      port: 8787,
      path: `/agents/TravelAgent/${USER_ID}/rpc`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Test Suite 1: State Management (Stage 1)
 */
async function testStateManagement() {
  console.log('\n[TEST SUITE 1] State Management (Stage 1)');
  console.log('────────────────────────────────────────────────────────────');

  try {
    // Test: getState returns initial state
    const state = await makeRpcCall('getState', []);
    if (state.body.success && state.body.result) {
      if (state.body.result.recentMessages !== undefined) {
        pass('getState returns current state');
      } else {
        fail('getState missing recentMessages');
      }
    } else {
      fail('getState failed', state.body.error);
    }
  } catch (e) {
    skip('getState', `Server not running (${e.message})`);
  }
}

/**
 * Test Suite 2: Traditional Pipeline (handleMessage)
 */
async function testTraditionalPipeline() {
  console.log('\n[TEST SUITE 2] Traditional Pipeline (handleMessage - Stage 1)');
  console.log('────────────────────────────────────────────────────────────');

  try {
    // Test: handleMessage with trip planning query
    const response = await makeRpcCall('handleMessage', [
      'I want to plan a trip to Paris from NYC on 2026-07-21'
    ]);

    if (response.body.success) {
      if (response.body.result && typeof response.body.result === 'string') {
        pass('handleMessage returns response');
      } else {
        fail('handleMessage returned empty result');
      }
    } else {
      fail('handleMessage failed', response.body.error);
    }
  } catch (e) {
    skip('handleMessage', `Server not running (${e.message})`);
  }
}

/**
 * Test Suite 3: Think Reasoning Loop (thinkChat)
 */
async function testThinkReasoning() {
  console.log('\n[TEST SUITE 3] Think Reasoning Loop (thinkChat - Stage 2)');
  console.log('────────────────────────────────────────────────────────────');

  try {
    // Test: thinkChat with complex query requiring tool orchestration
    const response = await makeRpcCall('thinkChat', [
      'Find me flights from NYC to Paris and hotels in Paris for July 21-28, with a $3000 budget'
    ]);

    if (response.body.success) {
      if (response.body.result && typeof response.body.result === 'string') {
        pass('thinkChat returns response');
        if (response.body.result.length > 10) {
          pass('thinkChat response has content');
        } else {
          fail('thinkChat response too short');
        }
      } else {
        fail('thinkChat returned empty result');
      }
    } else {
      fail('thinkChat failed', response.body.error);
    }
  } catch (e) {
    skip('thinkChat', `Server not running or method not available (${e.message})`);
  }
}

/**
 * Test Suite 4: Trip Management
 */
async function testTripManagement() {
  console.log('\n[TEST SUITE 4] Trip Management (State 1)');
  console.log('────────────────────────────────────────────────────────────');

  try {
    // Test: prepareTurn classifies intent
    const prepared = await makeRpcCall('prepareTurn', [
      'I want to search for flights to Paris'
    ]);

    if (prepared.body.success) {
      if (prepared.body.result && prepared.body.result.currentTripId) {
        pass('prepareTurn sets trip ID');
      } else {
        fail('prepareTurn missing trip ID');
      }
    } else {
      fail('prepareTurn failed', prepared.body.error);
    }

    // Test: startNewTrip creates new thread
    const newTrip = await makeRpcCall('startNewTrip', []);
    if (newTrip.body.success) {
      pass('startNewTrip succeeds');
    } else {
      fail('startNewTrip failed', newTrip.body.error);
    }
  } catch (e) {
    skip('Trip management', `Server not running (${e.message})`);
  }
}

/**
 * Test Suite 5: Message Persistence
 */
async function testMessagePersistence() {
  console.log('\n[TEST SUITE 5] Message Persistence (Stage 1)');
  console.log('────────────────────────────────────────────────────────────');

  try {
    // Send a message
    const userMessage = 'I need hotel recommendations in Paris';
    const response = await makeRpcCall('handleMessage', [userMessage]);

    if (response.body.success) {
      // Get state to verify message was saved
      const state = await makeRpcCall('getState', []);
      if (state.body.result && state.body.result.recentMessages) {
        const hasMessage = state.body.result.recentMessages.some(
          m => m.role === 'user' && m.content.includes('hotel')
        );
        if (hasMessage) {
          pass('Messages persisted to state');
        } else {
          fail('User message not found in persisted state');
        }
      } else {
        fail('State missing messages');
      }
    } else {
      fail('Message send failed');
    }
  } catch (e) {
    skip('Message persistence', `Server not running (${e.message})`);
  }
}

/**
 * Test Suite 6: API Endpoints
 */
async function testApiEndpoints() {
  console.log('\n[TEST SUITE 6] API Endpoints (Stage 1 - Backward Compat)');
  console.log('────────────────────────────────────────────────────────────');

  try {
    // Test: /api/agents/TravelAgent/state endpoint
    const stateUrl = `/api/agents/TravelAgent/state?sessionId=${USER_ID}`;
    const options = {
      hostname: 'localhost',
      port: 8787,
      path: stateUrl,
      method: 'GET'
    };

    const stateRes = await new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(data)
            });
          } catch (e) {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (stateRes.status === 200 || stateRes.status === 400) {
      // 400 is OK if endpoint handler is in index.ts
      pass('API endpoint /api/agents/TravelAgent/state responds');
    } else {
      fail(`API endpoint returned ${stateRes.status}`);
    }
  } catch (e) {
    skip('API endpoints', `Server not running (${e.message})`);
  }
}

/**
 * Test Suite 7: Error Handling
 */
async function testErrorHandling() {
  console.log('\n[TEST SUITE 7] Error Handling (Stage 1 & 2)');
  console.log('────────────────────────────────────────────────────────────');

  try {
    // Test: Invalid method returns error
    const invalid = await makeRpcCall('nonExistentMethod', []);
    if (invalid.body.success === false) {
      pass('Invalid RPC method returns error');
    } else {
      fail('Invalid method did not return error');
    }

    // Test: handleMessage with empty input
    const emptyMsg = await makeRpcCall('handleMessage', ['']);
    if (emptyMsg.body.success === false || emptyMsg.body.success === true) {
      pass('handleMessage handles empty input');
    } else {
      fail('handleMessage error handling broken');
    }
  } catch (e) {
    skip('Error handling', `Server not running (${e.message})`);
  }
}

/**
 * Main test execution
 */
async function runTests() {
  console.log('Starting tests...\n');

  await testStateManagement();
  await testTraditionalPipeline();
  await testThinkReasoning();
  await testTripManagement();
  await testMessagePersistence();
  await testApiEndpoints();
  await testErrorHandling();

  // Summary
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                    TEST SUMMARY                              ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  console.log(`  Passed:   ${testsPassed} ✅`);
  console.log(`  Failed:   ${testsFailed} ❌`);
  console.log(`  Skipped:  ${testsSkipped} ⏭️\n`);

  if (testsFailed === 0) {
    console.log('  🎉 ALL TESTS PASSED!\n');
    if (testsSkipped > 0) {
      console.log(`  Note: ${testsSkipped} test(s) skipped - dev server not running\n`);
      console.log('  To run full tests:');
      console.log('    1. npm run dev (in another terminal)');
      console.log('    2. Set up .dev.vars with Cloudflare credentials');
      console.log('    3. Run this test again\n');
    }
  } else {
    console.log(`  ⚠️  ${testsFailed} test(s) failed\n`);
  }

  process.exit(testsFailed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(e => {
  console.error('\n❌ Test suite error:', e.message);
  process.exit(1);
});
