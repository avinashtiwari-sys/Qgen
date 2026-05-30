const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INPUT_TYPES = ['user_story', 'gherkin', 'figma_url', 'screenshot_base64', 'spec', 'mixed'];

/**
 * Detects input type from raw user input.
 * Returns { type, confidence, hint }
 */
async function classifyInput(rawInput) {
  // Fast rule-based checks first (no LLM cost)
  if (typeof rawInput === 'object' && rawInput.figma_url) {
    return { type: 'figma_url', confidence: 'high', hint: null };
  }

  if (typeof rawInput === 'object' && rawInput.screenshot_base64) {
    return { type: 'screenshot_base64', confidence: 'high', hint: null };
  }

  const text = typeof rawInput === 'string' ? rawInput : rawInput.text || '';

  if (/^\s*(Feature:|Scenario:|Given |When |Then |And |Background:)/m.test(text)) {
    return { type: 'gherkin', confidence: 'high', hint: null };
  }

  if (/https:\/\/www\.figma\.com\/(file|proto|design)\//.test(text)) {
    return { type: 'figma_url', confidence: 'high', hint: null };
  }

  // LLM classification for ambiguous text inputs
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system: `Classify the following text as one of: user_story, gherkin, spec, mixed.
Return JSON only: { "type": "<type>", "confidence": "high|medium|low", "hint": "<one line reason>" }`,
    messages: [{ role: 'user', content: text.slice(0, 2000) }],
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { type: 'user_story', confidence: 'low', hint: 'Defaulted — classification failed' };
  }
}

module.exports = { classifyInput, INPUT_TYPES };
