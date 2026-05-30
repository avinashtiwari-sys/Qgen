const express = require('express');
const { runPipeline } = require('../pipeline/index');

const router = express.Router();

/**
 * POST /generate
 *
 * Body:
 *   text            string   — user story / spec / gherkin (plain text input)
 *   figma_url       string?  — Figma file/proto URL (alternative to text)
 *   screenshot_base64 string? — base64 image (alternative to text)
 *   context         object?  — { app_type, platform_hint, feature_id }
 *   stream          boolean? — if true, sends progress events as SSE
 */
router.post('/generate', async (req, res) => {
  const { text, figma_url, screenshot_base64, context = {}, stream = false } = req.body;

  const rawInput = figma_url
    ? { figma_url }
    : screenshot_base64
    ? { screenshot_base64 }
    : text;

  if (!rawInput) {
    return res.status(400).json({ error: 'Provide text, figma_url, or screenshot_base64' });
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

/**
 * Streams pipeline progress as Server-Sent Events.
 * UI can listen and show live stage updates.
 */
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
