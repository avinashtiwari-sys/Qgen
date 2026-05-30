const { classifyInput }      = require('./inputRouter');
const { buildWSF }           = require('./wsfBuilder');
const { generateCFGs }       = require('./cfgGenerator');
const { enumerateAllPaths }  = require('./pathEnumerator');
const { generateTestCases }  = require('./testCaseGenerator');

/**
 * Core 3-step pipeline:
 *   Step 1: Classify input + build WSF
 *   Step 2: Generate CFGs + enumerate paths
 *   Step 3: Generate test cases from paths
 *
 * @param {string|object} rawInput   - text, { figma_url }, { screenshot_base64, text }, etc.
 * @param {object}        context    - optional hints: { app_type, platform_hint, feature_id }
 * @param {function}      onProgress - optional callback(stage, detail) for streaming updates to UI
 *
 * @returns {object} pipeline result with wsf, cfgs, paths, test_cases, summary
 */
async function runPipeline(rawInput, context = {}, onProgress = null) {
  const notify = (stage, detail = {}) => {
    if (onProgress) onProgress({ stage, ...detail });
  };

  // ─── Step 1: Input Classification + WSF Building ──────────────────────────
  notify('classifying_input');
  const { type: inputType, confidence: classifyConfidence } = await classifyInput(rawInput);
  notify('input_classified', { inputType, classifyConfidence });

  notify('building_wsf');
  const wsf = await buildWSF(rawInput, inputType, context);
  notify('wsf_built', {
    featureId: wsf.feature_id,
    flowCount: wsf.flows.length,
    openQuestions: wsf.open_questions?.length || 0,
    blockingQuestions: wsf.open_questions?.filter(q => q.blocking).length || 0,
  });

  // Surface blocking questions early — caller can decide to halt or continue
  const blockingQuestions = (wsf.open_questions || []).filter(q => q.blocking);
  if (blockingQuestions.length > 0) {
    notify('blocking_questions_found', { questions: blockingQuestions });
  }

  // ─── Step 2: CFG Generation + Path Enumeration ────────────────────────────
  notify('generating_cfgs');
  const cfgs = await generateCFGs(wsf);

  const validCFGs   = cfgs.filter(c => c.status === 'valid');
  const invalidCFGs = cfgs.filter(c => c.status !== 'valid');
  notify('cfgs_generated', {
    total: cfgs.length,
    valid: validCFGs.length,
    invalid: invalidCFGs.length,
    issues: invalidCFGs.map(c => ({ flow: c.wsf_flow_ref, status: c.status, errors: c.validation_errors })),
  });

  notify('enumerating_paths');
  const paths = enumerateAllPaths(cfgs);
  notify('paths_enumerated', {
    total: paths.length,
    enumerated: paths.filter(p => p.status === 'enumerated').length,
    skipped: paths.filter(p => p.status === 'skipped').length,
    truncated: paths.filter(p => p.status === 'truncated').length,
  });

  // ─── Step 3: Test Case Generation ─────────────────────────────────────────
  notify('generating_test_cases');
  const testCases = await generateTestCases(paths, wsf);

  const generated = testCases.filter(t => t.status === 'generated');
  const failed    = testCases.filter(t => t.status === 'generation_failed');
  const skipped   = testCases.filter(t => t.status === 'skipped');

  notify('complete', {
    total: testCases.length,
    generated: generated.length,
    failed: failed.length,
    skipped: skipped.length,
  });

  return {
    wsf,
    cfgs,
    paths,
    test_cases: testCases,
    summary: {
      feature_id:        wsf.feature_id,
      feature_name:      wsf.feature_name,
      input_type:        inputType,
      flows_processed:   wsf.flows.length,
      cfgs_valid:        validCFGs.length,
      paths_enumerated:  paths.filter(p => p.status === 'enumerated').length,
      test_cases_generated: generated.length,
      test_cases_failed:    failed.length,
      test_cases_skipped:   skipped.length,
      blocking_questions:   blockingQuestions.length,
      open_questions:       wsf.open_questions || [],
    },
  };
}

module.exports = { runPipeline };
