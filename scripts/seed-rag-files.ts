/// <reference path="../worker-configuration.d.ts" />

/**
 * Script to seed base RAG files into Vectorize
 * 
 * This script reads all RAG files from RAG_files/ directory,
 * generates embeddings, and upserts them into the Vectorize index.
 * 
 * Usage:
 *   npx wrangler dev --script scripts/seed-rag-files.ts
 *   OR
 *   npx tsx scripts/seed-rag-files.ts (if using tsx)
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";

interface Env {
	AI: any;
	VECTORIZE: VectorizeIndex;
	KVNAMESPACE: KVNamespace;
}

/**
 * Generate embedding for text using Workers AI
 */
async function generateEmbedding(env: Env, text: string): Promise<number[]> {
	try {
		const response = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
			text: [text],
		});

		// Extract embedding from response
		if (response && typeof response === "object" && "data" in response) {
			const data = response.data as any;
			if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
				return data[0];
			}
			if (Array.isArray(data)) {
				return data;
			}
		}

		throw new Error("Unexpected embedding response format");
	} catch (error) {
		console.error("Embedding generation error:", error);
		throw error;
	}
}

/**
 * Process a single RAG file
 */
async function processRAGFile(
	env: Env,
	fileName: string,
	content: string,
): Promise<void> {
	try {
		// Check if already ingested
		const kvKey = `rag:file:${fileName}`;
		const existing = await env.KVNAMESPACE.get(kvKey);
		
		if (existing) {
			console.log(`⏭️  Skipping ${fileName} (already ingested)`);
			return;
		}

		// Generate embedding
		console.log(`📝 Processing ${fileName}...`);
		const embedding = await generateEmbedding(env, content);

		// Extract topic from filename (remove .txt extension)
		const topic = fileName.replace(".txt", "").replace(/_/g, " ");

		// Prepare metadata
		const metadata = {
			source: "base-rag-file",
			type: "travel-knowledge",
			topic: topic,
			fileName: fileName,
			createdAt: Date.now(),
		};

		// Create ID from filename
		const id = `rag-${fileName.replace(".txt", "").replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;

		// Upsert to Vectorize
		await env.VECTORIZE.upsert([
			{
				id: id,
				values: embedding,
				metadata: metadata,
			},
		]);

		// Mark as ingested in KV
		await env.KVNAMESPACE.put(kvKey, JSON.stringify({
			ingestedAt: Date.now(),
			fileName: fileName,
		}));

		console.log(`✅ Ingested ${fileName} (ID: ${id})`);
	} catch (error) {
		console.error(`❌ Error processing ${fileName}:`, error);
		throw error;
	}
}

/**
 * Main function to seed all RAG files
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			const url = new URL(request.url);
			
			// Only allow POST requests
			if (request.method !== "POST") {
				return new Response("Method not allowed. Use POST to seed RAG files.", { status: 405 });
			}

			// Read all files from RAG_files directory
			const ragDir = join(process.cwd(), "RAG_files");
			const files = await readdir(ragDir);
			const txtFiles = files.filter(f => f.endsWith(".txt"));

			console.log(`\n🚀 Starting RAG file ingestion...`);
			console.log(`📁 Found ${txtFiles.length} RAG files\n`);

			let successCount = 0;
			let skipCount = 0;
			let errorCount = 0;

			// Process each file
			for (const fileName of txtFiles) {
				try {
					const filePath = join(ragDir, fileName);
					const content = await readFile(filePath, "utf-8");

					// Check if already ingested
					const kvKey = `rag:file:${fileName}`;
					const existing = await env.KVNAMESPACE.get(kvKey);
					
					if (existing) {
						skipCount++;
						continue;
					}

					await processRAGFile(env, fileName, content);
					successCount++;
					
					// Small delay to avoid rate limiting
					await new Promise(resolve => setTimeout(resolve, 500));
				} catch (error) {
					console.error(`Error processing ${fileName}:`, error);
					errorCount++;
				}
			}

			const summary = {
				total: txtFiles.length,
				success: successCount,
				skipped: skipCount,
				errors: errorCount,
			};

			console.log(`\n✨ Ingestion complete!`);
			console.log(`   ✅ Success: ${successCount}`);
			console.log(`   ⏭️  Skipped: ${skipCount}`);
			console.log(`   ❌ Errors: ${errorCount}\n`);

			return Response.json({
				success: true,
				summary: summary,
			});
		} catch (error) {
			console.error("Fatal error:", error);
			return Response.json(
				{
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				},
				{ status: 500 }
			);
		}
	},
};

