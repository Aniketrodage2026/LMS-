const mongoose = require('mongoose');
const Chunk = require('../models/course-material-chunk.schema');
const { isGeminiApiKey } = require('../services/ai/providers/gemini.provider');

const EMBEDDING_MODEL = 'gemini-embedding-2';
const EMBEDDING_DIMENSION = 768;
const DEFAULT_INDEX_NAME = 'course_material_chunks_vector';
const REQUIRED_FILTERS = ['course', 'material', 'lecture', 'embeddingModel', 'embeddingDimension'];

function configurationIssue(env) {
  if (!env.DB_URL) return 'DATABASE_CONFIG_MISSING';
  if (env.AI_PROVIDER !== 'gemini'
    || !isGeminiApiKey(env.GEMINI_API_KEY)
    || typeof env.GEMINI_MODEL !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(env.GEMINI_MODEL)) {
    return 'GEMINI_CONFIG_INVALID';
  }
  if (env.R2_ENABLED !== 'true'
    || !/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID || '')
    || !env.R2_BUCKET_NAME
    || !env.R2_ACCESS_KEY_ID
    || !env.R2_SECRET_ACCESS_KEY) {
    return 'PRIVATE_R2_CONFIG_MISSING';
  }

  const indexName = env.ATLAS_VECTOR_INDEX === undefined ? DEFAULT_INDEX_NAME : env.ATLAS_VECTOR_INDEX;
  const integerSettings = [
    [env.RAG_EMBEDDING_DIMENSION, EMBEDDING_DIMENSION],
    [env.RAG_MAX_PDF_BYTES, 10485760],
    [env.RAG_MAX_PDF_PAGES, 100]
  ];
  if (env.GEMINI_EMBEDDING_MODEL !== undefined && env.GEMINI_EMBEDDING_MODEL !== EMBEDDING_MODEL
    || integerSettings.some(([actual, expected]) => actual !== undefined && String(actual) !== String(expected))
    || !/^[A-Za-z0-9_-]{1,120}$/.test(indexName)
    || !validInteger(env.RAG_DAILY_REQUEST_LIMIT, 10, 1, 100)
    || !validInteger(env.RAG_REQUEST_TIMEOUT_MS, 20000, 1000, 30000)) {
    return 'RAG_CONFIG_INVALID';
  }
  return null;
}

function validInteger(value, defaultValue, min, max) {
  const chosen = value === undefined ? defaultValue : value;
  return /^[0-9]+$/.test(String(chosen))
    && Number.isSafeInteger(Number(chosen))
    && Number(chosen) >= min
    && Number(chosen) <= max;
}

function vectorIndexIssue(index, expectedName = DEFAULT_INDEX_NAME) {
  if (!index || index.name !== expectedName) return 'VECTOR_INDEX_MISSING';
  if (index.status !== 'READY' || index.queryable !== true) return 'VECTOR_INDEX_NOT_READY';
  if (index.type !== 'vectorSearch') return 'VECTOR_INDEX_INVALID';

  const definition = index.latestDefinition || index.definition;
  const fields = definition?.fields;
  if (!Array.isArray(fields)) return 'VECTOR_INDEX_INVALID';

  const vector = fields.find((field) => field.path === 'embedding');
  if (!vector || vector.type !== 'vector' || vector.numDimensions !== EMBEDDING_DIMENSION
    || vector.similarity !== 'cosine') return 'VECTOR_INDEX_INVALID';

  const filterPaths = new Set(fields
    .filter((field) => field.type === 'filter')
    .map((field) => field.path));
  if (REQUIRED_FILTERS.some((path) => !filterPaths.has(path))) return 'VECTOR_INDEX_INVALID';
  return null;
}

async function verifyVectorIndex({ env = process.env, mongooseInstance = mongoose } = {}) {
  const configError = configurationIssue(env);
  if (configError) return { ready: false, reason: configError };

  const indexName = env.ATLAS_VECTOR_INDEX === undefined ? DEFAULT_INDEX_NAME : env.ATLAS_VECTOR_INDEX;
  try {
    await mongooseInstance.connect(env.DB_URL, { serverSelectionTimeoutMS: 10000 });
    const collection = mongooseInstance.connection.db.collection(Chunk.collection.name);
    const indexes = await collection.listSearchIndexes(indexName).toArray();
    const issue = vectorIndexIssue(indexes[0], indexName);
    return issue ? { ready: false, reason: issue } : { ready: true, reason: 'READY' };
  } catch {
    return { ready: false, reason: 'VECTOR_INDEX_UNAVAILABLE' };
  } finally {
    if (mongooseInstance.connection.readyState !== 0) {
      await mongooseInstance.disconnect().catch(() => {});
    }
  }
}

async function main() {
  if (!process.argv.includes('--check')) {
    process.stdout.write(`${JSON.stringify({ ready: false, reason: 'USAGE' })}\n`);
    process.exitCode = 2;
    return;
  }

  require('dotenv').config({ quiet: true });
  const result = await verifyVectorIndex();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ready ? 0 : 1;
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ ready: false, reason: 'VECTOR_INDEX_UNAVAILABLE' })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { configurationIssue, vectorIndexIssue, verifyVectorIndex };
