const EMBEDDING_MODEL = 'gemini-embedding-2';
const EMBEDDING_DIMENSION = 768;
const MAX_TIMEOUT_MS = 20000;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;

function embeddingError() {
  const error = new Error('Material embeddings are temporarily unavailable.');
  error.code = 'EMBEDDING_FAILED';
  return error;
}

function isValidEmbedding(values) {
  return Array.isArray(values) && values.length === EMBEDDING_DIMENSION && Array.from(values).every(Number.isFinite);
}

function createRagEmbeddingService({ env = process.env, fetch: fetchAdapter = globalThis.fetch,
  timeoutMs = Number(env.RAG_REQUEST_TIMEOUT_MS) || MAX_TIMEOUT_MS } = {}) {
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;

  async function embedText(input) {
    let timer;
    try {
      const key = env.GEMINI_API_KEY;
      if (typeof key !== 'string' || !key.trim() || typeof fetchAdapter !== 'function') throw embeddingError();
      const controller = new AbortController();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(embeddingError()); }, timeout);
      });
      // The deadline includes response parsing and settles even for adapters ignoring abort.
      const operation = (async () => {
        const response = await fetchAdapter(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text: input }] }, outputDimensionality: EMBEDDING_DIMENSION }),
          signal: controller.signal
        });
        if (response?.ok !== true) throw embeddingError();
        const body = await response.json();
        if (!body || typeof body !== 'object' || Array.isArray(body) || !body.embedding
          || typeof body.embedding !== 'object' || Array.isArray(body.embedding)
          || !isValidEmbedding(body.embedding.values)) throw embeddingError();
        return [...body.embedding.values];
      })();
      return await Promise.race([operation, deadline]);
    } catch {
      // Never propagate provider errors, response bodies, source text, or credentials.
      throw embeddingError();
    } finally {
      clearTimeout(timer);
    }
  }
  async function embedDocument(input) {
    const title = input?.title;
    const text = input?.text;
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || /[\x00-\x1f\x7f]/.test(title)
      || typeof text !== 'string' || !text.trim() || text.length > 12000) throw embeddingError();
    return embedText(`title: ${title} | text: ${text}`);
  }

  async function embedQuery(question) {
    if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw embeddingError();
    return embedText(`task: question answering | query: ${question.trim()}`);
  }

  return { embedDocument, embedQuery };
}

function createRagEmbedder(config = {}, fetchImpl) {
  return createRagEmbeddingService({ ...config,
    ...(config.apiKey !== undefined ? { env: { GEMINI_API_KEY: config.apiKey } } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

module.exports = { createRagEmbeddingService, createRagEmbedder, isValidEmbedding, EMBEDDING_MODEL, EMBEDDING_DIMENSION };
