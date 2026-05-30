# Qgen — Manual Test Case Generation Engine

Qgen generates structured, human-executable manual test cases from natural language inputs (user stories, Gherkin, Figma links, screenshots, specs). It uses a 3-step pipeline — WSF extraction → CFG generation → test case writing — to produce accurate, non-redundant test cases that cover all conditional branches.

---

## How It Works

```
Input (user story / Gherkin / Figma / screenshot)
  │
  ▼
Step 1 — Input Router + WSF Builder
  Classifies input type, extracts a Workflow Specification Format (WSF) JSON
  capturing actors, flows, steps, business rules, test data, and open questions.
  │
  ▼
Step 2 — CFG Generator + Path Enumerator
  Converts each WSF flow into a validated Control Flow Graph (CFG).
  Enumerates all root-to-END paths via DFS — each path = one test scenario.
  │
  ▼
Step 3 — Test Case Generator
  Generates a complete manual test case per path:
  preconditions, numbered steps, expected results, test data, traceability.
```

---

## Project Structure

```
Qgen/
├── src/
│   ├── pipeline/
│   │   ├── index.js              # Orchestrator — runPipeline() entry point
│   │   ├── inputRouter.js        # Step 1a: classify input type
│   │   ├── wsfBuilder.js         # Step 1b: raw input → WSF JSON (LLM)
│   │   ├── cfgGenerator.js       # Step 2a: WSF flow → CFG JSON (LLM + retry)
│   │   ├── pathEnumerator.js     # Step 2b: CFG → all paths (pure DFS, no LLM)
│   │   └── testCaseGenerator.js  # Step 3: path + WSF → test case text (LLM)
│   ├── validators/
│   │   └── cfgValidator.js       # 9-rule structural CFG validator (no LLM)
│   ├── prompts/
│   │   ├── wsf_extraction.txt    # System prompt for WSF building
│   │   ├── cfg_generation.txt    # System prompt for CFG generation
│   │   └── tc_generation.txt     # System prompt for test case writing
│   └── routes/
│       └── generate.js           # Express POST /generate route
├── test_pipeline.js              # End-to-end test script (4 sample inputs)
├── package.json
├── .env                          # Your API keys (not committed)
└── .gitignore
```

---

## Prerequisites

- Node.js v18+
- npm v9+
- An Anthropic API key → https://console.anthropic.com

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/avinashtiwari-sys/Qgen.git
cd Qgen
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the project root:

```bash
cp .env.example .env    # if .env.example exists, otherwise create manually
```

Add your API key:

```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Running the Test Pipeline

The test script runs the full 3-step pipeline end-to-end and prints all output to the console.

```bash
npm run test:pipeline
```

Or directly:

```bash
node test_pipeline.js
```

### Switching Sample Inputs

Open `test_pipeline.js` and change the `ACTIVE_SAMPLE` value near the top:

```js
const ACTIVE_SAMPLE = 'user_story'; // options below
```

| Value | Description |
|---|---|
| `user_story` | Invoice submission with approval threshold — standard web app |
| `gherkin` | User login with 3 Gherkin scenarios |
| `salesforce` | Opportunity creation — Salesforce platform |
| `mobile` | Password reset with OTP — mobile iOS app |

### Sample Output

```
════════════════════════════════════════════════════════════
  Qgen Pipeline Test — Sample: user_story
════════════════════════════════════════════════════════════
🔍 [classifying_input]
✅ [input_classified]       {"inputType":"user_story","classifyConfidence":"high"}
🏗️  [building_wsf]
✅ [wsf_built]              {"flowCount":3,"openQuestions":1,"blockingQuestions":1}
⚠️  [blocking_questions_found]
🔀 [generating_cfgs]
✅ [cfgs_generated]         {"total":3,"valid":3,"invalid":0}
🛤️  [enumerating_paths]
✅ [paths_enumerated]       {"total":5,"enumerated":5,"skipped":0}
📝 [generating_test_cases]
🎉 [complete]               {"generated":5,"failed":0,"skipped":0}

══════════════════════════════════════════════════════════════
  SUMMARY
══════════════════════════════════════════════════════════════
{
  "feature_id": "FEAT-...",
  "flows_processed": 3,
  "cfgs_valid": 3,
  "paths_enumerated": 5,
  "test_cases_generated": 5,
  "blocking_questions": 1
}

══════════════════════════════════════════════════════════════
  GENERATED TEST CASES
══════════════════════════════════════════════════════════════

──────────────────────────────────────────────────────────────
ID: TC-001
Title: Submit invoice below approval threshold — auto-approved

Preconditions:
  - Logged in as Finance Analyst
  - At least one active vendor exists in the test environment
  - Approval threshold configured at $10,000

Steps:
  1. Navigate to Invoices > Create New
     → Blank invoice form is displayed

  2. Select an active vendor from the Vendor dropdown
     → Vendor name, address, and currency fields auto-populate

  3. Enter Amount: $9,999
     → Amount is accepted; no threshold warning is shown

  4. Click Submit
     → Invoice saved with status "Approved"
     → Confirmation message displayed on screen

Final Expected Result:
  - Invoice status shows "Approved"
  - Invoice appears in the Approved Invoices list
  - Invoice must NOT appear in the Pending Approval queue

Test Data:
  - Vendor: any active vendor in the test environment
  - Amount: $9,999 (boundary: $1 below the $10,000 approval threshold)

Linked Requirement: FEAT-...
Scenario Type: happy_path
```

---

## Integrating Into Your Express App

Replace your existing `/generate` route handler with the pipeline route:

```js
// app.js (your existing Express entry point)
const generateRoute = require('./src/routes/generate');
app.use('/api', generateRoute);
```

### API — POST `/api/generate`

**Request body:**

```json
{
  "text": "As a Finance Analyst, I want to...",
  "context": {
    "app_type": "web",
    "platform_hint": "generic"
  },
  "stream": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | string | Yes* | User story, Gherkin, or spec text |
| `figma_url` | string | Yes* | Figma file/prototype URL (alternative to text) |
| `screenshot_base64` | string | Yes* | Base64-encoded image (alternative to text) |
| `context.app_type` | string | No | `web`, `mobile_ios`, `mobile_android`, `desktop`, `api` |
| `context.platform_hint` | string | No | `salesforce`, `servicenow`, `sap`, `insurance`, `generic` |
| `stream` | boolean | No | If `true`, returns Server-Sent Events with live progress |

*One of `text`, `figma_url`, or `screenshot_base64` is required.

**Response (stream: false):**

```json
{
  "wsf": { ... },
  "cfgs": [ ... ],
  "paths": [ ... ],
  "test_cases": [
    {
      "tc_id": "TC-001",
      "status": "generated",
      "text": "ID: TC-001\nTitle: ...",
      "structured": {
        "title": "...",
        "preconditions": "...",
        "steps": [ ... ],
        "final_expected_result": "...",
        "test_data": "...",
        "linked_requirement": "FEAT-001",
        "scenario_type": "happy_path"
      }
    }
  ],
  "summary": {
    "flows_processed": 3,
    "cfgs_valid": 3,
    "paths_enumerated": 5,
    "test_cases_generated": 5,
    "blocking_questions": 1,
    "open_questions": [ ... ]
  }
}
```

**Streaming (stream: true) — Server-Sent Events:**

```
event: progress
data: {"stage":"building_wsf"}

event: progress
data: {"stage":"wsf_built","flowCount":3,"openQuestions":1}

event: result
data: { ...full result object... }
```

---

## Supported Input Types

| Input | How to pass it |
|---|---|
| User story / spec | `text` field — plain text |
| Gherkin feature file | `text` field — auto-detected by `Feature:` / `Scenario:` prefix |
| Figma URL | `figma_url` field — `https://www.figma.com/file/...` |
| Screenshot | `screenshot_base64` field — base64-encoded PNG or JPEG |
| Mixed / combined | `text` field — LLM handles multi-format input |

---

## Understanding the Output

### Open Questions
Fields the engine could not determine from the input. Blocking questions must be resolved before test cases can be finalized.

### CFG Validation Issues
If a flow's Control Flow Graph fails structural validation after 3 retries, its paths are skipped and flagged. Review the `validation_errors` array in the response.

### Test Case Status Values

| Status | Meaning |
|---|---|
| `generated` | Test case successfully written |
| `skipped` | Path was skipped due to CFG issues |
| `generation_failed` | LLM call failed for this path |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key from console.anthropic.com |

---

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express 4
- **LLM**: Claude (Anthropic) via `@anthropic-ai/sdk`
- **Path Enumeration**: Pure DFS (no external dependencies)
