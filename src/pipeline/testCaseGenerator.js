const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/tc_generation.txt'), 'utf8');

/**
 * Generates manual test cases from enumerated paths.
 * Processes paths in parallel batches to control API rate.
 */
async function generateTestCases(paths, wsf, options = {}) {
  const { batchSize = 5 } = options;

  const executablePaths = paths.filter(p => p.status === 'enumerated');
  const skippedPaths = paths.filter(p => p.status !== 'enumerated');

  const results = [];
  for (let i = 0; i < executablePaths.length; i += batchSize) {
    const batch = executablePaths.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((p, idx) => generateOneTestCase(p, wsf, i + idx + 1))
    );
    results.push(...batchResults);
  }

  // Append skipped path entries as flagged items
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

async function generateOneTestCase(pathObj, wsf, index) {
  const tc_id = `TC-${String(index).padStart(3, '0')}`;
  const userMessage = buildTCPromptInput(pathObj, wsf, tc_id);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0].text.trim();

    return {
      tc_id,
      path_id: pathObj.path_id,
      wsf_flow_ref: pathObj.wsf_flow_ref,
      terminal_outcome: pathObj.terminal_outcome,
      confidence: pathObj.confidence,
      status: 'generated',
      text,                          // raw formatted test case for display
      structured: parseTestCaseText(text, tc_id),  // structured for export
    };
  } catch (err) {
    return {
      tc_id,
      path_id: pathObj.path_id,
      wsf_flow_ref: pathObj.wsf_flow_ref,
      status: 'generation_failed',
      error: err.message,
    };
  }
}

function buildTCPromptInput(pathObj, wsf, tc_id) {
  // Resolve data entities referenced in this path
  const dataEntities = (wsf.data_entities || []).filter(d =>
    pathObj.data_refs.includes(d.ref_id)
  );

  // Resolve business rules referenced in this path
  const businessRules = (wsf.business_rules || []).filter(r =>
    pathObj.business_rule_refs.includes(r.rule_id)
  );

  // Build ordered step list from path nodes (exclude START/END)
  const steps = pathObj.node_details.filter(n =>
    n.type !== 'START' && n.type !== 'END' && n.type !== 'TRUNCATED'
  );

  return [
    `TC ID: ${tc_id}`,
    `FEATURE: ${wsf.feature_name} (${wsf.feature_id})`,
    `APP TYPE: ${wsf.app_context?.app_type || 'web'}`,
    `SCENARIO: ${pathObj.condition_summary}`,
    `OUTCOME: ${pathObj.terminal_outcome}`,
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
  ].join('\n');
}

/**
 * Parses the plain-text TC output into a structured object for export.
 * Best-effort — fields left null if not found.
 */
function parseTestCaseText(text, tc_id) {
  const get = (label) => {
    const regex = new RegExp(`^${label}:\\s*(.+)$`, 'm');
    const match = text.match(regex);
    return match ? match[1].trim() : null;
  };

  const getBlock = (label, nextLabel) => {
    const regex = new RegExp(`^${label}:\\n((?:  .*\\n?)*)`, 'm');
    const match = text.match(regex);
    return match ? match[1].trim() : null;
  };

  // Extract numbered steps
  const stepsBlock = text.match(/^Steps:\n([\s\S]*?)(?=\nFinal Expected Result:|\nTest Data:|\nLinked Requirement:|$)/m);
  const steps = stepsBlock
    ? stepsBlock[1].split(/\n(?=  \d+\.)/).map(s => s.trim()).filter(Boolean)
    : [];

  return {
    tc_id,
    title: get('Title'),
    preconditions: getBlock('Preconditions', 'Steps'),
    steps,
    final_expected_result: getBlock('Final Expected Result', 'Test Data'),
    test_data: getBlock('Test Data', 'Linked Requirement'),
    linked_requirement: get('Linked Requirement'),
    scenario_type: get('Scenario Type'),
  };
}

module.exports = { generateTestCases };
