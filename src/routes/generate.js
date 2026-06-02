const express = require('express');
const { runPipeline } = require('../pipeline/index');

const router = express.Router();

/**
 * POST /generate
 *
 * Body:
 *   text              string    — user story / spec / gherkin
 *   figma_url         string?   — Figma URL (alternative to text)
 *   screenshot_base64 string?   — base64 image as primary input (alternative to text)
 *   context           object?   — {
 *                                   app_type,        // web | mobile_ios | ...
 *                                   platform_hint,   // salesforce | generic | ...
 *                                   feature_id,      // optional traceability ID
 *                                   app_screenshots  // string | string[] — base64 screenshots
 *                                                       of the APP UI (not input screenshots)
 *                                                       used to extract field names, navigation etc.
 *                                 }
 *   stream            boolean?  — SSE streaming
 */
router.post('/generate', async (req, res) => {
  const { text, figma_url, screenshot_base64, context = {}, stream = false } = req.body;

  // Primary input (what to generate tests FROM)
  const rawInput = figma_url
    ? { figma_url }
    : screenshot_base64
    ? { screenshot_base64 }
    : text;

  if (!rawInput) {
    return res.status(400).json({
      error: 'Provide at least one of: text, figma_url, screenshot_base64',
    });
  }

  // Normalize app_screenshots to array if provided as string
  if (context.app_screenshots && typeof context.app_screenshots === 'string') {
    context.app_screenshots = [context.app_screenshots];
  }

  if (stream) {
    return runPipelineStreamed(rawInput, context, res);
  }

  try {
    const result = await runPipeline(rawInput, context);
    res.json(result);
  } catch (err) {
    console.error('[generate] pipeline error:', err);
    res.status(500).json({ error: err.message, raw: err.raw || null });
  }
});

async function runPipelineStreamed(rawInput, context, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runPipeline(rawInput, context, (progress) => {
      send('progress', progress);
    });
    send('result', result);
    res.end();
  } catch (err) {
    console.error('[generate:stream] pipeline error:', err);
    send('error', { message: err.message });
    res.end();
  }
}

module.exports = router;
