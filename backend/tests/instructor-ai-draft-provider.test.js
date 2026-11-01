const test = require('node:test');
const assert = require('node:assert/strict');
const { createGeminiRagProvider, ProviderError } = require('../services/ai/providers/gemini.provider');

const config = {
  AI_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'test-gemini-provider-key',
  GEMINI_MODEL: 'gemini-test-model'
};
const draftOutput = JSON.stringify({ title: 'Variables', items: [
  { heading: 'Introduce', content: 'Explain stored values.', citations: [] },
  { heading: 'Practice', content: 'Trace assignments.', citations: [] },
  { heading: 'Review', content: 'Use a small example.', citations: [] }
] });

test('Gemini instructor draft operation sends only bounded structured context and honors limits', async () => {
  let payload;
  const provider = createGeminiRagProvider(config, async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: draftOutput }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 80 }
    }), { status: 200 });
  });
  const result = await provider.generateInstructorDraft({
    kind: 'OUTLINE',
    focus: 'Variables',
    course: { title: 'JavaScript', description: 'Learn variables.' },
    sources: [],
    maxOutputTokens: 77,
    timeoutMs: 1200
  });
  assert.equal(result.text, draftOutput);
  assert.equal(result.usage.outputTokens, 80);
  assert.equal(payload.generationConfig.maxOutputTokens, 77);
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.match(payload.systemInstruction.parts[0].text, /untrusted data/i);
  assert.deepEqual(JSON.parse(payload.contents[0].parts[0].text).sources, []);
});

test('Gemini instructor draft operation rejects invalid kinds, oversized focus, and excess sources before fetching', async () => {
  let calls = 0;
  const provider = createGeminiRagProvider(config, async () => { calls += 1; return new Response('{}'); });
  const base = { kind: 'OUTLINE', focus: 'A topic', course: { title: 'Course' }, sources: [] };
  await assert.rejects(provider.generateInstructorDraft({ ...base, kind: 'ADMIN_ACTION' }),
    (error) => error instanceof ProviderError && error.code === 'INVALID_OUTPUT');
  await assert.rejects(provider.generateInstructorDraft({ ...base, focus: 'x'.repeat(301) }),
    (error) => error instanceof ProviderError && error.code === 'INVALID_OUTPUT');
  await assert.rejects(provider.generateInstructorDraft({ ...base, sources: Array(6).fill({}) }),
    (error) => error instanceof ProviderError && error.code === 'INVALID_OUTPUT');
  assert.equal(calls, 0);
});
