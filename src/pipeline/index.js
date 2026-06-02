const { classifyInput }          = require('./inputRouter');
const { buildWSF }               = require('./wsfBuilder');
const { generateCFGs }           = require('./cfgGenerator');
const { enumerateAllPaths }      = require('./pathEnumerator');
const { generateTestCases }      = require('./testCaseGenerator');
const { extractAppContext }      = require('./screenshotContextExtractor');

/**
 * Core 3-step pipeline:
 *   Step 1: Classify input + build WSF
 *           + extract AppProfile from screenshots (P3) if provided
 *   Step 2: Generate CFGs + enumerate paths
 *   Step 3: Generate test cases (FULL if app context, INTENT + Scenario Card if not)
 *
 * @param {string|object} rawInput   - text, { figma_url }, { screenshot_base64 }, etc.
 * @param {object}        context    - { app_type, platform_hint, feature_id, app_screenshots? }
 *                                     app_screenshots: string | string[] — base64 images of the app UI
 * @param {function}      onProgress - optional callback({ stage, ...detail })
 */
async function runPipeline(rawInput, context = {}, onProgress = null) {
  const notify = (stage, detail = {}) => {
    if (onProgress) onProgress({ stage, ...detail });
  };

  // ─── Step 1a: Input Classification + WSF Building ─────────────────────────
  notify('classifying_input');
  const { type: inputType, confidence: classifyConfidence } = await classifyInput(rawInput);
  notify('input_classified', { inputType, classifyConfidence });

  notify('building_wsf');
  const wsf = await buildWSF(rawInput, inputType, context);
  notify('wsf_built', {
    featureId:         wsf.feature_id,
    flowCount:         wsf.flows.length,
    openQuestions:     wsf.open_questions?.length || 0,
    blockingQuestions: wsf.open_questions?.filter(q => q.blocking).length || 0,
  });

  const blockingQuestions = (wsf.open_questions || []).filter(q => q.blocking);
  if (blockingQuestions.length > 0) {
    notify('blocking_questions_found', { questions: blockingQuestions });
  }

  // ─── Step 1b: Screenshot Context Extraction (P3) ──────────────────────────
  let appProfile = null;

  if (context.app_screenshots) {
    notify('extracting_app_context');
    try {
      appProfile = await extractAppContext(context.app_screenshots);
      notify('app_context_extracted', {
        source:               appProfile.source,
        screenshotsProcessed: appProfile.screenshots_processed,
        screenshotsFailed:    appProfile.screenshots_failed,
        fieldsFound:          appProfile.key_fields?.length || 0,
        navigationFound:      appProfile.navigation !== 'not_visible',
        contextSufficient:    isContextSufficient(appProfile),
      });
    } catch (err) {
      notify('app_context_extraction_failed', { error: err.message });
      appProfile = null;
    }
  } else {
    notify('app_context_unavailable', {
      message: 'No screenshots provided — will generate intent-level test cases + scenario cards',
    });
  }

  // ─── Step 2: CFG Generation + Path Enumeration ────────────────────────────
  notify('generating_cfgs');
  const cfgs = await generateCFGs(wsf);

  const validCFGs   = cfgs.filter(c => c.status === 'valid');
  const invalidCFGs = cfgs.filter(c => c.status !== 'valid');
  notify('cfgs_generated', {
    total:   cfgs.length,
    valid:   validCFGs.length,
    invalid: invalidCFGs.length,
    issues:  invalidCFGs.map(c => ({ flow: c.wsf_flow_ref, status: c.status, errors: c.validation_errors })),
  });

  notify('enumerating_paths');
  const paths = enumerateAllPaths(cfgs);
  notify('paths_enumerated', {
    total:      paths.length,
    enumerated: paths.filter(p => p.status === 'enumerated').length,
    skipped:    paths.filter(p => p.status === 'skipped').length,
    truncated:  paths.filter(p => p.status === 'truncated').length,
  });

  // ─── Step 3: Test Case Generation ─────────────────────────────────────────
  notify('generating_test_cases', {
    mode: appProfile && isContextSufficient(appProfile) ? 'FULL' : 'INTENT + SCENARIO_CARD',
  });

  const testCases = await generateTestCases(paths, wsf, appProfile);

  const generated     = testCases.filter(t => t.status === 'generated');
  const fullContext   = generated.filter(t => t.context_level === 'FULL');
  const intentLevel   = generated.filter(t => t.context_level === 'INTENT');
  const failed        = testCases.filter(t => t.status === 'generation_failed');
  const skipped       = testCases.filter(t => t.status === 'skipped');

  notify('complete', {
    total:         testCases.length,
    generated:     generated.length,
    full_context:  fullContext.length,
    intent_level:  intentLevel.length,
    failed:        failed.length,
    skipped:       skipped.length,
  });

  return {
    wsf,
    cfgs,
    paths,
    app_profile:  appProfile,
    test_cases:   testCases,
    summary: {
      feature_id:              wsf.feature_id,
      feature_name:            wsf.feature_name,
      input_type:              inputType,
      flows_processed:         wsf.flows.length,
      cfgs_valid:              validCFGs.length,
      paths_enumerated:        paths.filter(p => p.status === 'enumerated').length,
      test_cases_generated:    generated.length,
      test_cases_full:         fullContext.length,
      test_cases_intent:       intentLevel.length,
      test_cases_failed:       failed.length,
      test_cases_skipped:      skipped.length,
      app_context_available:   appProfile !== null && isContextSufficient(appProfile),
      blocking_questions:      blockingQuestions.length,
      open_questions:          wsf.open_questions || [],
    },
  };
}

function isContextSufficient(appProfile) {
  if (!appProfile) return false;
  if (appProfile.prompt_summary === 'APP PROFILE: not_available') return false;
  const hasNavigation = appProfile.navigation && appProfile.navigation !== 'not_visible';
  const hasFields     = appProfile.key_fields?.length > 0;
  const hasButtons    = appProfile.action_buttons?.length > 0;
  return hasNavigation || (hasFields && hasButtons);
}

module.exports = { runPipeline };
