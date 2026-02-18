/**
 * WebSocket Gateway Test Script with Detailed Step-by-Step Logging
 * 
 * Tests the Gateway WebSocket endpoint and shows exactly what happens at each step:
 * - Connection establishment
 * - Protocol messages
 * - Message sending
 * - Streaming chunks
 * - Complete responses
 * 
 * Usage:
 *   npm run test:ws [userId]
 *   OR
 *   node test/test-websocket.js [userId]
 * 
 * Example:
 *   npm run test:ws test-user-123
 *   OR
 *   node test/test-websocket.js test-user-123
 */

const WebSocket = require('ws');

// Get userId from command line or use default
const userId = process.argv[2] || 'test-user';
const wsUrl = `ws://localhost:8787/api/gateway/ws?userId=${userId}`;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  WebSocket Gateway Test - Detailed Step-by-Step Logging');
console.log('═══════════════════════════════════════════════════════════════\n');
console.log(`Connecting to: ${wsUrl}`);
console.log(`User ID: ${userId}\n`);

// Create WebSocket connection
const ws = new WebSocket(wsUrl);

// Track test results
let responseCount = 0; // Count only actual agent responses
let totalMessageCount = 0; // Count all messages (for debugging)
let chunkCount = 0; // Count streaming chunks
let isStreaming = false; // Track if we're currently receiving a stream
let accumulatedText = ''; // Accumulate streaming text

const testMessages = [
	{ type: 'message', text: 'Hello, I want to plan a trip to Paris' },
	{ type: 'message', text: 'Recommend budget travel strategies' },
	{ type: 'message', text: 'What flights are available from NYC to Paris on December 1st?' },
];

// Step 1: Connection establishment
ws.on('open', () => {
	console.log('STEP 1: WebSocket connection established!\n');
	console.log('Waiting for initial protocol messages...\n');
	
	// Wait a moment for initial protocol messages, then send first test message
	setTimeout(() => {
		console.log('Ready to send messages\n');
		sendNextMessage();
	}, 1000);
});

// Step 2: Receiving messages
ws.on('message', (data) => {
	totalMessageCount++;
	const timestamp = new Date().toISOString();
	
	try {
		const response = JSON.parse(data.toString());
		
		// Filter out internal protocol messages from agents framework
		if (response.type && response.type.startsWith('cf_agent_')) {
			console.log(`STEP 2.${totalMessageCount}: Protocol Message`);
			console.log(`   Type: ${response.type}`);
			
			if (response.type === 'cf_agent_identity') {
				console.log(`   Agent: ${response.agent || 'unknown'}`);
				console.log(`   Name: ${response.name || 'unknown'}`);
			} else if (response.type === 'cf_agent_state') {
				console.log(`   State: ${JSON.stringify(response.state, null, 2).substring(0, 200)}...`);
			} else if (response.type === 'cf_agent_mcp_servers') {
				console.log(`   MCP Servers: ${Object.keys(response.mcp?.servers || {}).length} configured`);
			}
			console.log();
			return;
		}
		
		// Handle agent responses
		if (response.type === 'response') {
			// Check if this is a streaming response
			if (response.streaming) {
				console.log(`STEP 3: Streaming Started`);
				console.log(`   Timestamp: ${timestamp}`);
				console.log(`   User ID: ${response.userId || 'N/A'}`);
				console.log(`   Status: Streaming in progress...\n`);
				isStreaming = true;
				chunkCount = 0;
				accumulatedText = '';
				return;
			}
			
			// Check if this is a chunk
			if (response.chunk) {
				chunkCount++;
				accumulatedText += response.text || '';
				
				console.log(`STEP 4.${chunkCount}: Streaming Chunk #${chunkCount}`);
				console.log(`   Text: "${response.text}"`);
				console.log(`   Accumulated: "${accumulatedText.substring(0, 50)}${accumulatedText.length > 50 ? '...' : ''}"`);
				console.log(`   Length: ${accumulatedText.length} chars\n`);
				return;
			}
			
			// Check if this is the complete response
			if (response.complete) {
				responseCount++;
				isStreaming = false;
				
				console.log(`STEP 5: Complete Response Received`);
				console.log(`   Response #${responseCount}`);
				console.log(`   Total Chunks: ${chunkCount}`);
				console.log(`   Total Length: ${response.text?.length || 0} characters`);
				console.log(`   Timestamp: ${timestamp}`);
				console.log(`   User ID: ${response.userId || 'N/A'}`);
				console.log(`\n   Full Response:`);
				console.log(`   ┌─────────────────────────────────────────────────────────┐`);
				const lines = (response.text || '').split('\n');
				lines.forEach(line => {
					console.log(`   │ ${line.substring(0, 55).padEnd(55)} │`);
				});
				console.log(`   └─────────────────────────────────────────────────────────┘\n`);
				
				// Reset for next message
				chunkCount = 0;
				accumulatedText = '';
				
				// Send next message if available
				if (responseCount < testMessages.length) {
					console.log(`Waiting 2 seconds before next message...\n`);
					setTimeout(() => sendNextMessage(), 2000);
				} else {
					console.log('═══════════════════════════════════════════════════════════════');
					console.log('  Test Complete - Summary');
					console.log('═══════════════════════════════════════════════════════════════');
					console.log(`Total Messages Sent: ${testMessages.length}`);
					console.log(`Total Responses Received: ${responseCount}`);
					console.log(`Total Messages (including protocol): ${totalMessageCount}`);
					console.log(`Streaming: ${isStreaming ? 'Active' : 'Complete'}`);
					console.log('\nClosing connection...\n');
					setTimeout(() => ws.close(), 500);
				}
				return;
			}
			
			// Handle error responses
			if (response.error) {
				responseCount++;
				console.log(`STEP 5: Error Response`);
				console.log(`   Response #${responseCount}`);
				console.log(`   Error: ${response.error}`);
				console.log(`   Timestamp: ${timestamp}\n`);
				
				// Send next message if available
				if (responseCount < testMessages.length) {
					setTimeout(() => sendNextMessage(), 2000);
				} else {
					console.log('Test complete (with errors)');
					setTimeout(() => ws.close(), 500);
				}
				return;
			}
			
			// Fallback: regular response (non-streaming)
			responseCount++;
			console.log(`STEP 4: Response Received (Non-Streaming)`);
			console.log(`   Response #${responseCount}`);
			console.log(`   Text: ${response.text}`);
			console.log(`   Timestamp: ${timestamp}\n`);
			
			// Send next message if available
			if (responseCount < testMessages.length) {
				setTimeout(() => sendNextMessage(), 2000);
			} else {
				console.log('All test messages sent and received!');
				setTimeout(() => ws.close(), 500);
			}
		} else {
			// Unknown message type - log for debugging
			console.log(`STEP X: Unknown Message Type`);
			console.log(`   Type: ${response.type}`);
			console.log(`   Full response:`, JSON.stringify(response, null, 2));
			console.log();
		}
	} catch (error) {
		console.error('❌ Error parsing response:', error);
		console.error('   Raw data:', data.toString().substring(0, 200));
		console.log();
	}
});

ws.on('error', (error) => {
	console.error('═══════════════════════════════════════════════════════════════');
	console.error('  WebSocket Error');
	console.error('═══════════════════════════════════════════════════════════════');
	console.error(`   Error: ${error.message}`);
	console.error(`   Code: ${error.code || 'N/A'}`);
	console.error();
	process.exit(1);
});

ws.on('close', (code, reason) => {
	console.log('═══════════════════════════════════════════════════════════════');
	console.log('  Connection Closed');
	console.log('═══════════════════════════════════════════════════════════════');
	console.log(`   Code: ${code}`);
	console.log(`   Reason: ${reason || 'Normal closure'}`);
	console.log(`   Total Messages: ${totalMessageCount}`);
	console.log(`   Responses: ${responseCount}`);
	console.log();
	process.exit(0);
});

function sendNextMessage() {
	if (responseCount >= testMessages.length) {
		return;
	}
	
	const message = testMessages[responseCount];
	console.log('═══════════════════════════════════════════════════════════════');
	console.log(`  Sending Message #${responseCount + 1}`);
	console.log('═══════════════════════════════════════════════════════════════');
	console.log(`   Type: ${message.type}`);
	console.log(`   Text: "${message.text}"`);
	console.log(`   Timestamp: ${new Date().toISOString()}`);
	console.log();
	
	ws.send(JSON.stringify(message));
}

// Handle graceful shutdown
process.on('SIGINT', () => {
	console.log('\n\nInterrupted by user');
	console.log('Closing connection...\n');
	ws.close();
	process.exit(0);
});

