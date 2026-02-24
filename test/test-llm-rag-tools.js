/**
 * Test script for LLM, RAG, and tool calling
 * 
 * This script tests the /api/test/llm-rag-tools endpoint to verify:
 * - LLM generation works
 * - RAG search works (if keywords trigger it)
 * - Tool calling works (if keywords trigger it)
 * 
 * Usage:
 *   npm run test:llm-rag-tools
 *   OR
 *   node test/test-llm-rag-tools.js
 */

const http = require('http');

const SERVER_URL = 'http://localhost:8787';
const TEST_ENDPOINT = '/api/test/llm-rag-tools';

/**
 * Send a test request
 */
async function sendTestRequest(message) {
	return new Promise((resolve, reject) => {
		const requestBody = {
			message: message,
		};

		const postData = JSON.stringify(requestBody);

		const options = {
			hostname: 'localhost',
			port: 8787,
			path: TEST_ENDPOINT,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(postData),
			},
		};

		console.log('\n' + '='.repeat(70));
		console.log('Testing LLM/RAG/Tools');
		console.log('='.repeat(70));
		console.log(`Endpoint: ${SERVER_URL}${TEST_ENDPOINT}`);
		console.log(`Message: "${message}"`);
		console.log('\nRequest Body:');
		console.log(JSON.stringify(requestBody, null, 2));
		console.log('\n' + '-'.repeat(70));

		const req = http.request(options, (res) => {
			let responseData = '';

			res.on('data', (chunk) => {
				responseData += chunk;
			});

			res.on('end', () => {
				console.log(`\nResponse Status: ${res.statusCode} ${res.statusMessage}`);
				
				if (responseData) {
					try {
						const parsed = JSON.parse(responseData);
						console.log('\nResponse Body:');
						console.log(JSON.stringify(parsed, null, 2));
						
						if (parsed.success && parsed.result) {
							console.log('\n✅ Test passed!');
							console.log(`Response length: ${parsed.result.length} characters`);
							console.log(`Response preview: ${parsed.result.substring(0, 200)}...`);
						} else {
							console.log('\n❌ Test failed or incomplete');
						}
					} catch {
						console.log('\nResponse Body (raw):');
						console.log(responseData);
					}
				}

				console.log('\n' + '='.repeat(70) + '\n');

				if (res.statusCode >= 200 && res.statusCode < 300) {
					resolve({ status: res.statusCode, data: responseData });
				} else {
					reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
				}
			});
		});

		req.on('error', (error) => {
			console.error('\nRequest Error:', error.message);
			reject(error);
		});

		req.write(postData);
		req.end();
	});
}

/**
 * Main test function
 */
async function main() {
	console.log('\n');
	console.log('╔══════════════════════════════════════════════════════════════╗');
	console.log('║     LLM/RAG/Tools Test                                      ║');
	console.log('╚══════════════════════════════════════════════════════════════╝');
	console.log('\nMake sure the dev server is running: npm run dev\n');

	const testMessages = [
		{
			message: 'Hello, I want to plan a trip to Paris',
			description: 'Basic LLM test (no RAG, no tools)',
		},
		{
			message: 'What are some good restaurants in Paris?',
			description: 'RAG test (should trigger RAG search)',
		},
		{
			message: 'Find flights from New York to Paris',
			description: 'Tool calling test (should trigger Amadeus API)',
		},
	];

	try {
		for (let i = 0; i < testMessages.length; i++) {
			const test = testMessages[i];
			console.log(`\n>>> Test ${i + 1}/${testMessages.length}: ${test.description}`);
			
			await sendTestRequest(test.message);

			// Wait between tests
			if (i < testMessages.length - 1) {
				console.log('Waiting 3 seconds before next test...\n');
				await new Promise(resolve => setTimeout(resolve, 3000));
			}
		}

		console.log('\n✅ All tests completed!');
		console.log('\n📝 Check server logs for:');
		console.log('   - [TravelAgent] handleMessage: Starting');
		console.log('   - [TravelAgent] handleMessage: RAG needed: true/false');
		console.log('   - [TravelAgent] handleMessage: Tools needed: true/false');
		console.log('   - [TravelAgent] handleMessage: Running RAG and tools in parallel...');
		console.log('   - [TravelAgent] handleMessage: Step 4 - Generating LLM response');
		console.log('\n');

	} catch (error) {
		console.error('\n❌ Test failed:', error.message);
		console.error('\nMake sure:');
		console.error('   1. Dev server is running (npm run dev)');
		console.error('   2. Server is accessible at http://localhost:8787');
		console.error('   3. TravelAgent Durable Object is properly configured');
		process.exit(1);
	}
}

// Run tests
main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});

