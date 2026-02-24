/**
 * WebSocket Gateway Test Script
 * 
 * Tests the Gateway WebSocket endpoint for low-latency realtime communication
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

console.log('Testing WebSocket Gateway');
console.log(`Connecting to: ${wsUrl}`);
console.log(`User ID: ${userId}\n`);

// Create WebSocket connection
const ws = new WebSocket(wsUrl);

// Track test results
let responseCount = 0; // Count only actual agent responses
let totalMessageCount = 0; // Count all messages (for debugging)
const testMessages = [
	{ type: 'message', text: 'Hello, I want to plan a trip to Paris' },
	{ type: 'message', text: 'What flights are available from NYC to Paris on December 1st?' },
	{ type: 'message', text: 'What is my budget?' },
];

ws.on('open', () => {
	console.log('WebSocket connection established!\n');
	console.log('Sending test messages...\n');
	
	// Wait a moment for initial protocol messages, then send first test message
	setTimeout(() => sendNextMessage(), 500);
});

ws.on('message', (data) => {
	totalMessageCount++;
	
	try {
		const response = JSON.parse(data.toString());
		
		// Filter out internal protocol messages from agents framework
		// These include: cf_agent_identity, cf_agent_state, cf_agent_mcp_servers, etc.
		if (response.type && response.type.startsWith('cf_agent_')) {
			// Internal protocol message - ignore for test purposes
			console.log(`Protocol message (ignored): ${response.type}`);
			return;
		}
		
		// Only process messages with type: "response" from our agent
		if (response.type === 'response') {
			responseCount++;
			
			console.log(`Agent Response #${responseCount}:`);
			
			if (response.error) {
				console.log('   Error:', response.error);
			} else {
				console.log('   Text:', response.text);
				if (response.userId) {
					console.log('   User ID:', response.userId);
				}
			}
			console.log();
			
			// Send next message if available
			if (responseCount < testMessages.length) {
				setTimeout(() => sendNextMessage(), 1000); // Wait 1 second between messages
			} else {
				console.log('All test messages sent and received!');
				console.log(`Total messages received: ${totalMessageCount} (${responseCount} agent responses)`);
				console.log('Closing connection...');
				setTimeout(() => ws.close(), 500);
			}
		} else {
			// Unknown message type - log for debugging
			console.log(`Unknown message type: ${response.type}`);
			console.log('   Full response:', JSON.stringify(response, null, 2));
		}
	} catch (error) {
		console.error('Error parsing response:', error);
		console.error('   Raw data:', data.toString());
	}
});

ws.on('error', (error) => {
	console.error('WebSocket error:', error.message);
	process.exit(1);
});

ws.on('close', (code, reason) => {
	console.log(`Connection closed (code: ${code}, reason: ${reason || 'none'})`);
	process.exit(0);
});

function sendNextMessage() {
	if (responseCount >= testMessages.length) {
		return;
	}
	
	const message = testMessages[responseCount];
	console.log(`Sending message #${responseCount + 1}:`);
	console.log('   Type:', message.type);
	console.log('   Text:', message.text);
	console.log();
	
	ws.send(JSON.stringify(message));
}

// Handle graceful shutdown
process.on('SIGINT', () => {
	console.log('\nShutting down...');
	ws.close();
	process.exit(0);
});

