/**
 * Test script for Realtime webhook streaming
 * 
 * This script simulates a Realtime webhook event by sending HTTP POST requests
 * to the /api/realtime/webhook endpoint.
 * 
 * Usage:
 *   npm run test:realtime
 *   OR
 *   node test/test-realtime-webhook.js
 */

const http = require('http');

const SERVER_URL = 'http://localhost:8787';
const WEBHOOK_ENDPOINT = '/api/realtime/webhook';

/**
 * Send a test webhook request
 */
async function sendWebhookRequest(messageText, userId = 'test-user', roomId = 'test-room') {
	return new Promise((resolve, reject) => {
		const webhookEvent = {
			type: 'message',
			room: roomId,
			userId: userId,
			message: {
				text: messageText,
			},
			timestamp: Date.now(),
		};

		const postData = JSON.stringify(webhookEvent);

		const options = {
			hostname: 'localhost',
			port: 8787,
			path: WEBHOOK_ENDPOINT,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(postData),
			},
		};

		console.log('\n' + '='.repeat(70));
		console.log('Sending Realtime Webhook Request');
		console.log('='.repeat(70));
		console.log(`Endpoint: ${SERVER_URL}${WEBHOOK_ENDPOINT}`);
		console.log(`User ID: ${userId}`);
		console.log(`Room ID: ${roomId}`);
		console.log(`Message: "${messageText}"`);
		console.log('\nRequest Body:');
		console.log(JSON.stringify(webhookEvent, null, 2));
		console.log('\n' + '-'.repeat(70));

		const req = http.request(options, (res) => {
			let responseData = '';

			res.on('data', (chunk) => {
				responseData += chunk;
			});

			res.on('end', () => {
				console.log(`\nResponse Status: ${res.statusCode} ${res.statusMessage}`);
				console.log('Response Headers:', JSON.stringify(res.headers, null, 2));
				
				if (responseData) {
					try {
						const parsed = JSON.parse(responseData);
						console.log('\nResponse Body:');
						console.log(JSON.stringify(parsed, null, 2));
					} catch {
						console.log('\nResponse Body (raw):');
						console.log(responseData);
					}
				}

				console.log('\n' + '='.repeat(70));
				console.log('NOTE: Streaming happens in the background via RealtimeConnector');
				console.log('Check server logs to see streaming progress');
				console.log('='.repeat(70) + '\n');

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
	console.log('║     Realtime Webhook Streaming Test                         ║');
	console.log('╚══════════════════════════════════════════════════════════════╝');
	console.log('\nMake sure the dev server is running: npm run dev\n');

	const testMessages = [
		'Hello, I want to plan a trip to Paris',
		'What are some good restaurants there?',
		'Find flights from New York to Paris',
	];

	try {
		for (let i = 0; i < testMessages.length; i++) {
			const message = testMessages[i];
			const userId = `test-user-${Date.now()}`;
			const roomId = `test-room-${Date.now()}`;

			console.log(`\n>>> Test ${i + 1}/${testMessages.length}`);
			
			await sendWebhookRequest(message, userId, roomId);

			// Wait a bit between requests
			if (i < testMessages.length - 1) {
				console.log('\nWaiting 2 seconds before next request...\n');
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}

		console.log('\n✅ All webhook requests sent successfully!');
		console.log('\n📝 Next Steps:');
		console.log('   1. Check server logs for streaming progress');
		console.log('   2. Verify RealtimeConnector is publishing chunks');
		console.log('   3. If Realtime is configured, check Realtime dashboard for messages');
		console.log('\n');

	} catch (error) {
		console.error('\n❌ Test failed:', error.message);
		console.error('\nMake sure:');
		console.error('   1. Dev server is running (npm run dev)');
		console.error('   2. Server is accessible at http://localhost:8787');
		console.error('   3. RealtimeConnector is properly configured');
		process.exit(1);
	}
}

// Run tests
main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});

