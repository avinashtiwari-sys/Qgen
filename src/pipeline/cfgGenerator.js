const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { validateCFG } = require('../validators/cfgValidator');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/cfg_generation.txt'), 'utf8');

const MAX_RETRIES = 3;

/**
 * Generates one CFG per WSF flow.
 * Returns array of validated CFGs.
 */
async function generateCFGs(wsf) {
  const results = await Promise.all(wsf.flows.map(flow => generateCFGForFlow(flow, wsf)));
  return results;
}

async function generateCFGForFlow(flow, wsf, attempt = 1) {
  const userMessage = buildPromptInput(flow, wsf);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content[0].text.trim();
  let cfg;

  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    cfg = JSON.parse(cleaned);
  } catch (e) {
    if (attempt < MAX_RETRIES) {
      return generateCFGForFlow(flow, wsf, attempt + 1);
    }
    return {
      cfg_id: `cfg_${flow.flow_id}`,
      wsf_flow_ref: flow.flow_id,
      status: 'parse_failed',
      error: e.message,
    };
  }

  const { valid, errors } = validateCFG(cfg);

  if (!valid) {
    if (attempt < MAX_RETRIES) {
      // Feed validation errors back to LLM for correction
      return generateCFGForFlowWithErrors(flow, wsf, cfg, errors, attempt + 1);
    }
    // Return with validation issues flagged — don't silently drop
    cfg.status = 'validation_failed';
    cfg.validation_errors = errors;
    return cfg;
  }

  cfg.status = 'valid';
  return cfg;
}

async function generateCFGForFlowWithErrors(flow, wsf, previousCFG, errors, attempt) {
  const correctionMessage = [
    buildPromptInput(flow, wsf),
    '',
    'PREVIOUS ATTEMPT HAD STRUCTURAL ERRORS. Fix all errors listed below:',
    ...errors.map((e, i) => `${i + 1}. ${e}`),
    '',
    'PREVIOUS CFG (for reference):',
    JSON.stringify(previousCFG, null, 2),
  ].join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: correctionMessage }],
  });

  const raw = response.content[0].text.trim();
  let cfg;

  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    cfg = JSON.parse(cleaned);
  } catch (e) {
    if (attempt < MAX_RETRIES) return generateCFGForFlow(flow, wsf, attempt + 1);
    return { cfg_id: `cfg_${flow.flow_id}`, wsf_flow_ref: flow.flow_id, status: 'parse_failed', error: e.message };
  }

  const { valid, errors: newErrors } = validateCFG(cfg);
  if (!valid) {
    if (attempt < MAX_RETRIES) return generateCFGForFlowWithErrors(flow, wsf, cfg, newErrors, attempt + 1);
    cfg.status = 'validation_failed';
    cfg.validation_errors = newErrors;
    return cfg;
  }

  cfg.status = 'valid';
  return cfg;
}

function buildPromptInput(flow, wsf) {
  return [
    'FEATURE: ' + wsf.feature_name,
    'APP TYPE: ' + (wsf.app_context?.app_type || 'web'),
    '',
    'WSF FLOW:',
    JSON.stringify(flow, null, 2),
    '',
    'BUSINESS RULES (relevant context):',
    JSON.stringify(wsf.business_rules || [], null, 2),
  ].join('\n');
}

module.exports = { generateCFGs };
