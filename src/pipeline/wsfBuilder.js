const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/wsf_extraction.txt'), 'utf8');

/**
 * Builds a WSF JSON from classified input.
 * Handles: user_story, gherkin, spec, mixed (text-based)
 * Screenshot and Figma are pre-processed upstream into text before reaching here.
 */
async function buildWSF(rawInput, inputType, context = {}) {
  const text = normalizeToText(rawInput, inputType);

  const userMessage = buildUserMessage(text, inputType, context);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content[0].text.trim();
  const wsf = parseJSON(raw, 'WSF');

  // Inject source metadata
  wsf.source = wsf.source || [inputType];
  wsf.feature_id = wsf.feature_id || `FEAT-${Date.now()}`;

  validateWSFMinimum(wsf);

  return wsf;
}

function normalizeToText(rawInput, inputType) {
  if (typeof rawInput === 'string') return rawInput;
  if (rawInput.text) return rawInput.text;
  if (rawInput.extracted_text) return rawInput.extracted_text; // from screenshot/figma pre-processor
  return JSON.stringify(rawInput);
}

function buildUserMessage(text, inputType, context) {
  const lines = [`INPUT TYPE: ${inputType}`, ''];

  if (context.app_type)      lines.push(`APP TYPE: ${context.app_type}`);
  if (context.platform_hint) lines.push(`PLATFORM: ${context.platform_hint}`);
  if (context.feature_id)    lines.push(`FEATURE ID: ${context.feature_id}`);

  lines.push('', 'INPUT:', text);
  return lines.join('\n');
}

function parseJSON(raw, label) {
  // Strip markdown fences if LLM wrapped output anyway
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const err = new Error(`${label} parse failed: ${e.message}`);
    err.raw = cleaned;
    throw err;
  }
}

function validateWSFMinimum(wsf) {
  if (!wsf.flows || wsf.flows.length === 0) {
    throw new Error('WSF must contain at least one flow');
  }
  for (const flow of wsf.flows) {
    if (!flow.steps || flow.steps.length === 0) {
      throw new Error(`Flow ${flow.flow_id} has no steps`);
    }
  }
}

module.exports = { buildWSF };
