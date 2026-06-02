require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runPipeline } = require('./src/pipeline/index');

// ─── Sample Inputs ─────────────────────────────────────────────────────────

const SAMPLES = {

  user_story: `
    As a Finance Analyst, I want to create and submit an invoice so that vendors can be paid.

    Acceptance Criteria:
    - I can navigate to Invoices > Create New
    - I must select a vendor (required field)
    - I must enter an invoice amount (required, must be positive)
    - If the amount is $10,000 or below, the invoice is auto-approved on submission
    - If the amount exceeds $10,000, the invoice is routed to Finance Manager for approval
    - If I submit without selecting a vendor, the form shows a validation error
    - On successful submission, I see a confirmation message and the invoice appears in my list
  `,

  gherkin: `
    Feature: User Login
      As a registered user, I want to log in to the application

      Scenario: Successful login with valid credentials
        Given I am on the login page
        When I enter valid email "user@example.com"
        And I enter valid password "Password123"
        And I click the Login button
        Then I should be redirected to the dashboard
        And I should see my username in the header

      Scenario: Login fails with invalid password
        Given I am on the login page
        When I enter valid email "user@example.com"
        And I enter incorrect password "WrongPass"
        And I click the Login button
        Then I should see error message "Invalid credentials"
        And I should remain on the login page

      Scenario: Login with empty fields
        Given I am on the login page
        When I click the Login button without entering credentials
        Then I should see validation errors on both email and password fields
  `,

  salesforce: `
    As a Sales Rep, I want to create a new Opportunity in Salesforce so I can track a potential deal.

    - I can create an Opportunity from the Opportunities tab or from an Account record
    - Required fields: Opportunity Name, Close Date, Stage
    - Stage options: Prospecting, Qualification, Proposal, Negotiation, Closed Won, Closed Lost
    - Amount field is optional but recommended
    - If Stage = Closed Won, Probability must be 100%
    - If Stage = Closed Lost, Loss Reason is required
    - Once saved, the Opportunity appears in the Account's related list
    - Only the owner or users with Edit permission can modify it
  `,

  mobile: `
    As a mobile app user, I want to reset my password so I can regain access to my account.

    - On the login screen there is a "Forgot Password?" link
    - Tapping it opens the Reset Password screen
    - I enter my registered email address
    - If the email exists: app shows "Check your email for reset instructions"
    - If the email does not exist: app shows "No account found with this email"
    - The reset email contains a 6-digit OTP valid for 10 minutes
    - I enter the OTP on the Verify OTP screen
    - If OTP correct: taken to Set New Password screen
    - If OTP expired or wrong: "Invalid or expired code. Please try again."
    - New password must be at least 8 characters with one number
    - After successful reset: redirected to login with success message
  `,

};

// ─── Test Modes ─────────────────────────────────────────────────────────────
//
//  MODE 1 (default): No app screenshots → INTENT-LEVEL test cases + Scenario Cards
//  MODE 2:           With app screenshots → FULL test cases with accurate steps
//
//  To use MODE 2: set APP_SCREENSHOTS_DIR to a folder containing PNG/JPG screenshots
//  of the app UI. Screenshots are loaded and sent as base64.
//
//  Example:
//    APP_SCREENSHOTS_DIR = './test_screenshots/invoice'
//    Place invoice_form.png, invoice_success.png etc. in that folder.

const ACTIVE_SAMPLE       = 'user_story';  // user_story | gherkin | salesforce | mobile
const APP_SCREENSHOTS_DIR = null;          // set to a folder path to enable MODE 2

// ─── Context hints ──────────────────────────────────────────────────────────

const CONTEXT = {
  user_story: { app_type: 'web',        platform_hint: 'generic'    },
  gherkin:    { app_type: 'web',        platform_hint: 'generic'    },
  salesforce: { app_type: 'web',        platform_hint: 'salesforce' },
  mobile:     { app_type: 'mobile_ios', platform_hint: 'generic'    },
};

// ─── Load screenshots if folder is set ──────────────────────────────────────

function loadScreenshots(dir) {
  if (!dir) return null;
  if (!fs.existsSync(dir)) {
    console.warn(`⚠️  Screenshots folder not found: ${dir}`);
    return null;
  }
  const files = fs.readdirSync(dir)
    .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
    .map(f => path.join(dir, f));

  if (files.length === 0) {
    console.warn(`⚠️  No PNG/JPG files found in: ${dir}`);
    return null;
  }

  console.log(`📸 Loading ${files.length} screenshot(s) from: ${dir}`);
  return files.map(f => {
    const ext = path.extname(f).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    const data = fs.readFileSync(f).toString('base64');
    return `data:${mime};base64,${data}`;
  });
}

// ─── Progress printer ────────────────────────────────────────────────────────

function onProgress({ stage, ...detail }) {
  const icons = {
    classifying_input:            '🔍',
    input_classified:             '✅',
    building_wsf:                 '🏗️ ',
    wsf_built:                    '✅',
    blocking_questions_found:     '⚠️ ',
    extracting_app_context:       '📸',
    app_context_extracted:        '✅',
    app_context_extraction_failed:'❌',
    app_context_unavailable:      '💡',
    generating_cfgs:              '🔀',
    cfgs_generated:               '✅',
    enumerating_paths:            '🛤️ ',
    paths_enumerated:             '✅',
    generating_test_cases:        '📝',
    complete:                     '🎉',
  };
  const icon = icons[stage] || '  ';
  const detailStr = Object.keys(detail).length ? JSON.stringify(detail) : '';
  console.log(`${icon} [${stage}] ${detailStr}`);
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌  ANTHROPIC_API_KEY not set. Add it to .env');
    process.exit(1);
  }

  const appScreenshots = loadScreenshots(APP_SCREENSHOTS_DIR);
  const context = {
    ...CONTEXT[ACTIVE_SAMPLE],
    ...(appScreenshots ? { app_screenshots: appScreenshots } : {}),
  };

  const mode = appScreenshots ? 'MODE 2 — FULL (with screenshots)' : 'MODE 1 — INTENT (no screenshots)';

  console.log('═'.repeat(65));
  console.log(`  Qgen Pipeline Test`);
  console.log(`  Sample : ${ACTIVE_SAMPLE}`);
  console.log(`  Mode   : ${mode}`);
  console.log('═'.repeat(65));

  const startTime = Date.now();
  let result;

  try {
    result = await runPipeline(SAMPLES[ACTIVE_SAMPLE], context, onProgress);
  } catch (err) {
    console.error('\n❌  Pipeline failed:', err.message);
    if (err.raw) console.error('Raw LLM output:\n', err.raw);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(65));
  console.log('  SUMMARY');
  console.log('═'.repeat(65));
  console.log(JSON.stringify(result.summary, null, 2));

  // ─── App Profile (if extracted) ───────────────────────────────────────────
  if (result.app_profile) {
    console.log('\n' + '─'.repeat(65));
    console.log('  APP PROFILE EXTRACTED FROM SCREENSHOTS');
    console.log('─'.repeat(65));
    console.log(`Navigation : ${result.app_profile.navigation}`);
    console.log(`Fields     : ${result.app_profile.key_fields?.map(f => f.label).join(', ')}`);
    console.log(`Buttons    : ${result.app_profile.action_buttons?.map(b => b.label).join(', ')}`);
    if (result.app_profile.confidence_notes?.length > 0) {
      console.log('Confidence notes:');
      result.app_profile.confidence_notes.forEach(n => console.log(`  ⚠ ${n}`));
    }
  }

  // ─── Open Questions ────────────────────────────────────────────────────────
  if (result.summary.open_questions.length > 0) {
    console.log('\n' + '─'.repeat(65));
    console.log('  OPEN QUESTIONS');
    console.log('─'.repeat(65));
    result.summary.open_questions.forEach(q => {
      const flag = q.blocking ? '🔴 BLOCKING' : '🟡 non-blocking';
      console.log(`\n[${flag}] ${q.oq_id}: ${q.question}`);
      console.log(`  Impact: ${q.impact}`);
    });
  }

  // ─── CFG Issues ───────────────────────────────────────────────────────────
  const badCFGs = result.cfgs.filter(c => c.status !== 'valid');
  if (badCFGs.length > 0) {
    console.log('\n' + '─'.repeat(65));
    console.log('  CFG ISSUES');
    console.log('─'.repeat(65));
    badCFGs.forEach(c => {
      console.log(`\nFlow: ${c.wsf_flow_ref} — status: ${c.status}`);
      (c.validation_errors || []).forEach(e => console.log(`  ✗ ${e}`));
    });
  }

  // ─── Generated Output ─────────────────────────────────────────────────────
  const generated = result.test_cases.filter(t => t.status === 'generated');

  if (generated.length === 0) {
    console.log('\n⚠️  No test cases generated. Check CFG issues and open questions above.');
  }

  generated.forEach(tc => {
    const contextBadge = tc.context_level === 'FULL' ? '🟢 FULL' : '🟡 INTENT';

    console.log('\n' + '═'.repeat(65));
    console.log(`${contextBadge}  ${tc.tc_id}`);

    // Test Case
    console.log('\n── TEST CASE ──────────────────────────────────────────────');
    console.log(tc.text);

    // Scenario Card (only present when context_level = INTENT)
    if (tc.scenario_card) {
      console.log('\n── SCENARIO CARD ──────────────────────────────────────────');
      console.log(tc.scenario_card.text);
    }
  });

  // ─── Failed / Skipped ─────────────────────────────────────────────────────
  const failed  = result.test_cases.filter(t => t.status === 'generation_failed');
  const skipped = result.test_cases.filter(t => t.status === 'skipped');

  if (failed.length > 0) {
    console.log('\n' + '─'.repeat(65));
    console.log(`  FAILED (${failed.length})`);
    failed.forEach(t => console.log(`  ${t.tc_id}: ${t.error}`));
  }

  if (skipped.length > 0) {
    console.log('\n' + '─'.repeat(65));
    console.log(`  SKIPPED (${skipped.length})`);
    skipped.forEach(t => console.log(`  ${t.path_id}: ${t.reason}`));
  }

  console.log(`\n⏱  Completed in ${elapsed}s`);
  console.log('═'.repeat(65));
}

main();
