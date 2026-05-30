require('dotenv').config();
const { runPipeline } = require('./src/pipeline/index');

// ─── Sample Inputs ─────────────────────────────────────────────────────────
// Switch SAMPLE to test different input types

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
    - Stage dropdown options: Prospecting, Qualification, Proposal, Negotiation, Closed Won, Closed Lost
    - Amount field is optional but recommended
    - If Stage is set to Closed Won, the Probability field must be 100%
    - If Stage is set to Closed Lost, I must enter a Loss Reason (required)
    - Once saved, the Opportunity appears in the Account's related list
    - Only the owner or users with Edit permission can modify the Opportunity
  `,

  mobile: `
    As a mobile app user, I want to reset my password so I can regain access to my account.

    - On the login screen, there is a "Forgot Password?" link
    - Tapping it opens the Reset Password screen
    - I enter my registered email address
    - If the email exists, the app shows "Check your email for reset instructions"
    - If the email does not exist, the app shows "No account found with this email"
    - The reset email contains a 6-digit OTP valid for 10 minutes
    - I enter the OTP on the Verify OTP screen
    - If OTP is correct, I am taken to the Set New Password screen
    - If OTP is expired or wrong, I see "Invalid or expired code. Please try again."
    - New password must be at least 8 characters with one number
    - After successful reset, I am redirected to login with a success message
  `,

};

// ─── Pick your sample ───────────────────────────────────────────────────────
const ACTIVE_SAMPLE = 'user_story'; // change to: gherkin | salesforce | mobile

// ─── Context hints (optional) ───────────────────────────────────────────────
const CONTEXT = {
  user_story:  { app_type: 'web',          platform_hint: 'generic'     },
  gherkin:     { app_type: 'web',          platform_hint: 'generic'     },
  salesforce:  { app_type: 'web',          platform_hint: 'salesforce'  },
  mobile:      { app_type: 'mobile_ios',   platform_hint: 'generic'     },
};

// ─── Progress printer ───────────────────────────────────────────────────────
function onProgress({ stage, ...detail }) {
  const icons = {
    classifying_input:       '🔍',
    input_classified:        '✅',
    building_wsf:            '🏗️ ',
    wsf_built:               '✅',
    blocking_questions_found:'⚠️ ',
    generating_cfgs:         '🔀',
    cfgs_generated:          '✅',
    enumerating_paths:       '🛤️ ',
    paths_enumerated:        '✅',
    generating_test_cases:   '📝',
    complete:                '🎉',
  };
  const icon = icons[stage] || '  ';
  const detailStr = Object.keys(detail).length ? JSON.stringify(detail) : '';
  console.log(`${icon} [${stage}] ${detailStr}`);
}

// ─── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌  ANTHROPIC_API_KEY not set. Add it to .env or export it.');
    process.exit(1);
  }

  console.log('═'.repeat(60));
  console.log(`  Qgen Pipeline Test — Sample: ${ACTIVE_SAMPLE}`);
  console.log('═'.repeat(60));

  const input   = SAMPLES[ACTIVE_SAMPLE];
  const context = CONTEXT[ACTIVE_SAMPLE];

  const startTime = Date.now();
  let result;

  try {
    result = await runPipeline(input, context, onProgress);
  } catch (err) {
    console.error('\n❌  Pipeline failed:', err.message);
    if (err.raw) console.error('Raw LLM output:\n', err.raw);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  SUMMARY');
  console.log('═'.repeat(60));
  console.log(JSON.stringify(result.summary, null, 2));

  // ─── Open Questions ────────────────────────────────────────────────────────
  if (result.summary.open_questions.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('  OPEN QUESTIONS (need human input)');
    console.log('─'.repeat(60));
    result.summary.open_questions.forEach(q => {
      const flag = q.blocking ? '🔴 BLOCKING' : '🟡 non-blocking';
      console.log(`\n[${flag}] ${q.oq_id}: ${q.question}`);
      console.log(`  Impact: ${q.impact}`);
    });
  }

  // ─── CFG Validation Issues ────────────────────────────────────────────────
  const badCFGs = result.cfgs.filter(c => c.status !== 'valid');
  if (badCFGs.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('  CFG ISSUES');
    console.log('─'.repeat(60));
    badCFGs.forEach(c => {
      console.log(`\nFlow: ${c.wsf_flow_ref} — status: ${c.status}`);
      (c.validation_errors || []).forEach(e => console.log(`  ✗ ${e}`));
    });
  }

  // ─── Generated Test Cases ─────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  GENERATED TEST CASES');
  console.log('═'.repeat(60));

  const generated = result.test_cases.filter(t => t.status === 'generated');

  if (generated.length === 0) {
    console.log('\n⚠️  No test cases generated. Check CFG issues and open questions above.');
  }

  generated.forEach((tc, i) => {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(tc.text);
  });

  // ─── Failed / Skipped ─────────────────────────────────────────────────────
  const failed  = result.test_cases.filter(t => t.status === 'generation_failed');
  const skipped = result.test_cases.filter(t => t.status === 'skipped');

  if (failed.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log(`  FAILED (${failed.length})`);
    failed.forEach(t => console.log(`  ${t.tc_id}: ${t.error}`));
  }

  if (skipped.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log(`  SKIPPED (${skipped.length}) — CFG issues prevented path enumeration`);
    skipped.forEach(t => console.log(`  ${t.path_id}: ${t.reason}`));
  }

  console.log(`\n⏱  Completed in ${elapsed}s`);
  console.log('═'.repeat(60));
}

main();
