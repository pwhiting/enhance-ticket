#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const OpenAI = require("openai");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { searchKb } = require("./lib/retrieval");

function getEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function parseArgs(argv) {
  const args = {
    text: null,
    file: null,
    limit: 5,
    product: null,
    audience: "agent",
    status: "active",
    candidateLimit: 2000,
    keywordLimit: 200,
    termLimit: 20,
    disableKeywords: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--text") args.text = argv[++i];
    else if (arg === "--file") args.file = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--product") args.product = argv[++i];
    else if (arg === "--audience") args.audience = argv[++i];
    else if (arg === "--status") args.status = argv[++i];
    else if (arg === "--candidate-limit") args.candidateLimit = Number(argv[++i]);
    else if (arg === "--keyword-limit") args.keywordLimit = Number(argv[++i]);
    else if (arg === "--term-limit") args.termLimit = Number(argv[++i]);
    else if (arg === "--disable-keywords") args.disableKeywords = true;
  }
  return args;
}

function readInput(args) {
  if (args.text) return args.text;
  if (args.file) return fs.readFileSync(args.file, "utf8");
  return fs.readFileSync(0, "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const text = readInput(args);

  if (!text || !text.trim()) {
    console.error("Ticket text is required via --text, --file, or stdin.");
    process.exit(1);
  }

  const dbConfig = {
    host: getEnv("DB_HOST", "127.0.0.1"),
    user: getEnv("DB_USER", "bs_user"),
    password: getEnv("DB_PASSWORD", ""),
    database: getEnv("DB_NAME", "bookstack"),
  };

  const embeddingModel = getEnv("EMBEDDING_MODEL", "text-embedding-3-small");
  const vectorExpr = getEnv("VECTOR_EXPR", "?");

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required.");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const embeddingResponse = await openai.embeddings.create({
    model: embeddingModel,
    input: text,
  });
  const embedding = embeddingResponse.data[0].embedding;

  const connection = await mysql.createConnection(dbConfig);
  const top = await searchKb({
    connection,
    queryEmbedding: embedding,
    text,
    audience: args.audience,
    status: args.status,
    product: args.product,
    candidateLimit: args.candidateLimit,
    keywordLimit: args.keywordLimit,
    termLimit: args.termLimit,
    disableKeywords: args.disableKeywords,
    topK: args.limit,
  });
  await connection.end();

  for (const item of top) {
    console.log(`score=${item.score.toFixed(6)} page_id=${item.page_id} title=${item.page_title}`);
    console.log(item.content.slice(0, 300));
    console.log("---");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
