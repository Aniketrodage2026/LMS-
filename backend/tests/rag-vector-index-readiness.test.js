const test = require('node:test');
const assert = require('node:assert/strict');
const { configurationIssue, vectorIndexIssue } = require('../scripts/verify-rag-vector-index');

const validEnvironment = {
  DB_URL: 'mongodb://localhost/test',
  AI_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'AQ.test-key',
  GEMINI_MODEL: 'gemini-2.5-flash',
  R2_ENABLED: 'true',
  R2_ACCOUNT_ID: 'a'.repeat(32),
  R2_BUCKET_NAME: 'private-test-bucket',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret-key',
  GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2',
  RAG_EMBEDDING_DIMENSION: '768',
  RAG_MAX_PDF_BYTES: '10485760',
  RAG_MAX_PDF_PAGES: '100',
  RAG_DAILY_REQUEST_LIMIT: '10',
  RAG_REQUEST_TIMEOUT_MS: '20000',
  ATLAS_VECTOR_INDEX: 'course_material_chunks_vector'
};

function validIndex(overrides = {}) {
  return {
    name: 'course_material_chunks_vector',
    type: 'vectorSearch',
    status: 'READY',
    queryable: true,
    latestDefinition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: 768, similarity: 'cosine' },
        ...['course', 'material', 'lecture', 'embeddingModel', 'embeddingDimension']
          .map((path) => ({ type: 'filter', path }))
      ]
    },
    ...overrides
  };
}

test('RAG readiness accepts the documented backend configuration and Atlas index', () => {
  assert.equal(configurationIssue(validEnvironment), null);
  assert.equal(vectorIndexIssue(validIndex()), null);
});

test('RAG readiness rejects missing or invalid configuration without exposing values', () => {
  const invalid = [
    { ...validEnvironment, DB_URL: '' },
    { ...validEnvironment, GEMINI_EMBEDDING_MODEL: 'another-model' },
    { ...validEnvironment, RAG_EMBEDDING_DIMENSION: '1536' },
    { ...validEnvironment, RAG_DAILY_REQUEST_LIMIT: '0' },
    { ...validEnvironment, R2_ENABLED: 'false' }
  ];

  for (const env of invalid) {
    const issue = configurationIssue(env);
    assert.equal(typeof issue, 'string');
    assert.equal(JSON.stringify({ issue }).includes(env.GEMINI_API_KEY), false);
    assert.equal(JSON.stringify({ issue }).includes(env.R2_SECRET_ACCESS_KEY), false);
  }
});

test('RAG readiness rejects missing, non-ready, wrong-dimension, or incomplete Atlas indexes', () => {
  assert.equal(vectorIndexIssue(null), 'VECTOR_INDEX_MISSING');
  assert.equal(vectorIndexIssue(validIndex({ status: 'BUILDING' })), 'VECTOR_INDEX_NOT_READY');
  assert.equal(vectorIndexIssue(validIndex({
    latestDefinition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine' }] }
  })), 'VECTOR_INDEX_INVALID');
  assert.equal(vectorIndexIssue(validIndex({
    latestDefinition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 768, similarity: 'cosine' }] }
  })), 'VECTOR_INDEX_INVALID');
});
