/**
 * Script to automatically set Wrangler secrets from .dev.vars file
 * 
 * This script automatically:
 * 1. Reads credentials from .dev.vars file
 * 2. Runs `npx wrangler secret put` for each required secret
 * 3. Automatically pastes the credential values non-interactively
 * 
 * This ensures secrets are set for remote mode without manual input.
 * 
 * Usage:
 *   node scripts/set-secrets.js
 *   OR
 *   npm run set-secrets
 *   OR (automatically runs before remote dev server):
 *   npm run dev
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEV_VARS_PATH = path.join(__dirname, '../.dev.vars');

/**
 * Read and parse .dev.vars file
 */
function readDevVars() {
	if (!fs.existsSync(DEV_VARS_PATH)) {
		console.error('❌ Error: .dev.vars file not found');
		console.error(`   Expected at: ${DEV_VARS_PATH}`);
		process.exit(1);
	}

	const content = fs.readFileSync(DEV_VARS_PATH, 'utf-8');
	const vars = {};
	
	content.split('\n').forEach((line, index) => {
		line = line.trim();
		// Skip comments and empty lines
		if (line && !line.startsWith('#')) {
			const equalIndex = line.indexOf('=');
			if (equalIndex > 0) {
				const key = line.substring(0, equalIndex).trim();
				const value = line.substring(equalIndex + 1).trim();
				// Remove quotes if present
				const cleanValue = value.replace(/^["']|["']$/g, '');
				if (key && cleanValue) {
					vars[key] = cleanValue;
				}
			}
		}
	});
	
	return vars;
}

/**
 * Set a secret using wrangler secret put
 * Automatically reads from .dev.vars and passes the value non-interactively
 * Returns a Promise that resolves to true if successful, false otherwise
 */
function setSecret(key, value) {
	return new Promise((resolve) => {
		console.log(`🔐 Setting ${key}...`);
		
		// Validate that we have a value
		if (!value || value.trim().length === 0) {
			console.error(`   ❌ ${key} value is empty in .dev.vars`);
			resolve(false);
			return;
		}
		
		// Use npx to run wrangler from node_modules
		const wrangler = spawn('npx', ['wrangler', 'secret', 'put', key], {
			stdio: ['pipe', 'inherit', 'inherit'],
			shell: false
		});
		
		let stdinWritten = false;
		
		// Wait for the process to start and prompt to appear
		// Wrangler uses a prompt library that reads from stdin
		setTimeout(() => {
			if (!stdinWritten && wrangler.stdin && !wrangler.stdin.destroyed) {
				try {
					// Write the secret value followed by newline (simulates pressing Enter)
					// This automatically fills in the prompt and submits it
					wrangler.stdin.write(value + '\n');
					wrangler.stdin.end();
					stdinWritten = true;
				} catch (error) {
					console.error(`   ❌ Error writing to stdin: ${error.message}`);
					if (!wrangler.killed) {
						wrangler.kill();
					}
					resolve(false);
				}
			}
		}, 200); // Small delay to ensure prompt is ready
		
		wrangler.on('close', (code) => {
			if (code === 0) {
				console.log(`   ✅ ${key} set successfully`);
				resolve(true);
			} else {
				console.error(`   ❌ Failed to set ${key} (exit code: ${code})`);
				resolve(false);
			}
		});
		
		wrangler.on('error', (error) => {
			console.error(`   ❌ Failed to spawn wrangler: ${error.message}`);
			resolve(false);
		});
		
		// Handle case where stdin is closed before we write
		wrangler.stdin.on('error', (error) => {
			if (!stdinWritten) {
				console.error(`   ❌ Stdin error: ${error.message}`);
				resolve(false);
			}
		});
	});
}

/**
 * Main function
 */
async function main() {
	console.log('\n🚀 Setting Wrangler secrets from .dev.vars...\n');
	
	const vars = readDevVars();
	
	// Required secrets (must be present)
	const requiredSecrets = ['AMADEUS_API_KEY', 'AMADEUS_API_SECRET'];
	
	// Optional secrets (will be set if present, but won't fail if missing)
	const optionalSecrets = ['REALTIME_APP_ID', 'CLOUDFLARE_API_TOKEN', 'REALTIME_API_TOKEN', 'REALTIME_NAMESPACE_ID', 'REALTIME_ACCOUNT_ID'];
	
	let successCount = 0;
	let failCount = 0;
	
	// Set required secrets (fail if missing)
	for (const secretKey of requiredSecrets) {
		if (vars[secretKey]) {
			const success = await setSecret(secretKey, vars[secretKey]);
			if (success) {
				successCount++;
			} else {
				failCount++;
			}
		} else {
			console.log(`   ⚠️  ${secretKey} not found in .dev.vars`);
			failCount++;
		}
	}
	
	// Set optional secrets (skip if missing)
	for (const secretKey of optionalSecrets) {
		if (vars[secretKey]) {
			const success = await setSecret(secretKey, vars[secretKey]);
			if (success) {
				successCount++;
			} else {
				console.log(`   ⚠️  Failed to set optional secret ${secretKey}, continuing...`);
				// Don't increment failCount for optional secrets
			}
		} else {
			console.log(`   ℹ️  ${secretKey} not found in .dev.vars (optional, skipping)`);
		}
	}
	
	console.log(`\n✨ Secrets setup complete!`);
	console.log(`   ✅ Success: ${successCount}`);
	console.log(`   ❌ Failed: ${failCount}\n`);
	
	if (failCount > 0) {
		console.log('   💡 If secrets fail with "latest version isn\'t deployed", run: npm run deploy');
		process.exit(1);
	}
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});

