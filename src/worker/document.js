/* eslint-disable camelcase */
import 'dotenv/config';
import { Worker } from 'bullmq';
import pool from '../config/database.js';
import { emitCompleted, emitFailed, emitPendingReview, emitStatusUpdate } from '../utils/worker-emitter.js';
import { getPdfPageCount, splitPdf } from '../utils/pdf-helper.js';
import detectBoundaries from './steps/boundary-detection.js';
import { calculatePrice } from '../utils/token-pricing.js';
import extractDocument from './steps/extraction.js';
import { transformToRaw } from '../utils/raw-transformer.js';
import { FLAGSHIP_MODEL } from '../config/gemini.js';
import { webhookQueue } from '../config/queue.js';

const CONCURRENCY     = parseInt(process.env.QUEUE_CONCURRENCY);
const UPLOAD_DIR      = process.env.UPLOAD_DIR || './uploads/temp';
const DOC_CONCURRENCY = parseInt(process.env.QUEUE_DOC_CONCURRENCY);
const MAX_DOC_PAGES   = parseInt(process.env.MAX_DOC_PAGES);

const connection = {
  host:     process.env.REDIS_HOST,
  port:     parseInt(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
};

// ── DB Helpers ─────────────────────────────────────────────────────────────

const updateSourceFile = async (id, status, progress, errorMessage = null) => {
  let query, params;

  if (status === 'processing') {
    query  = `UPDATE source_files
               SET status=$1, progress=$2, error_message=$3,
                   started_at = CASE WHEN started_at IS NULL THEN now() ELSE started_at END
               WHERE id=$4`;
    params = [status, progress, errorMessage, id];
  } else if (status === 'completed' || status === 'failed') {
    query  = `UPDATE source_files
               SET status=$1, progress=$2, error_message=$3, completed_at=now()
               WHERE id=$4`;
    params = [status, progress, errorMessage, id];
  } else {
    query  = 'UPDATE source_files SET status=$1, progress=$2, error_message=$3 WHERE id=$4';
    params = [status, progress, errorMessage, id];
  }

  await pool.query(query, params);

  if (status === 'completed') emitCompleted(id);
  else if (status === 'failed') emitFailed(id, errorMessage);
  else if (status === 'pending_review') emitPendingReview(id);
  else emitStatusUpdate(id, status, progress);
};

const updateJob = (id, status, progress, errorMessage = null) => {
  if (status === 'processing') {
    return pool.query(
      `UPDATE extraction_jobs
        SET status=$1, progress=$2, error_message=$3, started_at=now()
        WHERE id=$4`,
      [status, progress, errorMessage, id]
    );
  }
  if (status === 'completed' || status === 'failed') {
    return pool.query(
      `UPDATE extraction_jobs
        SET status=$1, progress=$2, error_message=$3, completed_at=now()
        WHERE id=$4`,
      [status, progress, errorMessage, id]
    );
  }
  return pool.query(
    'UPDATE extraction_jobs SET status=$1, progress=$2, error_message=$3 WHERE id=$4',
    [status, progress, errorMessage, id]
  );
};

const findOrCreateVendor = async (name) => {
  if (!name) return null;
  const { rows } = await pool.query(
    `INSERT INTO vendors (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name]
  );
  return rows[0].id;
};

const getDocumentType = async (code) => {
  const { rows } = await pool.query(
    'SELECT id, schema_path FROM document_types WHERE code = $1 LIMIT 1', [code]
  );
  return rows.length ? rows[0] : { id: null, schema_path: 'schemas/999.json' };
};

const saveFields = async (client, resultId, fields) => {
  if (!fields.length) return;
  const values = fields.map((_, i) =>
    `($1, $${i * 2 + 2}, $${i * 2 + 3})`
  ).join(', ');
  const params = [resultId, ...fields.flatMap(({ key, value }) => [key, value ?? null])];
  await client.query(
    `INSERT INTO fields (extraction_result_id, key, value) VALUES ${values}`,
    params
  );
};

const saveItems = async (client, resultId, items) => {
  if (!items.length) return;

  const itemValues = items.map((_, i) => `($1, $${i + 2})`).join(', ');
  const itemParams = [resultId, ...items.map((item) => item.row_index)];
  const { rows: itemRows } = await client.query(
    `INSERT INTO items (extraction_result_id, row_index) VALUES ${itemValues} RETURNING id`,
    itemParams
  );

  const allColumns = items.flatMap((item, idx) =>
    (item.columns || []).map(({ key, value }) => ({
      itemId: itemRows[idx].id, key, value,
    }))
  );
  if (!allColumns.length) return;

  const colValues = allColumns.map((_, i) =>
    `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`
  ).join(', ');
  const colParams = allColumns.flatMap(({ itemId, key, value }) => [itemId, key, value ?? null]);
  await client.query(
    `INSERT INTO item_fields (item_id, key, value) VALUES ${colValues}`,
    colParams
  );
};

// ── Concurrency runner untuk dokumen ──────────────────────────────────────
const runDocWithConcurrency = async (tasks, concurrency) => {
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch    = tasks.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const total    = Math.ceil(tasks.length / concurrency);
    console.info(`[Worker] Doc batch ${batchNum}/${total} — ${batch.length} doc(s) parallel`);
    await Promise.all(batch.map((task) => task()));
  }
};

// ── Worker ─────────────────────────────────────────────────────────────────
const worker = new Worker(
  'extraction',

  async (job) => {
    if (job.name === 'retry-document') {
      return handleRetryDocument(job);
    }
    return handleProcessDocument(job);
  },

  { connection, concurrency: CONCURRENCY }
);

// ── Handler: process document (full flow) ─────────────────────────────────
const handleProcessDocument = async (job) => {
  const { sourceFileId, filePath } = job.data;
  const jobStart = Date.now();
  console.info(`[Worker] Start job ${job.id} — sourceFileId: ${sourceFileId}`);

  try {
    await updateSourceFile(sourceFileId, 'processing', 5);
    await job.updateProgress(5);

    // ── FASE 1: Cheap AI — Detect Boundaries ──────────────────────────
    console.info('[Worker] Phase 1: boundary detection...');
    const phase1Start = Date.now();
    const totalPages  = await getPdfPageCount(filePath);
    const { boundaries, usage: phase1Usage } = await detectBoundaries(filePath);
    const phase1Ms    = Date.now() - phase1Start;
    console.info(`[Timing] Phase 1: ${phase1Ms}ms`);

    const phase1Pricing = calculatePrice(
      process.env.GEMINI_CHEAP_MODEL ?? 'gemini-2.5-flash-lite',
      phase1Usage?.prompt_tokens ?? 0,
      phase1Usage?.output_tokens ?? 0,
    );

    const normalized = boundaries.map((b) => ({
      ...b,
      end_page: Math.min(b.end_page, totalPages),
    }));

    console.info(`[Worker] Boundaries: ${normalized.length} doc(s) from Phase 1`);
    await job.updateProgress(30);

    // ── Split PDF + Buat Document records ─────────────────────────────
    console.info(`[Worker] Splitting into ${normalized.length} document(s)...`);
    const splitStart = Date.now();

    for (const boundary of normalized) {
      const { doc_code, vendor, start_page, end_page, confidence, needs_review } = boundary;
      const pageCount = end_page - start_page + 1;

      const docFilePath = await splitPdf(filePath, start_page, end_page, UPLOAD_DIR);
      const vendorId    = await findOrCreateVendor(vendor);
      const docType     = await getDocumentType(doc_code);

      // Dokumen terlalu panjang → flag for review tanpa extraction
      if (pageCount > MAX_DOC_PAGES) {
        console.warn(
          `[Worker] Doc invoice=${boundary.invoice_number} has ${pageCount} pages ` +
          `— exceeds MAX_DOC_PAGES (${MAX_DOC_PAGES}), flagging for review`
        );
        await pool.query(
          `INSERT INTO documents
             (source_file_id, vendor_id, document_type_id, file_path,
              start_page, end_page, confidence, needs_review, status, invoice_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [sourceFileId, vendorId, docType.id, docFilePath,
            start_page, end_page, confidence, true,
            'pending_review', boundary.invoice_number ?? null]
        );
        continue;
      }

      const { rows: docRows } = await pool.query(
        `INSERT INTO documents
           (source_file_id, vendor_id, document_type_id, file_path,
            start_page, end_page, confidence, needs_review, status, invoice_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [sourceFileId, vendorId, docType.id, docFilePath,
          start_page, end_page, confidence, needs_review,
          needs_review ? 'pending_review' : 'queued',
          boundary.invoice_number ?? null]
      );
      const documentId = docRows[0].id;

      if (needs_review) {
        console.warn(`[Worker] Document ${documentId} flagged for review (confidence: ${confidence})`);
        continue;
      }

      await pool.query(
        'INSERT INTO extraction_jobs (document_id, status) VALUES ($1, \'queued\')',
        [documentId]
      );
    }

    const splitMs = Date.now() - splitStart;
    console.info(`[Timing] PDF split + DB insert documents: ${splitMs}ms`);

    await updateSourceFile(sourceFileId, 'processing', 50);
    await job.updateProgress(50);

    // ── FASE 2: Smart AI — Extraction per dokumen ──────────────────────
    const { rows: pendingJobs } = await pool.query(
      `SELECT ej.id AS job_id, ej.document_id,
              d.file_path, dt.schema_path, dt.code AS doc_code
       FROM extraction_jobs ej
       JOIN documents d       ON d.id  = ej.document_id
       JOIN source_files sf   ON sf.id = d.source_file_id
       LEFT JOIN document_types dt ON dt.id = d.document_type_id
       WHERE sf.id = $1 AND ej.status = 'queued'`,
      [sourceFileId]
    );

    console.info(
      `[Worker] Phase 2: extracting ${pendingJobs.length} document(s) ` +
      `— doc concurrency: ${DOC_CONCURRENCY}`
    );

    let completedCount = 0;
    const phase2Start  = Date.now();

    const docTasks = pendingJobs.map(
      ({ job_id, document_id, file_path, schema_path, doc_code }) => async () => {
        const docStart = Date.now();
        await updateJob(job_id, 'processing', 0);

        try {
          const { fields, items, parseError, usage, pricing } = await extractDocument(
            file_path,
            schema_path || 'schemas/999.json',
            doc_code    || '999'
          );

          const rawData = transformToRaw(doc_code || '999', fields, items);

          const dbStart  = Date.now();
          const client   = await pool.connect();
          try {
            await client.query('BEGIN');

            const { rows: resultRows } = await client.query(
              `INSERT INTO extraction_results
                 (extraction_job_id, ai_model,
                  prompt_tokens, output_tokens, total_tokens,
                  input_price, output_price, total_price,
                  total_pages, duration_ms, raw_data)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               RETURNING id`,
              [
                job_id,
                FLAGSHIP_MODEL,
                usage?.prompt_tokens  ?? 0,
                usage?.output_tokens  ?? 0,
                usage?.total_tokens   ?? 0,
                pricing?.input_price  ?? 0,
                pricing?.output_price ?? 0,
                pricing?.total_price  ?? 0,
                usage?.total_pages    ?? 1,
                usage?.wall_clock_ms  ?? 0,
                JSON.stringify(rawData),
              ]
            );
            const resultId = resultRows[0].id;

            await saveFields(client, resultId, fields);
            await saveItems(client, resultId, items);

            const status = parseError ? 'failed' : 'completed';
            await client.query(
              'UPDATE extraction_jobs SET status=$1, progress=100, completed_at=now() WHERE id=$2',
              [status, job_id]
            );
            await client.query(
              'UPDATE documents SET status=$1 WHERE id=$2',
              [status, document_id]
            );

            await client.query('COMMIT');

            const docMs = Date.now() - docStart;
            const dbMs  = Date.now() - dbStart;
            console.info(
              `[Timing] Doc ${document_id}: total=${docMs}ms | ai=${usage?.wall_clock_ms ?? 0}ms ` +
              `| db=${dbMs}ms | pages=${usage?.total_pages} | status=${status}`
            );
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }

        } catch (err) {
          console.error(`[Worker] Extraction failed doc ${document_id}: ${err.message}`);
          await updateJob(job_id, 'failed', 0, err.message);
          await pool.query(
            'UPDATE documents SET status=\'failed\', error_message=$1 WHERE id=$2',
            [err.message, document_id]
          );
        }

        // Update progress setelah tiap dokumen selesai
        completedCount++;
        const progress = 50 + Math.round((completedCount / pendingJobs.length) * 45);
        await updateSourceFile(sourceFileId, 'processing', progress);
        await job.updateProgress(progress);
      }
    );

    await runDocWithConcurrency(docTasks, DOC_CONCURRENCY);

    // ── Timing summary ─────────────────────────────────────────────────
    const phase2Ms = Date.now() - phase2Start;
    const totalMs  = Date.now() - jobStart;
    console.info(`[Timing] Phase 2: ${phase2Ms}ms`);
    console.info('[Timing] ─────────────────────────────────────────');
    console.info(`[Timing] Phase 1 (boundary):     ${phase1Ms}ms (${((phase1Ms/totalMs)*100).toFixed(1)}%)`);
    console.info(`[Timing] PDF split + DB docs:    ${splitMs}ms (${((splitMs/totalMs)*100).toFixed(1)}%)`);
    console.info(`[Timing] Phase 2 (extraction):   ${phase2Ms}ms (${((phase2Ms/totalMs)*100).toFixed(1)}%)`);
    console.info(`[Timing] Total job: ${totalMs}ms`);
    console.info('[Timing] ─────────────────────────────────────────');

    // ── Update pricing summary ─────────────────────────────────────────
    const { rows: jobPrices } = await pool.query(
      `SELECT COALESCE(SUM(er.total_price), 0) AS smart_total
       FROM extraction_results er
       JOIN extraction_jobs ej ON ej.id = er.extraction_job_id
       JOIN documents d        ON d.id  = ej.document_id
       WHERE d.source_file_id = $1`,
      [sourceFileId]
    );

    const smartTotalPrice = parseFloat(jobPrices[0].smart_total);
    const cheapTotalPrice = phase1Pricing.total_price;
    const grandTotal      = parseFloat((smartTotalPrice + cheapTotalPrice).toFixed(8));

    await pool.query(
      `UPDATE source_files
        SET cheap_total_price = $1, flagship_total_price = $2, total_price = $3
        WHERE id = $4`,
      [cheapTotalPrice, smartTotalPrice, grandTotal, sourceFileId]
    );

    console.info(
      `[Worker] Price summary — cheap: $${cheapTotalPrice} | ` +
      `smart: $${smartTotalPrice} | total: $${grandTotal}`
    );

    await updateSourceFile(sourceFileId, 'completed', 100);

    // ── Webhook ────────────────────────────────────────────────────────
    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl) {
      const { rows: docs } = await pool.query(
        `SELECT d.id, d.start_page, d.end_page, d.status,
                dt.code AS doc_code, dt.name AS doc_name,
                v.name  AS vendor_name
         FROM documents d
         LEFT JOIN document_types dt ON dt.id = d.document_type_id
         LEFT JOIN vendors v         ON v.id  = d.vendor_id
         WHERE d.source_file_id = $1`,
        [sourceFileId]
      );

      const { rows: deliveryRows } = await pool.query(
        `INSERT INTO webhook_deliveries (source_file_id, url, status)
         VALUES ($1, $2, 'pending') RETURNING id`,
        [sourceFileId, webhookUrl]
      );

      await webhookQueue.add('deliver-webhook', {
        deliveryId: deliveryRows[0].id,
        url:        webhookUrl,
        payload: {
          event:          'source_file.completed',
          source_file_id: sourceFileId,
          documents:      docs,
          processed_at:   new Date().toISOString(),
        },
      });

      console.info(`[Worker] Webhook enqueued for sourceFileId: ${sourceFileId}`);
    }

    await job.updateProgress(100);
    console.info(`[Worker] Job ${job.id} completed`);

    return { sourceFileId, total: normalized.length };

  } catch (err) {
    console.error(`[Worker] Fatal job ${job.id}: ${err.message}`);
    await updateSourceFile(sourceFileId, 'failed', 0, err.message);
    throw err;
  }
};

// ── Handler: retry single document ────────────────────────────────────────
const handleRetryDocument = async (job) => {
  const { jobId, documentId, filePath, schemaPath, docCode } = job.data;
  console.info(`[Worker] Retry document ${documentId} — job ${jobId}`);

  await updateJob(jobId, 'processing', 0);

  try {
    const { fields, items, parseError, usage, pricing } = await extractDocument(
      filePath,
      schemaPath || 'schemas/999.json',
      docCode    || '999'
    );

    const rawData = transformToRaw(docCode || '999', fields, items);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: resultRows } = await client.query(
        `INSERT INTO extraction_results
           (extraction_job_id, ai_model,
            prompt_tokens, output_tokens, total_tokens,
            input_price, output_price, total_price,
            total_pages, duration_ms, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          jobId,
          FLAGSHIP_MODEL,
          usage?.prompt_tokens  ?? 0,
          usage?.output_tokens  ?? 0,
          usage?.total_tokens   ?? 0,
          pricing?.input_price  ?? 0,
          pricing?.output_price ?? 0,
          pricing?.total_price  ?? 0,
          usage?.total_pages    ?? 1,
          usage?.wall_clock_ms  ?? 0,
          JSON.stringify(rawData),
        ]
      );
      const resultId = resultRows[0].id;

      await saveFields(client, resultId, fields);
      await saveItems(client, resultId, items);

      const status = parseError ? 'failed' : 'completed';
      await client.query(
        'UPDATE extraction_jobs SET status=$1, progress=100, completed_at=now() WHERE id=$2',
        [status, jobId]
      );
      await client.query(
        'UPDATE documents SET status=$1 WHERE id=$2',
        [status, documentId]
      );

      await client.query('COMMIT');
      console.info(`[Worker] Retry document ${documentId}: ${status}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    console.error(`[Worker] Retry document ${documentId} failed: ${err.message}`);
    await updateJob(jobId, 'failed', 0, err.message);
    await pool.query(
      'UPDATE documents SET status=\'failed\', error_message=$1 WHERE id=$2',
      [err.message, documentId]
    );
    throw err;
  }

  return { documentId, jobId };
};

// ── Events ─────────────────────────────────────────────────────────────────
worker.on('completed', (job, result) =>
  console.info(`Queue job ${job.id} completed — ${result?.total} docs`)
);
worker.on('failed', (job, err) =>
  console.error(`Queue job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`)
);
worker.on('error', (err) =>
  console.error(`Worker error: ${err.message}`)
);

console.info(`Document worker started — concurrency: ${CONCURRENCY}`);
