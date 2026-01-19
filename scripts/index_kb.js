#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const OpenAI = require("openai");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DEFAULT_CHUNK_TOKENS = 500;
const DEFAULT_OVERLAP_TOKENS = 75;

function getEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function parseArgs(argv) {
  const args = {
    limit: null,
    pageId: null,
    since: null,
    dryRun: false,
    overwrite: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--page-id") args.pageId = Number(argv[++i]);
    else if (arg === "--since") args.since = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--overwrite") args.overwrite = true;
  }
  return args;
}

function tokenize(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function chunkText(text, maxTokens, overlap) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];

  const chunks = [];
  let start = 0;
  while (start < tokens.length) {
    const end = Math.min(start + maxTokens, tokens.length);
    const slice = tokens.slice(start, end).join(" ");
    if (slice.trim()) chunks.push(slice);
    if (end === tokens.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

async function embedBatch(openai, model, inputs) {
  const response = await openai.embeddings.create({ model, input: inputs });
  return response.data.map((item) => item.embedding);
}

async function main() {
  const args = parseArgs(process.argv);
  const dbConfig = {
    host: getEnv("DB_HOST", "127.0.0.1"),
    user: getEnv("DB_USER", "bs_user"),
    password: getEnv("DB_PASSWORD", ""),
    database: getEnv("DB_NAME", "bookstack"),
  };

  const embeddingModel = getEnv("EMBEDDING_MODEL", "text-embedding-3-small");
  const maxTokens = Number(getEnv("CHUNK_TOKENS", DEFAULT_CHUNK_TOKENS));
  const overlapTokens = Number(getEnv("CHUNK_OVERLAP", DEFAULT_OVERLAP_TOKENS));
  const vectorExpr = getEnv("VECTOR_EXPR", "?");
  const batchSize = Number(getEnv("EMBED_BATCH_SIZE", 50));

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required.");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const connection = await mysql.createConnection(dbConfig);

  const where = ["e.type = 'page'", "e.deleted_at IS NULL", "epd.draft = 0", "epd.template = 0"];
  const params = [];
  if (args.pageId) {
    where.push("e.id = ?");
    params.push(args.pageId);
  }
  if (args.since) {
    where.push("e.updated_at >= ?");
    params.push(args.since);
  }
  if (!args.overwrite) {
    where.push("(kc.latest_updated_at IS NULL OR kc.latest_updated_at < e.updated_at)");
  }

  let limitSql = "";
  if (args.limit && Number.isFinite(args.limit)) {
    const limitValue = Math.max(1, Math.floor(args.limit));
    limitSql = ` LIMIT ${limitValue}`;
  }

  const [rows] = await connection.execute(
    `SELECT e.id, e.updated_at, epd.text
     FROM entities e
     JOIN entity_page_data epd ON epd.page_id = e.id
     LEFT JOIN (
       SELECT page_id, MAX(source_updated_at) AS latest_updated_at
       FROM kb_chunk
       GROUP BY page_id
     ) kc ON kc.page_id = e.id
     WHERE ${where.join(" AND ")}
     ORDER BY e.updated_at ASC${limitSql}`,
    params
  );

  for (const row of rows) {
    const pageId = row.id;
    const sourceUpdatedAt = row.updated_at;
    const text = row.text || "";
    const chunks = chunkText(text, maxTokens, overlapTokens);

    if (chunks.length === 0) {
      console.log(`Skipping page ${pageId}: no content.`);
      continue;
    }

    console.log(`Indexing page ${pageId} with ${chunks.length} chunks...`);
    if (args.dryRun) continue;

    await connection.beginTransaction();
    try {
      await connection.execute("DELETE FROM kb_chunk WHERE page_id = ?", [pageId]);

      for (let offset = 0; offset < chunks.length; offset += batchSize) {
        const batch = chunks.slice(offset, offset + batchSize);
        const embeddings = await embedBatch(openai, embeddingModel, batch);

        for (let i = 0; i < batch.length; i += 1) {
          const chunkIndex = offset + i;
          const content = batch[i];
          const embeddingJson = JSON.stringify(embeddings[i]);
          const insertSql = `
            INSERT INTO kb_chunk
              (page_id, chunk_index, chunk_type, content, embedding, embedding_model, source_updated_at)
            VALUES
              (?, ?, ?, ?, ${vectorExpr}, ?, ?)
          `;
          await connection.execute(insertSql, [
            pageId,
            chunkIndex,
            null,
            content,
            embeddingJson,
            embeddingModel,
            sourceUpdatedAt,
          ]);
        }
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  await connection.end();
  console.log("Indexing complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
