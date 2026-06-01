# Qgen — Technical Specification

**Version**: 1.0  
**Status**: In Development  
**Last Updated**: 2026-06-01

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [System Architecture](#3-system-architecture)
4. [Input Types](#4-input-types)
5. [Workflow Specification Format (WSF)](#5-workflow-specification-format-wsf)
6. [Control Flow Graph (CFG)](#6-control-flow-graph-cfg)
7. [Path Enumeration](#7-path-enumeration)
8. [Test Case Generation](#8-test-case-generation)
9. [Pipeline Orchestration](#9-pipeline-orchestration)
10. [API Contract](#10-api-contract)
11. [Prompt Design](#11-prompt-design)
12. [Error Handling](#12-error-handling)
13. [Quality Guarantees](#13-quality-guarantees)
14. [Integration Points](#14-integration-points)
15. [Future Roadmap](#15-future-roadmap)

---

## 1. Overview

Qgen is a manual test case generation engine designed for enterprise and SaaS applications. It takes natural language or visual inputs describing a feature and produces structured, human-executable manual test cases covering all conditional branches, boundary values, and negative scenarios.

### Core Problem

Direct LLM prompting for test case generation produces:
- **Incomplete branch coverage** — conditional paths are silently skipped
- **Vague expected results** — testers cannot give a clear pass/fail verdict
- **Missing negative cases** — only happy paths are covered
- **No test data rationale** — testers don't know why specific values were chosen

Qgen solves this through a structured intermediate representation (WSF → CFG) that enforces completeness before test cases are written.

### Key Principle

> **Test cases are derived from requirements, never from application code.**  
> The expected result always reflects intended behavior, not implemented behavior.

---

## 2. Goals and Non-Goals

### Goals

- Generate manual (human-executable) test cases, not automation scripts
- Cover all conditional branches in a feature workflow
- Produce specific, verifiable expected results
- Include boundary value rationale in test data
- Flag gaps and ambiguities explicitly rather than hallucinating
- Support multiple input types: text, Gherkin, Figma URLs, screenshots
- Work across app types: web, mobile, Salesforce, insurance, generic SaaS
- Integrate into existing Express.js backend via a single route

### Non-Goals

- Automated test execution
- Selenium / Playwright / Appium script generation
- Performance or load testing
- Security or penetration testing
- Test management (TestRail / Zephyr export — future roadmap)
- Figma API integration (future roadmap — current support is URL hint only)
- Screenshot vision extraction (future roadmap — current support is text extracted upstream)

---

## 3. System Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (UI)                             │
│         POST /api/generate  {text | figma_url | screenshot}     │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                      EXPRESS ROUTE                              │
│                    src/routes/generate.js                       │
│            JSON response  or  SSE stream (stream: true)         │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                   PIPELINE ORCHESTRATOR                         │
│                   src/pipeline/index.js                         │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  STEP 1 — Input Classification + WSF Building           │   │
│  │  inputRouter.js  →  wsfBuilder.js                       │   │
│  │  LLM calls: 1 (classify, if ambiguous) + 1 (WSF)        │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │  WSF JSON                        │
│  ┌──────────────────────────▼──────────────────────────────┐   │
│  │  STEP 2 — CFG Generation + Path Enumeration             │   │
│  │  cfgGenerator.js  →  cfgValidator.js  →  pathEnum...js  │   │
│  │  LLM calls: 1–3 per flow (generation + retries)         │   │
│  │  Pure code: structural validation + DFS path enum        │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │  Paths[]                         │
│  ┌──────────────────────────▼──────────────────────────────┐   │
│  │  STEP 3 — Test Case Generation                          │   │
│  │  testCaseGenerator.js                                   │   │
│  │  LLM calls: 1 per path (batched, 5 concurrent)          │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │  TestCase[]                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Pipeline Result   │
                    │  wsf, cfgs, paths,  │
                    │  test_cases, summary│
                    └─────────────────────┘
```

### LLM Call Budget Per Request

| Step | LLM Calls | Notes |
|---|---|---|
| Input classification | 0–1 | Skipped if rule-based detection succeeds |
| WSF extraction | 1 | Always |
| CFG generation | 1–3 per flow | Retries with validation errors fed back |
| TC generation | 1 per path | Batched 5 concurrent |
| **Total (typical)** | **~2 + (flows × 1.2) + paths** | Example: 3 flows, 6 paths = ~11 calls |

---

## 4. Input Types

### 4.1 Detection Logic (`inputRouter.js`)

Detection is rule-based first, LLM fallback only for ambiguous text:

```
1. Object with figma_url field      → figma_url     (no LLM)
2. Object with screenshot_base64    → screenshot     (no LLM)
3. Text matches /Feature:|Scenario:|Given |When |Then /  → gherkin (no LLM)
4. Text matches Figma URL pattern   → figma_url     (no LLM)
5. Otherwise                        → LLM classify  → user_story | spec | mixed
```

### 4.2 Supported Input Types

| Type | Key | Description |
|---|---|---|
| `user_story` | text | "As a [role], I want to [action] so that [outcome]" format with acceptance criteria |
| `gherkin` | text | Feature/Scenario/Given/When/Then format |
| `spec` | text | Functional spec, PRD, or requirements document |
| `mixed` | text | Combination of above in one input |
| `figma_url` | figma_url | Figma file URL — treated as a hint; URL passed through to WSF for human resolution |
| `screenshot_base64` | screenshot_base64 | Base64 image — upstream must extract text before pipeline; stored as extracted_text |

### 4.3 Context Hints

Optional `context` object passed alongside input:

| Field | Values | Effect |
|---|---|---|
| `app_type` | `web`, `mobile_ios`, `mobile_android`, `desktop`, `api` | Informs node types in CFG (gesture vs click), WSF structure |
| `platform_hint` | `salesforce`, `servicenow`, `sap`, `insurance`, `generic` | Informs LLM of platform-specific patterns (Lightning components, SAP transactions, etc.) |
| `feature_id` | string | Injected into WSF as-is; used for traceability |

---

## 5. Workflow Specification Format (WSF)

WSF is the canonical internal representation. Every input is normalized to WSF before the CFG engine runs.

### 5.1 Full Schema

```json
{
  "wsf_version": "1.0",
  "feature_id": "FEAT-001",
  "feature_name": "string",
  "source": ["user_story | gherkin | figma | screenshot | spec | manual"],
  "app_context": {
    "app_type": "web | mobile_ios | mobile_android | desktop | api",
    "platform_hint": "salesforce | servicenow | sap | insurance | generic"
  },
  "actors": [
    {
      "id": "string",
      "name": "string",
      "permissions": ["string"],
      "cannot": ["string"]
    }
  ],
  "preconditions": [
    {
      "id": "string",
      "description": "string",
      "entity": "string",
      "attribute": "string (optional)",
      "state": "string",
      "confidence": "high | medium | low",
      "note": "string (optional)"
    }
  ],
  "flows": [
    {
      "flow_id": "flow_001",
      "flow_name": "string",
      "actor": "actor_id",
      "trigger": "string",
      "tags": ["happy_path | alternate_path | negative | edge_case | admin"],
      "steps": [
        {
          "step_id": "s01",
          "action": "navigate | click | enter | select | upload | verify | wait | scroll | gesture | api_call",
          "description": "string",
          "target": "string (optional)",
          "field": "string (optional)",
          "input_type": "text | numeric | date | dropdown | checkbox | radio | file | toggle | multiselect | textarea (optional)",
          "test_data_ref": "ref_id (optional)",
          "expected_reaction": "string",
          "business_rule_ref": "rule_id (optional)",
          "postcondition_refs": ["string"],
          "confidence": "high | medium | low",
          "note": "string (optional)",
          "branches": [
            {
              "condition": "string",
              "outcome": "success | validation_error | system_error | redirect | permission_denied | timeout",
              "next_step": "step_id"
            }
          ]
        }
      ]
    }
  ],
  "business_rules": [
    {
      "rule_id": "br_001",
      "description": "string",
      "condition": "string",
      "effect": "string",
      "source": "user_story | gherkin | figma | screenshot | spec | inferred",
      "confidence": "high | medium | low",
      "note": "string (optional)"
    }
  ],
  "data_entities": [
    {
      "ref_id": "string",
      "entity": "string",
      "state": "string (optional)",
      "value_class": "valid | invalid | boundary_min | boundary_max | boundary_zero | above_threshold | below_threshold | empty | special_chars | max_length",
      "suggested_value": "string",
      "why": "string"
    }
  ],
  "open_questions": [
    {
      "oq_id": "string",
      "related_to": "string",
      "question": "string",
      "impact": "string",
      "blocking": true
    }
  ]
}
```

### 5.2 WSF Confidence Model

Every field that is LLM-inferred carries a `confidence` value:

| Level | Meaning | Source |
|---|---|---|
| `high` | Explicitly stated in the input | Direct extraction |
| `medium` | Clearly implied by context | Inference with supporting evidence |
| `low` | Guessed — should be reviewed | Assumption with no evidence |

Low-confidence fields automatically generate an `open_question` entry.

### 5.3 WSF Minimum Validity

A WSF is considered minimally valid if:
- `flows` array is non-empty
- Every flow has at least one step
- Every step has `step_id`, `action`, `description`, `expected_reaction`

WSFs failing minimum validity throw an error and halt the pipeline.

---

## 6. Control Flow Graph (CFG)

### 6.1 CFG Schema

```json
{
  "cfg_id": "cfg_flow_001",
  "wsf_flow_ref": "flow_001",
  "status": "valid | validation_failed | parse_failed",
  "validation_errors": ["string"],
  "nodes": [
    {
      "node_id": "string",
      "type": "START | ACTION | VERIFY | DECISION | END",
      "label": "string",
      "expected_reaction": "string (optional)",
      "test_data_ref": "string (optional)",
      "business_rule_ref": "string (optional)",
      "confidence": "high | medium | low (optional)",
      "outcome": "string (optional, END nodes only)"
    }
  ],
  "edges": [
    {
      "from": "node_id",
      "to": "node_id",
      "condition": "string (optional, DECISION edges only)",
      "outcome": "string (optional, DECISION edges only)"
    }
  ]
}
```

### 6.2 Node Type Rules

| Type | Incoming Edges | Outgoing Edges | Description |
|---|---|---|---|
| `START` | 0 | exactly 1 | Entry point of the flow |
| `ACTION` | ≥ 1 | exactly 1 | User action: navigate, click, enter, select, etc. |
| `VERIFY` | ≥ 1 | exactly 1 | Assertion step — verifies system state |
| `DECISION` | ≥ 1 | ≥ 2 | Branch point — maps to WSF steps with `branches[]` |
| `END` | ≥ 1 | 0 | Terminal outcome node |

### 6.3 CFG Structural Validation (9 Rules)

Validation is pure code — no LLM involved. Runs after every generation attempt.

| Rule | Check |
|---|---|
| R1 | Exactly one START node |
| R2 | At least one END node |
| R3 | All edge `from`/`to` values reference existing `node_id`s |
| R4 | Every non-END node has at least one outgoing edge |
| R5 | Every non-START node has at least one incoming edge (no orphans) |
| R6 | DECISION nodes have ≥ 2 outgoing edges |
| R7 | ACTION and VERIFY nodes have exactly 1 outgoing edge |
| R8 | All nodes reachable from START (BFS forward) |
| R9 | All nodes have a path to at least one END (BFS reverse) |

### 6.4 CFG Generation Retry Strategy

```
Attempt 1: Generate CFG from WSF flow
  → Validate
  → If valid: proceed
  → If invalid: collect all errors

Attempt 2: Regenerate with errors appended to prompt + previous CFG shown
  → Validate
  → If valid: proceed
  → If invalid: collect all errors

Attempt 3: Regenerate again with updated errors
  → Validate
  → If valid: proceed
  → If invalid: mark status = "validation_failed", attach errors, skip paths for this flow

All flows are processed in parallel (Promise.all).
```

---

## 7. Path Enumeration

### 7.1 Algorithm

Depth-First Search (DFS) from `START` to all `END` nodes. Pure JavaScript — no LLM.

**Parameters:**
- `MAX_DEPTH = 25` — maximum steps per path before truncation
- `MAX_NODE_VISITS = 2` — maximum times a node may be visited per path (handles retry loops)

**Cycle handling:** A node visited `MAX_NODE_VISITS` times in the current path causes DFS to backtrack. This prevents infinite loops on flows with retry logic while still allowing one retry iteration to be captured.

**Truncated paths:** Paths exceeding `MAX_DEPTH` are not dropped — they are recorded with status `truncated` and flagged in the summary for human review.

### 7.2 Path Object

```json
{
  "path_id": "PATH-001",
  "cfg_ref": "cfg_flow_001",
  "wsf_flow_ref": "flow_001",
  "status": "enumerated | skipped | truncated",
  "nodes": ["START", "s01", "s02", "s04", "s05_success", "END_success"],
  "node_details": [{ ...node objects... }],
  "active_conditions": [
    { "condition": "All fields valid", "outcome": "success", "at_node": "s04" }
  ],
  "condition_summary": "All fields valid",
  "terminal_outcome": "success",
  "data_refs": ["data_vendor_active", "data_amount_below_threshold"],
  "business_rule_refs": ["br_002"],
  "confidence": "high"
}
```

**Path confidence** = minimum confidence level across all nodes in the path.

### 7.3 Path Naming Convention

| Path ID format | `PATH-{zero-padded 3-digit index}` |
|---|---|
| Example | `PATH-001`, `PATH-012` |
| Scope | Global across all flows in one pipeline run |

---

## 8. Test Case Generation

### 8.1 Input to LLM Per Test Case

Each LLM call for test case generation receives:
- `tc_id` — pre-assigned identifier
- Feature name and feature ID from WSF
- App type and platform hint
- Scenario description (from path `condition_summary`)
- Terminal outcome
- WSF preconditions (full list)
- WSF actors
- Ordered step nodes from the path (excluding START/END)
- Active branch conditions for this path
- Relevant business rules (filtered to `business_rule_refs` in path)
- Relevant data entities (filtered to `data_refs` in path)

### 8.2 Test Case Output Format

```
ID: TC-001
Title: <specific scenario title>

Preconditions:
  - <item>

Steps:
  1. <imperative action>
     → <expected result for this step>
  2. ...

Final Expected Result:
  - <specific verifiable outcome>
  - <what should NOT happen, if applicable>

Test Data:
  - <field>: <value> (<rationale for this value>)

Linked Requirement: <feature_id>
Scenario Type: happy_path | negative | edge_case | alternate_path
```

### 8.3 Structured Parsed Fields

After generation, the plain text is parsed into structured fields for downstream export:

| Field | Description |
|---|---|
| `tc_id` | Test case identifier |
| `title` | Test case title |
| `preconditions` | Precondition block as string |
| `steps` | Array of step strings |
| `final_expected_result` | Final expected result block |
| `test_data` | Test data block |
| `linked_requirement` | Feature ID |
| `scenario_type` | happy_path / negative / edge_case / alternate_path |

### 8.4 Batch Processing

Test cases are generated `batchSize` (default: 5) at a time using `Promise.all` to stay within API rate limits while maximising throughput.

### 8.5 Quality Rules Enforced by Prompt

The TC generation system prompt enforces:
1. Expected results must be **specific** — no "system works correctly"
2. Steps must be **atomic** — one user action per step
3. Steps use **imperative voice** — "Click", "Enter", "Navigate to"
4. Exact values included where known — "Enter Amount: $9,999"
5. Final expected result must include **what should NOT happen** where relevant
6. Test data entries include **why that value was chosen**

---

## 9. Pipeline Orchestration

### 9.1 `runPipeline(rawInput, context, onProgress)`

Entry point exposed by `src/pipeline/index.js`.

**Parameters:**

| Param | Type | Description |
|---|---|---|
| `rawInput` | `string \| object` | Raw user input — text, `{figma_url}`, `{screenshot_base64}` |
| `context` | `object` | Optional: `{ app_type, platform_hint, feature_id }` |
| `onProgress` | `function` | Optional callback: `({ stage, ...detail }) => void` |

**Returns:** Promise resolving to pipeline result object (see §10.2).

### 9.2 Progress Stages

| Stage | Emitted When |
|---|---|
| `classifying_input` | Before input classification starts |
| `input_classified` | After classification: `{ inputType, classifyConfidence }` |
| `building_wsf` | Before WSF extraction |
| `wsf_built` | After WSF: `{ featureId, flowCount, openQuestions, blockingQuestions }` |
| `blocking_questions_found` | If blocking open questions exist: `{ questions }` |
| `generating_cfgs` | Before CFG generation starts |
| `cfgs_generated` | After all CFGs: `{ total, valid, invalid, issues }` |
| `enumerating_paths` | Before path enumeration |
| `paths_enumerated` | After enumeration: `{ total, enumerated, skipped, truncated }` |
| `generating_test_cases` | Before TC generation starts |
| `complete` | After all TCs: `{ total, generated, failed, skipped }` |

---

## 10. API Contract

### 10.1 Request

**Endpoint:** `POST /api/generate`  
**Content-Type:** `application/json`

```json
{
  "text": "string (user story / Gherkin / spec)",
  "figma_url": "string (optional, alternative to text)",
  "screenshot_base64": "string (optional, alternative to text)",
  "context": {
    "app_type": "web | mobile_ios | mobile_android | desktop | api",
    "platform_hint": "salesforce | servicenow | sap | insurance | generic",
    "feature_id": "string"
  },
  "stream": false
}
```

Exactly one of `text`, `figma_url`, or `screenshot_base64` must be present.

### 10.2 Response (stream: false)

```json
{
  "wsf": { ...WSF object... },
  "cfgs": [ ...CFG objects... ],
  "paths": [ ...path objects... ],
  "test_cases": [
    {
      "tc_id": "TC-001",
      "path_id": "PATH-001",
      "wsf_flow_ref": "flow_001",
      "terminal_outcome": "success",
      "confidence": "high",
      "status": "generated | generation_failed | skipped",
      "text": "ID: TC-001\nTitle: ...",
      "structured": {
        "tc_id": "TC-001",
        "title": "string",
        "preconditions": "string",
        "steps": ["string"],
        "final_expected_result": "string",
        "test_data": "string",
        "linked_requirement": "string",
        "scenario_type": "string"
      }
    }
  ],
  "summary": {
    "feature_id": "string",
    "feature_name": "string",
    "input_type": "string",
    "flows_processed": 3,
    "cfgs_valid": 3,
    "paths_enumerated": 5,
    "test_cases_generated": 5,
    "test_cases_failed": 0,
    "test_cases_skipped": 0,
    "blocking_questions": 1,
    "open_questions": [ ...open question objects... ]
  }
}
```

### 10.3 Response (stream: true) — Server-Sent Events

```
event: progress
data: {"stage":"building_wsf"}

event: progress
data: {"stage":"wsf_built","featureId":"FEAT-001","flowCount":3}

event: result
data: { ...full result object same as stream:false... }
```

On error:
```
event: error
data: {"message":"Pipeline failed: WSF must contain at least one flow"}
```

### 10.4 Error Responses

| HTTP Status | Condition |
|---|---|
| `400` | Missing input (no text/figma_url/screenshot_base64) |
| `500` | Pipeline failure (WSF parse error, unrecoverable CFG failure) |

---

## 11. Prompt Design

### 11.1 WSF Extraction Prompt (`wsf_extraction.txt`)

**Role:** QA architect extracting structured specification from natural language.

**Key constraints in prompt:**
- Extract only what is stated or clearly implied — never invent
- Use `open_questions` for anything uncertain
- `confidence` levels are mandatory on every field
- `blocking: true` on open questions that would prevent test generation
- All enum values for `action`, `outcome`, `input_type`, `value_class` are listed explicitly to prevent hallucination

**Output:** WSF JSON only. No explanation, no markdown fences.

### 11.2 CFG Generation Prompt (`cfg_generation.txt`)

**Role:** QA architect converting a WSF flow to a Control Flow Graph.

**Key constraints in prompt:**
- `node_id` must match WSF `step_id` exactly
- Node types are strict: START/ACTION/VERIFY/DECISION/END only
- DECISION nodes require ≥ 2 outgoing edges
- ACTION/VERIFY nodes require exactly 1 outgoing edge
- Carry `confidence`, `test_data_ref`, `expected_reaction`, `business_rule_ref` from WSF step into node
- Retry prompt includes the full list of validation errors and the previous CFG for correction reference

**Output:** CFG JSON only. No explanation, no markdown fences.

### 11.3 Test Case Generation Prompt (`tc_generation.txt`)

**Role:** QA engineer writing manual test cases for human testers.

**Key constraints in prompt:**
- Quality bar: tester must be able to execute without asking any clarifying questions
- Expected results must be specific — no vague phrases like "system works correctly"
- One step = one meaningful user action
- Imperative voice: Click, Enter, Select, Navigate to
- Include what should NOT happen where applicable
- Test data entries include the reason why that value was chosen

**Output:** Plain structured text in the defined format. No JSON, no markdown.

---

## 12. Error Handling

### 12.1 Error Taxonomy

| Error Type | Where | Recovery |
|---|---|---|
| `InputMissingError` | Route layer | 400 response, no pipeline starts |
| `ClassificationError` | inputRouter | Default to `user_story`, log, continue |
| `WSFParseError` | wsfBuilder | Expose `raw` field in 500 response for debugging |
| `WSFMinimumValidityError` | wsfBuilder | 500 — pipeline cannot proceed without flows |
| `CFGParseError` | cfgGenerator | Retry up to 3 times, then mark flow as `parse_failed` |
| `CFGValidationError` | cfgValidator | Retry with errors fed back, then mark as `validation_failed` |
| `PathTruncation` | pathEnumerator | Flag path as `truncated`, include in output, do not drop |
| `TCGenerationError` | testCaseGenerator | Mark TC as `generation_failed`, continue with remaining paths |

### 12.2 Fail-Safe Principle

The pipeline never silently drops work. Every failure is:
1. Recorded with a status field (`parse_failed`, `validation_failed`, `generation_failed`, `skipped`, `truncated`)
2. Included in the response with an `error` or `reason` field
3. Counted in the `summary` object

### 12.3 Blocking vs Non-Blocking Open Questions

| Type | Behavior |
|---|---|
| `blocking: true` | Emitted as `blocking_questions_found` progress event. Pipeline continues — caller decides whether to halt. |
| `blocking: false` | Included in `open_questions` in summary only. |

---

## 13. Quality Guarantees

### 13.1 Coverage Guarantee

For every valid CFG, every root-to-END path is enumerated. No path is silently dropped. This means:
- Every branch condition in the feature generates at least one test case
- Every terminal outcome (success, validation_error, etc.) has at least one test case

### 13.2 Non-Hallucination Guarantee

The WSF prompt explicitly instructs the LLM to add `open_questions` rather than guess. Business rules, threshold values, and validation messages not present in the input will appear as open questions, not as invented assertions in test cases.

### 13.3 Structural Correctness Guarantee

Every CFG that reaches the path enumerator has passed all 9 structural validation rules. Path enumeration on a valid CFG is deterministic and complete by construction.

### 13.4 Traceability Guarantee

Every generated test case carries:
- `path_id` → which CFG path it covers
- `wsf_flow_ref` → which WSF flow
- `linked_requirement` → original feature ID

This enables full traceability from requirement to test case.

---

## 14. Integration Points

### 14.1 Plugging Into Existing Express App

```js
const generateRoute = require('./src/routes/generate');
app.use('/api', generateRoute);
```

### 14.2 Using the Pipeline Directly (No HTTP)

```js
const { runPipeline } = require('./src/pipeline/index');

const result = await runPipeline(
  "As a user, I want to...",
  { app_type: 'web', platform_hint: 'generic' },
  (progress) => console.log(progress)
);
```

### 14.3 Planned Export Integrations (Roadmap)

| Target | Method |
|---|---|
| TestRail | REST API — POST /index.php?/api/v2/add_case |
| Zephyr (Jira) | REST API — POST /rest/zephyr/1.0/testcase |
| Azure DevOps | REST API — PATCH /wit/workitems/$Test Case |
| Excel / CSV | `structured` field serialized to rows |
| JSON export | Full `test_cases[]` array |

---

## 15. Future Roadmap

### Phase 2 — Input Expansion
- **Figma API integration**: connect via Figma REST API, extract frames + prototype connections automatically into WSF (no manual URL pasting)
- **Screenshot vision**: pass `screenshot_base64` directly to Claude vision model; extract UI elements, fields, and states into partial WSF
- **HAR file import**: extract API calls from a recorded browser session to infer workflow steps

### Phase 3 — Test Suite Intelligence
- **Semantic deduplication**: embed generated test cases, flag cosine similarity > 0.92 as near-duplicates before finalizing
- **Combinatorial expansion**: pairwise parameter covering arrays across data dimensions per path
- **Negative case injection**: automatic negative test case for every DECISION node guard condition

### Phase 4 — Export and Management
- TestRail, Zephyr, Azure DevOps direct export
- Traceability matrix export (requirement ↔ test case)
- Change impact — re-generate only affected paths when requirement changes

### Phase 5 — Platform Adapters
- Salesforce-specific: Lightning component awareness, Salesforce object model, permission set testing
- Mobile-specific: gesture node types, deep link preconditions, permission prompt handling
- Insurance/legacy: iframe context, PDF generation verification, multi-tab flows

---

## Appendix A — File Reference

| File | Role | LLM |
|---|---|---|
| `src/pipeline/index.js` | Orchestrator | No |
| `src/pipeline/inputRouter.js` | Input classification | Optional (fallback only) |
| `src/pipeline/wsfBuilder.js` | WSF extraction | Yes |
| `src/pipeline/cfgGenerator.js` | CFG generation + retry | Yes |
| `src/pipeline/pathEnumerator.js` | DFS path enumeration | No |
| `src/pipeline/testCaseGenerator.js` | Test case writing | Yes |
| `src/validators/cfgValidator.js` | Structural graph validation | No |
| `src/prompts/wsf_extraction.txt` | WSF system prompt | — |
| `src/prompts/cfg_generation.txt` | CFG system prompt | — |
| `src/prompts/tc_generation.txt` | TC system prompt | — |
| `src/routes/generate.js` | Express route + SSE | No |
| `test_pipeline.js` | End-to-end test script | — |

## Appendix B — Enum Reference

**action:** `navigate`, `click`, `enter`, `select`, `upload`, `verify`, `wait`, `scroll`, `gesture`, `api_call`

**outcome:** `success`, `validation_error`, `system_error`, `redirect`, `permission_denied`, `timeout`

**input_type:** `text`, `numeric`, `date`, `dropdown`, `checkbox`, `radio`, `file`, `toggle`, `multiselect`, `textarea`

**value_class:** `valid`, `invalid`, `boundary_min`, `boundary_max`, `boundary_zero`, `above_threshold`, `below_threshold`, `empty`, `special_chars`, `max_length`

**flow tags:** `happy_path`, `alternate_path`, `negative`, `edge_case`, `admin`

**node types:** `START`, `ACTION`, `VERIFY`, `DECISION`, `END`

**app_type:** `web`, `mobile_ios`, `mobile_android`, `desktop`, `api`

**platform_hint:** `salesforce`, `servicenow`, `sap`, `insurance`, `generic`

**confidence:** `high`, `medium`, `low`

**TC status:** `generated`, `generation_failed`, `skipped`

**CFG status:** `valid`, `validation_failed`, `parse_failed`

**path status:** `enumerated`, `skipped`, `truncated`
