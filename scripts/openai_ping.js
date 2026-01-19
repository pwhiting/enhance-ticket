#!/usr/bin/env node
"use strict";

const path = require("path");
const OpenAI = require("openai");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required.");
    process.exit(1);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: process.env.LLM_MODEL || "gpt-5.2",
    messages: [{ role: "user", content: "are you there" }],
    temperature: 0,
  });

  const content = response.choices?.[0]?.message?.content || "";
  if (!content.trim()) {
    console.error("No content returned from OpenAI.");
    process.exit(1);
  }

  console.log(content.trim());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
