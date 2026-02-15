/**
 * Tool Calling and HTTP Client Test Script
 * 
 * Tests RPC calls to TravelAgent callable methods via HTTP
 * 
 * Usage:
 *   npm run test:tools [sessionName]
 *   OR
 *   node test/test-tool-calling.js [sessionName]
 * 
 * Example:
 *   npm run test:tools test-session
 *   OR
 *   node test/test-tool-calling.js test-session
 */

const http = require('http');

// Get session name from command line or use default
const sessionName = process.argv[2] || 'test-session';
const baseUrl = 'http://localhost:8787';
const rpcEndpoint = `${baseUrl}/agents/TravelAgent/${sessionName}/rpc`;

console.log('🔧 Testing Tool Calling and HTTP Client');
console.log(`📍 RPC Endpoint: ${rpcEndpoint}`);
console.log(`📦 Session: ${sessionName}\n`);

// Track test results
let testCount = 0;
let passCount = 0;
let failCount = 0;

/**
 * Make an RPC call to the TravelAgent
 */
function makeRPCCall(method, args, description) {
	return new Promise((resolve, reject) => {
		testCount++;
		
		const rpcData = {
			type: 'rpc',
			id: `test-${testCount}-${Date.now()}`,
			method: method,
			args: args,
		};

		const postData = JSON.stringify(rpcData);

		const options = {
			hostname: 'localhost',
			port: 8787,
			path: `/agents/TravelAgent/${sessionName}/rpc`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(postData),
			},
		};

		console.log(`\n📤 Test #${testCount}: ${description}`);
		console.log(`   Method: ${method}`);
		console.log(`   Args: ${JSON.stringify(args, null, 2).split('\n').map(l => '   ' + l).join('\n')}`);

		const req = http.request(options, (res) => {
			let data = '';

			res.on('data', (chunk) => {
				data += chunk;
			});

			res.on('end', () => {
				try {
					const response = JSON.parse(data);
					
					console.log(`   Status: ${res.statusCode}`);
					
					if (response.success) {
						console.log(`   ✅ Success: ${JSON.stringify(response.result, null, 2).split('\n').map(l => '   ' + l).join('\n')}`);
						passCount++;
						resolve(response.result);
					} else {
						console.log(`   ❌ Error: ${response.error || 'Unknown error'}`);
						failCount++;
						reject(new Error(response.error || 'Unknown error'));
					}
				} catch (error) {
					console.log(`   ❌ Parse Error: ${error.message}`);
					console.log(`   Raw Response: ${data}`);
					failCount++;
					reject(error);
				}
			});
		});

		req.on('error', (error) => {
			console.log(`   ❌ Request Error: ${error.message}`);
			failCount++;
			reject(error);
		});

		req.write(postData);
		req.end();
	});
}

/**
 * Run all tests
 */
async function runTests() {
	console.log('🚀 Starting tests...\n');

	try {
		// Test 1: handleMessage - Basic message
		await makeRPCCall(
			'handleMessage',
			['Hello, I want to plan a trip to Paris'],
			'handleMessage - Basic trip planning request'
		);
		
		// Wait a bit for processing
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Test 2: handleMessage - Flight search request
		await makeRPCCall(
			'handleMessage',
			['What flights are available from NYC to Paris on December 1st?'],
			'handleMessage - Flight search request'
		);
		
		// Wait a bit for processing
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Test 3: searchFlights - Direct tool call
		await makeRPCCall(
			'searchFlights',
			[{
				origin: 'NYC',
				destination: 'LAX',
				departureDate: '2025-12-01',
				adults: 1
			}],
			'searchFlights - Direct tool call'
		);

		// Test 4: searchFlights - Round trip
		await makeRPCCall(
			'searchFlights',
			[{
				origin: 'NYC',
				destination: 'LAX',
				departureDate: '2025-12-01',
				returnDate: '2025-12-08',
				adults: 2
			}],
			'searchFlights - Round trip with multiple passengers'
		);

		// Test 5: handleMessage - Budget query
		await makeRPCCall(
			'handleMessage',
			['What is my current budget?'],
			'handleMessage - Budget query'
		);

		// Test 6: Invalid method (should fail)
		try {
			await makeRPCCall(
				'nonExistentMethod',
				[],
				'Invalid method call (should fail)'
			);
		} catch (error) {
			// Expected to fail
			console.log(`   ✅ Correctly rejected invalid method`);
		}

		// Test 7: handleMessage - Complex request
		await makeRPCCall(
			'handleMessage',
			['I want to go to Tokyo from San Francisco on March 15th, 2025 with a budget of $3000'],
			'handleMessage - Complex request with dates and budget'
		);

	} catch (error) {
		console.error(`\n❌ Test suite error: ${error.message}`);
	}

	// Print summary
	console.log('\n' + '='.repeat(60));
	console.log('📊 Test Summary:');
	console.log(`   Total Tests: ${testCount}`);
	console.log(`   ✅ Passed: ${passCount}`);
	console.log(`   ❌ Failed: ${failCount}`);
	console.log(`   Success Rate: ${((passCount / testCount) * 100).toFixed(1)}%`);
	console.log('='.repeat(60) + '\n');
}

// Run tests
runTests().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});

