const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/screenshot_context_extraction.txt'), 'utf8'
);

/**
 * Extracts an AppProfile from one or more screenshots.
 *
 * @param {string|string[]} screenshots  - single base64 string or array of base64 strings
 *                                         Each can be raw base64 or a data URI
 *                                         (data:image/png;base64,...)
 * @returns {AppProfile} merged app profile from all screenshots
 */
async function extractAppContext(screenshots) {
  const images = Array.isArray(screenshots) ? screenshots : [screenshots];

  if (images.length === 0) {
    throw new Error('At least one screenshot is required');
  }

  // Process all screenshots in parallel
  const screenProfiles = await Promise.all(
    images.map((img, idx) => extractFromOneScreenshot(img, idx + 1))
  );

  // Merge multiple screen profiles into one AppProfile
  return mergeScreenProfiles(screenProfiles);
}

async function extractFromOneScreenshot(base64Input, index) {
  const { mediaType, data } = parseBase64Input(base64Input);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data },
          },
          {
            type: 'text',
            text: `Extract the app context from this screenshot (screenshot ${index}).`,
          },
        ],
      },
    ],
  });

  const raw = response.content[0].text.trim();

  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    parsed._screenshot_index = index;
    return parsed;
  } catch (e) {
    // Return a minimal profile flagging the parse failure
    return {
      _screenshot_index: index,
      _parse_failed: true,
      screen_name: `Screenshot ${index}`,
      screen_purpose: 'unknown',
      navigation_path: 'not_visible',
      key_fields: [],
      action_buttons: [],
      success_indicators: [],
      error_indicators: [],
      current_state: 'other',
      confidence_notes: [`Parse failed: ${e.message}`],
    };
  }
}

/**
 * Merges multiple per-screen profiles into one unified AppProfile.
 * Later screenshots' fields take precedence for navigation and buttons.
 * All fields are unioned across screens.
 */
function mergeScreenProfiles(profiles) {
  const validProfiles = profiles.filter(p => !p._parse_failed);

  if (validProfiles.length === 0) {
    return buildEmptyAppProfile('All screenshot extractions failed');
  }

  // Navigation: prefer the most informative (longest path) across screens
  const navigationPaths = validProfiles
    .map(p => p.navigation_path)
    .filter(p => p && p !== 'not_visible');
  const navigation = navigationPaths.sort((a, b) => b.length - a.length)[0] || 'not_visible';

  // Fields: union across all screens, deduplicate by label
  const allFields = validProfiles.flatMap(p => p.key_fields || []);
  const uniqueFields = dedupeBy(allFields, f => f.label?.toLowerCase());

  // Buttons: union across all screens, deduplicate by label
  const allButtons = validProfiles.flatMap(p => p.action_buttons || []);
  const uniqueButtons = dedupeBy(allButtons, b => b.label?.toLowerCase());

  // Success/error indicators: union all
  const successIndicators = [...new Set(validProfiles.flatMap(p => p.success_indicators || []))];
  const errorIndicators   = [...new Set(validProfiles.flatMap(p => p.error_indicators || []))];

  // Confidence notes: collect all
  const confidenceNotes = validProfiles.flatMap(p => p.confidence_notes || []);

  // Screen names and purposes
  const screens = validProfiles.map(p => ({
    name: p.screen_name,
    purpose: p.screen_purpose,
    state: p.current_state,
    index: p._screenshot_index,
  }));

  return {
    source: 'screenshot',
    screenshots_processed: profiles.length,
    screenshots_failed: profiles.filter(p => p._parse_failed).length,
    screens,
    navigation,
    key_fields: uniqueFields,
    action_buttons: uniqueButtons,
    success_indicators: successIndicators,
    error_indicators: errorIndicators,
    confidence_notes: confidenceNotes,
    // Formatted summary for injection into TC generation prompt
    prompt_summary: buildPromptSummary({
      navigation,
      key_fields: uniqueFields,
      action_buttons: uniqueButtons,
      success_indicators: successIndicators,
      error_indicators: errorIndicators,
    }),
  };
}

/**
 * Builds the text block injected into the TC generation prompt.
 * This is what the LLM sees when writing test steps.
 */
function buildPromptSummary({ navigation, key_fields, action_buttons, success_indicators, error_indicators }) {
  const lines = ['APP PROFILE (extracted from screenshots):'];

  lines.push(`Navigation: ${navigation}`);

  if (key_fields.length > 0) {
    lines.push('\nFields:');
    key_fields.forEach(f => {
      const required = f.required === true ? ' (required)' : f.required === false ? ' (optional)' : '';
      const placeholder = f.placeholder ? ` — placeholder: "${f.placeholder}"` : '';
      lines.push(`  - ${f.label} [${f.input_type}]${required}${placeholder}`);
    });
  }

  if (action_buttons.length > 0) {
    lines.push('\nButtons:');
    action_buttons.forEach(b => {
      lines.push(`  - "${b.label}" (${b.type || 'unknown'}${b.position ? ', ' + b.position : ''})`);
    });
  }

  if (success_indicators.length > 0) {
    lines.push('\nSuccess indicators: ' + success_indicators.join('; '));
  }

  if (error_indicators.length > 0) {
    lines.push('Error indicators: ' + error_indicators.join('; '));
  }

  return lines.join('\n');
}

function buildEmptyAppProfile(reason) {
  return {
    source: 'screenshot',
    screenshots_processed: 0,
    screenshots_failed: 0,
    screens: [],
    navigation: 'not_visible',
    key_fields: [],
    action_buttons: [],
    success_indicators: [],
    error_indicators: [],
    confidence_notes: [reason],
    prompt_summary: 'APP PROFILE: not_available',
  };
}

function parseBase64Input(input) {
  // Handle data URI format: data:image/png;base64,<data>
  const dataUriMatch = input.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (dataUriMatch) {
    return { mediaType: dataUriMatch[1], data: dataUriMatch[2] };
  }
  // Raw base64 — default to PNG
  return { mediaType: 'image/png', data: input };
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { extractAppContext };
