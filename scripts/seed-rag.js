/**
 * Script to seed base RAG files into Vectorize
 * 
 * This script reads all RAG files from RAG_files/ directory,
 * generates embeddings, and upserts them into the Vectorize index.
 * 
 * Usage:
 *   node scripts/seed-rag.js
 * 
 * Prerequisites:
 *   - Worker must be running (npm run dev)
 *   - RAG_files/ directory must exist with .txt files
 */

const http = require('http');
const fs = require('fs').promises;
const path = require('path');

const WORKER_URL = 'http://localhost:8787';
const RAG_DIR = path.join(__dirname, '../RAG_files');

/**
 * Make a request to the Worker to process a RAG file
 */
async function processRAGFile(fileName, content) {
	return new Promise((resolve, reject) => {
		const postData = JSON.stringify({
			fileName: fileName,
			content: content,
		});

		const options = {
			hostname: 'localhost',
			port: 8787,
			path: '/api/seed-rag',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(postData),
			},
		};

		const req = http.request(options, (res) => {
			let data = '';

			res.on('data', (chunk) => {
				data += chunk;
			});

			res.on('end', () => {
				try {
					const response = JSON.parse(data);
					if (response.success) {
						resolve(response);
					} else {
						reject(new Error(response.error || 'Unknown error'));
					}
				} catch (error) {
					reject(error);
				}
			});
		});

		req.on('error', (error) => {
			reject(error);
		});

		req.write(postData);
		req.end();
	});
}

/**
 * Main function
 */
async function main() {
	try {
		console.log('\n🚀 Starting RAG file ingestion...\n');

		// Read all .txt files from RAG_files directory
		const files = await fs.readdir(RAG_DIR);
		const txtFiles = files.filter(f => f.endsWith('.txt'));

		if (txtFiles.length === 0) {
			console.log('❌ No .txt files found in RAG_files/ directory');
			process.exit(1);
		}

		console.log(`📁 Found ${txtFiles.length} RAG files\n`);

		let successCount = 0;
		let skipCount = 0;
		let errorCount = 0;

		// Process each file
		for (const fileName of txtFiles) {
			try {
				const filePath = path.join(RAG_DIR, fileName);
				const content = await fs.readFile(filePath, 'utf-8');

				console.log(`📝 Processing ${fileName}...`);

				const result = await processRAGFile(fileName, content);

				if (result.skipped) {
					console.log(`   ⏭️  Skipped (already ingested)`);
					skipCount++;
				} else {
					console.log(`   ✅ Ingested (ID: ${result.id})`);
					successCount++;
				}

				// Small delay to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 500));
			} catch (error) {
				console.log(`   ❌ Error: ${error.message}`);
				errorCount++;
			}
		}

		console.log(`\n✨ Ingestion complete!`);
		console.log(`   ✅ Success: ${successCount}`);
		console.log(`   ⏭️  Skipped: ${skipCount}`);
		console.log(`   ❌ Errors: ${errorCount}\n`);
	} catch (error) {
		console.error('Fatal error:', error);
		process.exit(1);
	}
}

main();


