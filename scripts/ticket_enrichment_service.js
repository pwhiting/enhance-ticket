#!/usr/bin/env node
"use strict";

const path = require("path");
const express = require("express");
const mysql = require("mysql2/promise");
const OpenAI = require("openai");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { searchKb } = require("./lib/retrieval");

function getEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildPrompt({ ticketId, ticketText, kbChunks }) {
  const chunkText = kbChunks
    .map((chunk, index) => {
      const header = `[#${index + 1}] page_id=${chunk.page_id} title=${chunk.page_title}`;
      return `${header}\n${chunk.content}`;
    })
    .join("\n\n");

  const system = [
    "You are an internal support assistant writing a ticket note for technicians.",
    "Use ONLY the provided KB excerpts; do not invent facts, steps, or tools.",
    "If the KB is insufficient, say so and list the missing info needed.",
    "Cite the KB excerpts you used by their [#] markers and page_id.",
  ].join(" ");

  const user = [
    `Ticket ID: ${ticketId || "(not provided)"}`,
    "Ticket Text:",
    ticketText,
    "",
    "Relevant KB Excerpts:",
    chunkText || "(none)",
    "",
    "Task:",
    "Write a concise internal ticket note for the technician.",
    "Include: likely cause, suggested next steps, and any warnings.",
    "If unsure, ask clarifying questions.",
    "Output as JSON with keys: note, citations, confidence, questions.",
  ].join("\n");

  return { system, user };
}

function summarizeChunks(kbChunks) {
  return kbChunks.map((chunk, index) => ({
    rank: index + 1,
    id: chunk.id,
    page_id: chunk.page_id,
    title: chunk.page_title,
    score: Number.isFinite(chunk.score) ? Number(chunk.score.toFixed(6)) : null,
    excerpt: chunk.content.slice(0, 160),
  }));
}

function extractJsonFromText(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  const genericFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (genericFence) return genericFence[1].trim();
  return null;
}

function normalizeModelOutput(content) {
  const directJson = extractJsonFromText(content);
  if (directJson) {
    try {
      return JSON.parse(directJson);
    } catch (error) {
      return null;
    }
  }
  return null;
}

async function main() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const dbConfig = {
    host: getEnv("DB_HOST", "127.0.0.1"),
    user: getEnv("DB_USER", "bs_user"),
    password: getEnv("DB_PASSWORD", ""),
    database: getEnv("DB_NAME", "bookstack"),
  };

  const embeddingModel = getEnv("EMBEDDING_MODEL", "text-embedding-3-small");
  const llmModel = getEnv("LLM_MODEL", "gpt-5.2");
  const topK = Number(getEnv("TOP_K", "6"));
  const candidateLimit = Number(getEnv("CANDIDATE_LIMIT", "2000"));
  const keywordLimit = Number(getEnv("KEYWORD_LIMIT", "200"));
  const termLimit = Number(getEnv("TERM_LIMIT", "20"));
  const audienceDefault = getEnv("DEFAULT_AUDIENCE", "agent");
  const statusDefault = getEnv("DEFAULT_STATUS", "active");
  const openAiTimeoutMs = Number(getEnv("OPENAI_TIMEOUT_MS", "20000"));
  const requestTimeoutMs = Number(getEnv("REQUEST_TIMEOUT_MS", "25000"));
  const debug = getEnv("DEBUG_ENRICH", "0") === "1";
  const bindHost = getEnv("BIND_HOST", "0.0.0.0");

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required.");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post("/api/enrich-ticket", async (req, res) => {
    res.setTimeout(requestTimeoutMs);
    try {
      const { ticket_id, ticket_text, product, audience, status } = req.body || {};
      if (!ticket_text || typeof ticket_text !== "string") {
        return res.status(400).json({ error: "ticket_text is required" });
      }

      if (debug) {
        console.log("enrich: request", {
          ticket_id,
          product,
          audience: audience || audienceDefault,
          status: status || statusDefault,
          text_length: ticket_text.length,
        });
      }

      if (debug) console.log("enrich: embedding start");
      const embeddingResponse = await withTimeout(
        openai.embeddings.create({ model: embeddingModel, input: ticket_text }),
        openAiTimeoutMs,
        "embedding"
      );
      const embedding = embeddingResponse.data[0].embedding;

      if (debug) console.log("enrich: retrieval start");
      const connection = await mysql.createConnection(dbConfig);
      const kbChunks = await searchKb({
        connection,
        queryEmbedding: embedding,
        text: ticket_text,
        audience: audience || audienceDefault,
        status: status || statusDefault,
        product: product || null,
        candidateLimit,
        keywordLimit,
        termLimit,
        disableKeywords: false,
        topK,
      });
      await connection.end();

      const prompt = buildPrompt({ ticketId: ticket_id, ticketText: ticket_text, kbChunks });
      if (debug) {
        console.log("enrich: retrieval results", summarizeChunks(kbChunks));
        console.log("enrich: prompt.system\n" + prompt.system);
        console.log("enrich: prompt.user\n" + prompt.user);
      }
      if (debug) console.log("enrich: completion start");
      const completion = await withTimeout(
        openai.chat.completions.create({
          model: llmModel,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          temperature: 0.2,
        }),
        openAiTimeoutMs,
        "completion"
      );

      const content = completion.choices?.[0]?.message?.content || "";
      let parsed = normalizeModelOutput(content);
      if (!parsed || typeof parsed !== "object") {
        parsed = { note: content, citations: [], confidence: "unknown", questions: [] };
      } else if (typeof parsed.note === "string") {
        const nested = normalizeModelOutput(parsed.note);
        if (nested && typeof nested === "object") parsed = nested;
      }

      return res.json({
        ticket_id,
        model: llmModel,
        kb_chunks: kbChunks,
        output: parsed,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "enrichment_failed" });
    }
  });

  app.get("/ui", (req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ticket Enrichment</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; }
    textarea { width: 100%; height: 140px; }
    input, textarea, select { font-size: 14px; margin: 6px 0; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .row > div { flex: 1 1 240px; }
    pre { white-space: pre-wrap; background: #f4f4f4; padding: 12px; }
    .card { border: 1px solid #ddd; padding: 12px; margin: 12px 0; border-radius: 6px; }
    .label { font-weight: 600; margin-top: 6px; }
    ul { margin: 6px 0 0 18px; }
  </style>
</head>
<body>
  <h2>Ticket Enrichment</h2>
  <form id="enrich-form">
    <div class="row">
      <div>
        <label>Ticket ID</label><br />
        <input type="text" id="ticket_id" />
      </div>
      <div>
        <label>Product (optional)</label><br />
        <input type="text" id="product" />
      </div>
    </div>
    <label>Ticket Text</label><br />
    <textarea id="ticket_text" required></textarea><br />
    <button type="submit">Enrich</button>
  </form>
  <h3>Response</h3>
  <div class="card">
    <div class="label">Note</div>
    <pre id="note">(waiting)</pre>
    <div class="label">Confidence</div>
    <pre id="confidence">—</pre>
    <div class="label">Citations</div>
    <ul id="citations"></ul>
    <div class="label">Questions</div>
    <ul id="questions"></ul>
  </div>
  <details>
    <summary>Raw JSON</summary>
    <pre id="output">(waiting)</pre>
  </details>
  <script>
    const form = document.getElementById('enrich-form');
    const output = document.getElementById('output');
    const noteEl = document.getElementById('note');
    const confidenceEl = document.getElementById('confidence');
    const citationsEl = document.getElementById('citations');
    const questionsEl = document.getElementById('questions');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      output.textContent = 'Loading...';
      noteEl.textContent = 'Loading...';
      confidenceEl.textContent = 'Loading...';
      citationsEl.innerHTML = '';
      questionsEl.innerHTML = '';
      const payload = {
        ticket_id: document.getElementById('ticket_id').value || null,
        ticket_text: document.getElementById('ticket_text').value,
        product: document.getElementById('product').value || null,
      };
      const response = await fetch('/api/enrich-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      const outputPayload = data && data.output ? data.output : {};
      noteEl.textContent = outputPayload.note || '(no note)';
      confidenceEl.textContent = outputPayload.confidence || 'unknown';
      const citations = Array.isArray(outputPayload.citations) ? outputPayload.citations : [];
      citations.forEach((item) => {
        const li = document.createElement('li');
        if (typeof item === 'string') {
          li.textContent = item;
        } else if (item && item.marker) {
          li.textContent = item.marker + ' page_id=' + (item.page_id || 'n/a');
        } else {
          li.textContent = JSON.stringify(item);
        }
        citationsEl.appendChild(li);
      });
      const questions = Array.isArray(outputPayload.questions) ? outputPayload.questions : [];
      questions.forEach((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        questionsEl.appendChild(li);
      });
      output.textContent = JSON.stringify(data, null, 2);
    });
  </script>
</body>
</html>`);
  });

  const port = Number(getEnv("SERVICE_PORT", "3000"));
  app.listen(port, bindHost, () => {
    console.log(`ticket_enrichment_service listening on ${bindHost}:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
