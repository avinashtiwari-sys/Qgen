const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TC_PROMPT    = fs.readFileSync(path.join(__dirname, '../prompts/tc_generation.txt'), 'utf8');
const SC_PROMPT    = fs.readFileSync(path.join(__dirname, '../prompts/scenario_card.txt'), 'utf8');

/**
 * Generates test cases or scenario cards depending on app context availability.
 *
 * If appProfile is provided (from screenshots or app context form):
 *   → Generates FULL test cases with accurate steps
 * If appProfile is absent:
 *   → Generates INTENT-LEVEL test cases (steps with [APP CONTEXT NEEDED] markers)
 *   → Also generates a Scenario Card per path for tester reference
 *
 * @param {object[]} paths      - enumerated paths from pathEnumerator
 * @param {object}   wsf        - WSF object
 * @param {object}   appProfile - optional: from screenshotContextExtractor or app context form
 * @param {object}   options    - { batchSize }
 */
async function generateTestCases(paths, wsf, appProfile = null, options = {}) {
  const { batchSize = 5 } = options;
  const hasAppContext = isAppContextSufficient(appProfile);

  const executablePaths = paths.filter(p => p.status === 'enumerated');
  const skippedPaths    = paths.filter(p => p.status !== 'enumerated');

  const results = [];

  for (let i = 0; i < executablePaths.length; i += batchSize) {
    const batch = executablePaths.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((p, idx) => generateOne(p, wsf, appProfile, hasAppContext, i + idx + 1))
    );
    results.push(...batchResults);
  }

  for (const skipped of skippedPaths) {
    results.push({
      tc_id: skipped.path_id,
      status: 'skipped',
      reason: skipped.reason || skipped.status,
      path_id: skipped.path_id,
      wsf_flow_ref: skipped.wsf_flow_ref,
    });
  }

  return results;
}

async function generateOne(pathObj, wsf, appProfile, hasAppContext, index) {
  const tc_id = `TC-${String(index).padStart(3, '0')}`;
  const sc_id = `SC-${String(index).padStart(3, '0')}`;

  try {
    // Always generate the test case (full or intent-level based on context)
    const tcText = await callLLM(
      TC_PROMPT,
      buildTCPromptInput(pathObj, wsf, appProfile, hasAppContext, tc_id)
    );

    const result = {
      tc_id,
      path_id:          pathObj.path_id,
      wsf_flow_ref:     pathObj.wsf_flow_ref,
      terminal_outcome: pathObj.terminal_outcome,
      confidence:       pathObj.confidence,
      context_level:    hasAppContext ? 'FULL' : 'INTENT',
      status:           'generated',
      text:             tcText,
      structured:       parseTestCaseText(tcText, tc_id),
    };

    // When no app context: also generate a Scenario Card in parallel
    if (!hasAppContext) {
      const scText = await callLLM(
        SC_PROMPT,
        buildSCPromptInput(pathObj, wsf, sc_id)
      );
      result.scenario_card = {
        sc_id,
        text:       scText,
        structured: parseScenarioCardText(scText, sc_id),
      };
    }

    return result;

  } catch (err) {
    return {
      tc_id,
      path_id:      pathObj.path_id,
      wsf_flow_ref: pathObj.wsf_flow_ref,
      status:       'generation_failed',
      error:        err.message,
    };
  }
}

// ─── Prompt Input Builders ─────────────────────────────────────────────────

function buildTCPromptInput(pathObj, wsf, appProfile, hasAppContext, tc_id) {
  const dataEntities   = (wsf.data_entities   || []).filter(d => pathObj.data_refs.includes(d.ref_id));
  const businessRules  = (wsf.business_rules  || []).filter(r => pathObj.business_rule_refs.includes(r.rule_id));
  const steps          = pathObj.node_details.filter(n =>
    n.type !== 'START' && n.type !== 'END' && n.type !== 'TRUNCATED'
  );

  const lines = [
    `TC ID: ${tc_id}`,
    `FEATURE: ${wsf.feature_name} (${wsf.feature_id})`,
    `APP TYPE: ${wsf.app_context?.app_type || 'web'}`,
    `PLATFORM: ${wsf.app_context?.platform_hint || 'generic'}`,
    `SCENARIO: ${pathObj.condition_summary}`,
    `OUTCOME: ${pathObj.terminal_outcome}`,
    '',
    // ── App Profile section — drives FULL vs INTENT branching in prompt ──
    hasAppContext
      ? appProfile.prompt_summary
      : 'APP PROFILE: not_available',
    '',
    'PRECONDITIONS FROM WSF:',
    JSON.stringify(wsf.preconditions || [], null, 2),
    '',
    'ACTORS:',
    JSON.stringify(wsf.actors || [], null, 2),
    '',
    'STEPS IN THIS PATH (in order):',
    JSON.stringify(steps, null, 2),
    '',
    'ACTIVE BRANCH CONDITIONS:',
    JSON.stringify(pathObj.active_conditions, null, 2),
    '',
    'RELEVANT BUSINESS RULES:',
    JSON.stringify(businessRules, null, 2),
    '',
    'TEST DATA FOR THIS SCENARIO:',
    JSON.stringify(dataEntities, null, 2),
  ];

  return lines.join('\n');
}

function buildSCPromptInput(pathObj, wsf, sc_id) {
  const dataEntities  = (wsf.data_entities  || []).filter(d => pathObj.data_refs.includes(d.ref_id));
  const businessRules = (wsf.business_rules || []).filter(r => pathObj.business_rule_refs.includes(r.rule_id));

  return [
    `SC ID: ${sc_id}`,
    `FEATURE: ${wsf.feature_name} (${wsf.feature_id})`,
    `SCENARIO: ${pathObj.condition_summary}`,
    `OUTCOME: ${pathObj.terminal_outcome}`,
    '',
    'PRECONDITIONS:',
    JSON.stringify(wsf.preconditions || [], null, 2),
    '',
    'ACTORS:',
    JSON.stringify(wsf.actors || [], null, 2),
    '',
    'BUSINESS RULES FOR THIS PATH:',
    JSON.stringify(businessRules, null, 2),
    '',
    'TEST DATA:',
    JSON.stringify(dataEntities, null, 2),
    '',
    'OPEN QUESTIONS FROM WSF:',
    JSON.stringify(wsf.open_questions || [], null, 2),
  ].join('\n');
}

// ─── LLM Caller ────────────────────────────────────────────────────────────

async function callLLM(systemPrompt, userMessage) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content[0].text.trim();
}

// ─── Context Sufficiency Check ─────────────────────────────────────────────

function isAppContextSufficient(appProfile) {
  if (!appProfile) return false;
  if (appProfile.prompt_summary === 'APP PROFILE: not_available') return false;

  // Need at least navigation OR fields to write meaningful steps
  const hasNavigation = appProfile.navigation && appProfile.navigation !== 'not_visible';
  const hasFields     = appProfile.key_fields && appProfile.key_fields.length > 0;
  const hasButtons    = appProfile.action_buttons && appProfile.action_buttons.length > 0;

  return hasNavigation || (hasFields && hasButtons);
}

// ─── Output Parsers ────────────────────────────────────────────────────────

function parseTestCaseText(text, tc_id) {
  const getField = (label) => {
    const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  };

  const getBlock = (label) => {
    const match = text.match(new RegExp(`^${label}:\\n((?:[ \\t]+.*\\n?)*)`, 'm'));
    return match ? match[1].trim() : null;
  };

  const stepsBlock = text.match(/^Steps:\n([\s\S]*?)(?=\nFinal Expected Result:|\nTest Data:|\nLinked Requirement:|$)/m);
  const steps = stepsBlock
    ? stepsBlock[1].split(/\n(?=  \d+\.)/).map(s => s.trim()).filter(Boolean)
    : [];

  // Flag whether any steps need app context filled in
  const needsAppContext = steps.some(s => s.includes('[APP CONTEXT NEEDED]'));

  return {
    tc_id,
    context_level:          getField('Context Level'),
    title:                  getField('Title'),
    preconditions:          getBlock('Preconditions'),
    steps,
    needs_app_context:      needsAppContext,
    final_expected_result:  getBlock('Final Expected Result'),
    test_data:              getBlock('Test Data'),
    linked_requirement:     getField('Linked Requirement'),
    scenario_type:          getField('Scenario Type'),
  };
}

function parseScenarioCardText(text, sc_id) {
  const getField = (label) => {
    const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim() : null;
  };

  const getBlock = (label) => {
    const match = text.match(new RegExp(`^${label}:\\n((?:[ \\t]+.*\\n?)*)`, 'm'));
    return match ? match[1].trim() : null;
  };

  return {
    sc_id,
    title:                    getField('Title'),
    scenario_type:            getField('Scenario Type'),
    what_to_test:             getBlock('What to Test'),
    preconditions:            getBlock('Preconditions'),
    test_data:                getBlock('Test Data'),
    expected_outcome:         getBlock('Expected Outcome'),
    negative_scenarios:       getBlock('Negative Scenarios to Also Cover'),
    open_questions:           getBlock('Open Questions'),
    business_rule_tested:     getField('Business Rule Tested'),
    linked_requirement:       getField('Linked Requirement'),
  };
}

module.exports = { generateTestCases };
