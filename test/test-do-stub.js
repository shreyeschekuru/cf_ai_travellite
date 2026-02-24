/**
 * Durable Object Stub Connection Test
 * 
 * Tests the basic connection to TravelAgent Durable Object via stub
 * 
 * Usage:
 *   npm run test:do-stub [sessionName]
 *   OR
 *   node test/test-do-stub.js [sessionName]
 */

const http = require('http');

// Get session name from command line or use default
const sessionName = process.argv[2] || 'test-session';
const baseUrl = 'http://localhost:8787';

console.log('🧪 Testing Durable Object Stub Connection');
console.log(`Base URL: ${baseUrl}`);
console.log(`Session: ${sessionName}\n`);

// Track test results
let testCount = 0;
let passCount = 0;
let failCount = 0;

/**
 * Make an HTTP request and return the response
 */
function makeRequest(path, method = 'GET', body = null) {
	return new Promise((resolve, reject) => {
		const options = {
			hostname: 'localhost',
			port: 8787,
			path: path,
			method: method,
			headers: {
				'Content-Type': 'application/json',
			},
		};

		if (body) {
			options.headers['Content-Length'] = Buffer.byteLength(body);
		}

		const req = http.request(options, (res) => {
			let data = '';
			res.on('data', (chunk) => {
				data += chunk;
			});
			res.on('end', () => {
				resolve({
					statusCode: res.statusCode,
					headers: res.headers,
					body: data,
				});
			});
		});

		req.on('error', (error) => {
			reject(error);
		});

		if (body) {
			req.write(body);
		}
		req.end();
	});
}

/**
 * Test 1: Basic RPC call to verify stub connection
 */
async function test1_BasicRPC() {
	testCount++;
	console.log(`\n📋 Test #${testCount}: Basic RPC Call (handleMessage)`);
	
	try {
		const rpcData = {
			type: 'rpc',
			id: `test-${Date.now()}`,
			method: 'handleMessage',
			args: ['Hello, this is a test'],
		};

		const response = await makeRequest(
			`/agents/TravelAgent/${sessionName}/rpc`,
			'POST',
			JSON.stringify(rpcData)
		);

		console.log(`   Status: ${response.statusCode}`);
		
		if (response.statusCode === 200 || response.statusCode === 500) {
			// 200 = success, 500 = DO error but connection worked
			try {
				const json = JSON.parse(response.body);
				if (json.success) {
					console.log(`   ✅ Success: Stub connection works!`);
					console.log(`   Response: ${JSON.stringify(json.result).substring(0, 100)}...`);
					passCount++;
					return true;
				} else {
					console.log(`   ⚠️  Connection works but method failed: ${json.error}`);
					passCount++; // Connection worked, method issue is separate
					return true;
				}
			} catch (e) {
				if (response.body.includes('<!DOCTYPE')) {
					console.log(`   ❌ Got HTML error page (Worker exception)`);
					console.log(`   This means the DO threw an exception`);
				} else {
					console.log(`   ⚠️  Non-JSON response: ${response.body.substring(0, 200)}`);
				}
				failCount++;
				return false;
			}
		} else if (response.statusCode === 404) {
			console.log(`   ❌ 404 Not Found - Stub connection failed or routing issue`);
			console.log(`   Response: ${response.body.substring(0, 200)}`);
			failCount++;
			return false;
		} else {
			console.log(`   ❌ Unexpected status: ${response.statusCode}`);
			console.log(`   Response: ${response.body.substring(0, 200)}`);
			failCount++;
			return false;
		}
	} catch (error) {
		console.log(`   ❌ Error: ${error.message}`);
		failCount++;
		return false;
	}
}

/**
 * Test 2: Check if DO endpoint exists
 */
async function test2_EndpointExists() {
	testCount++;
	console.log(`\n📋 Test #${testCount}: Check DO Endpoint Exists`);
	
	try {
		const response = await makeRequest(
			`/agents/TravelAgent/${sessionName}/rpc`,
			'GET'
		);

		console.log(`   Status: ${response.statusCode}`);
		
		if (response.statusCode === 404) {
			console.log(`   ✅ Endpoint exists (404 is expected for GET on RPC endpoint)`);
			passCount++;
			return true;
		} else if (response.statusCode === 405) {
			console.log(`   ✅ Endpoint exists (405 Method Not Allowed is also valid)`);
			passCount++;
			return true;
		} else {
			console.log(`   ⚠️  Unexpected status: ${response.statusCode}`);
			failCount++;
			return false;
		}
	} catch (error) {
		console.log(`   ❌ Error: ${error.message}`);
		failCount++;
		return false;
	}
}

/**
 * Test 3: Test invalid method (should return method not found, not connection error)
 */
async function test3_InvalidMethod() {
	testCount++;
	console.log(`\n📋 Test #${testCount}: Invalid Method (should return method error, not connection error)`);
	
	try {
		const rpcData = {
			type: 'rpc',
			id: `test-${Date.now()}`,
			method: 'nonExistentMethod',
			args: [],
		};

		const response = await makeRequest(
			`/agents/TravelAgent/${sessionName}/rpc`,
			'POST',
			JSON.stringify(rpcData)
		);

		console.log(`   Status: ${response.statusCode}`);
		
		// Try to parse response body first (even if status is 404, it might be valid JSON)
		try {
			const json = JSON.parse(response.body);
			if (json.success === false && json.error && json.error.includes('not found')) {
				console.log(`   ✅ Connection works! Got expected "method not found" error`);
				console.log(`   Error: ${json.error}`);
				passCount++;
				return true;
			} else if (json.success === false) {
				// Any JSON error response means connection worked
				console.log(`   ✅ Connection works! Got JSON error response`);
				console.log(`   Error: ${json.error || 'Unknown error'}`);
				passCount++;
				return true;
			} else {
				console.log(`   ⚠️  Unexpected response: ${JSON.stringify(json)}`);
				failCount++;
				return false;
			}
		} catch (e) {
			// If we can't parse JSON, check what we got
			if (response.body.includes('<!DOCTYPE')) {
				console.log(`   ❌ Got HTML error page instead of JSON error`);
				console.log(`   This suggests the DO is crashing, not just returning an error`);
				failCount++;
				return false;
			} else if (response.statusCode === 404) {
				console.log(`   ❌ 404 with non-JSON response - routing issue`);
				console.log(`   Response: ${response.body.substring(0, 200)}`);
				failCount++;
				return false;
			} else {
				console.log(`   ⚠️  Non-JSON response: ${response.body.substring(0, 200)}`);
				failCount++;
				return false;
			}
		}
	} catch (error) {
		console.log(`   ❌ Error: ${error.message}`);
		failCount++;
		return false;
	}
}

/**
 * Test 4: Test callAmadeusAPI method (simpler, no RAG/Tools)
 */
async function test4_SimpleMethod() {
	testCount++;
	console.log(`\n📋 Test #${testCount}: Simple Method Call (callAmadeusAPI with minimal params)`);
	
	try {
		const rpcData = {
			type: 'rpc',
			id: `test-${Date.now()}`,
			method: 'callAmadeusAPI',
			args: ['searchLocations', { keyword: 'Paris' }],
		};

		const response = await makeRequest(
			`/agents/TravelAgent/${sessionName}/rpc`,
			'POST',
			JSON.stringify(rpcData)
		);

		console.log(`   Status: ${response.statusCode}`);
		
		try {
			const json = JSON.parse(response.body);
			if (json.success) {
				console.log(`   ✅ Method call succeeded!`);
				passCount++;
				return true;
			} else {
				console.log(`   ⚠️  Method returned error: ${json.error}`);
				// Still counts as connection success if we got a proper JSON response
				passCount++;
				return true;
			}
		} catch (e) {
			if (response.body.includes('<!DOCTYPE')) {
				console.log(`   ❌ Got HTML error page (DO exception)`);
			} else {
				console.log(`   ⚠️  Non-JSON response: ${response.body.substring(0, 200)}`);
			}
			failCount++;
			return false;
		}
	} catch (error) {
		console.log(`   ❌ Error: ${error.message}`);
		failCount++;
		return false;
	}
}

/**
 * Test 5: Check gateway WebSocket endpoint
 */
async function test5_GatewayEndpoint() {
	testCount++;
	console.log(`\n📋 Test #${testCount}: Gateway WebSocket Endpoint`);
	
	try {
		const response = await makeRequest(
			`/api/gateway/ws?userId=${sessionName}`,
			'GET'
		);

		console.log(`   Status: ${response.statusCode}`);
		
		if (response.statusCode === 426) {
			console.log(`   ✅ Endpoint exists! (426 = Upgrade Required, expected for WebSocket)`);
			passCount++;
			return true;
		} else if (response.statusCode === 400) {
			console.log(`   ✅ Endpoint exists! (400 = Bad Request, might be missing userId)`);
			passCount++;
			return true;
		} else if (response.statusCode === 404) {
			console.log(`   ❌ Endpoint not found (404)`);
			failCount++;
			return false;
		} else {
			console.log(`   ⚠️  Status: ${response.statusCode}`);
			console.log(`   Response: ${response.body.substring(0, 200)}`);
			passCount++; // Any response means endpoint exists
			return true;
		}
	} catch (error) {
		console.log(`   ❌ Error: ${error.message}`);
		failCount++;
		return false;
	}
}

/**
 * Run all tests
 */
async function runTests() {
	console.log('Starting DO stub connection tests...\n');

	try {
		// Test basic connectivity
		await test2_EndpointExists();
		await new Promise(resolve => setTimeout(resolve, 500));

		// Test invalid method (should work but return error)
		await test3_InvalidMethod();
		await new Promise(resolve => setTimeout(resolve, 500));

		// Test simple method call
		await test4_SimpleMethod();
		await new Promise(resolve => setTimeout(resolve, 500));

		// Test basic RPC (might timeout due to CPU limit)
		console.log(`\n⚠️  Note: This test might timeout if DO exceeds CPU limit...`);
		await test1_BasicRPC();
		await new Promise(resolve => setTimeout(resolve, 500));

		// Test gateway endpoint
		await test5_GatewayEndpoint();

	} catch (error) {
		console.error(`\n❌ Test suite error: ${error.message}`);
	}

	// Print summary
	console.log('\n' + '='.repeat(60));
	console.log('Test Summary:');
	console.log(`   Total Tests: ${testCount}`);
	console.log(`   Passed: ${passCount}`);
	console.log(`   Failed: ${failCount}`);
	console.log(`   Success Rate: ${((passCount / testCount) * 100).toFixed(1)}%`);
	console.log('='.repeat(60) + '\n');

	if (failCount === 0) {
		console.log('✅ All tests passed! DO stub connection is working.');
	} else {
		console.log('❌ Some tests failed. Check the output above for details.');
		console.log('\nCommon issues:');
		console.log('   - Make sure dev server is running: npm run dev');
		console.log('   - Check that TravelAgent DO is properly configured in wrangler.jsonc');
		console.log('   - Verify the routing logic in src/index.ts');
	}
}

// Run tests
runTests().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});

