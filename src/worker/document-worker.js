/* eslint-disable camelcase */
import 'dotenv/config';
import { Worker } from 'bullmq';
import pool from '../config/database.js';
import { getPdfPageCount, splitPdf } from '../utils/pdf-helper.js';
import detectBoundaries from './steps/phase-1-boundary-detection.js';
import extractDocument from './steps/phase-2-extraction.js';

const CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY || '3');
const UPLOAD_DIR  = process.env.UPLOAD_DIR || './uploads/temp';

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
};

// ── Helpers DB ─────────────────────────────────────────────────────────────
const updateSourceFile = (id, status, progress, errorMessage = null) =>
  pool.query(
    'UPDATE source_files SET status=$1, progress=$2, error_message=$3 WHERE id=$4',
    [status, progress, errorMessage, id]
  );

const updateJob = (id, status, progress, errorMessage = null) =>
  pool.query(
    'UPDATE extraction_jobs SET status=$1, progress=$2, error_message=$3 WHERE id=$4',
    [status, progress, errorMessage, id]
  );

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
  for (const { key, value } of fields) {
    await client.query(
      'INSERT INTO fields (extraction_result_id, key, value) VALUES ($1, $2, $3)',
      [resultId, key, value ?? null]
    );
  }
};

const saveItems = async (client, resultId, items) => {
  for (const item of items) {
    const { rows } = await client.query(
      'INSERT INTO items (extraction_result_id, row_index) VALUES ($1, $2) RETURNING id',
      [resultId, item.row_index]
    );
    const itemId = rows[0].id;
    for (const { key, value } of (item.columns || [])) {
      await client.query(
        'INSERT INTO item_fields (item_id, key, value) VALUES ($1, $2, $3)',
        [itemId, key, value ?? null]
      );
    }
  }
};

// ── Worker ─────────────────────────────────────────────────────────────────
const worker = new Worker(
  'extraction',

  async (job) => {
    const { sourceFileId, filePath } = job.data;
    console.info(`[Worker] Start job ${job.id} — sourceFileId: ${sourceFileId}`);

    try {
      await updateSourceFile(sourceFileId, 'processing', 5);
      await job.updateProgress(5);

      // ── FASE 1: Cheap AI — Detect Boundaries ───────────────────────────
      console.info('[Worker] Phase 1: boundary detection...');
      const totalPages = await getPdfPageCount(filePath);
      const boundaries = await detectBoundaries(filePath);

      const normalized = boundaries.map((b) => ({
        ...b,
        end_page: Math.min(b.end_page, totalPages),
      }));

      await job.updateProgress(30);

      // ── Split PDF + Buat Document records ─────────────────────────────
      console.info(`[Worker] Splitting into ${normalized.length} document(s)...`);

      for (const boundary of normalized) {
        const { doc_code, vendor, start_page, end_page, confidence, needs_review } = boundary;

        const docFilePath = await splitPdf(filePath, start_page, end_page, UPLOAD_DIR);
        const vendorId    = await findOrCreateVendor(vendor);
        const docType     = await getDocumentType(doc_code);

        const { rows: docRows } = await pool.query(
          `INSERT INTO documents
             (source_file_id, vendor_id, document_type_id, file_path,
              start_page, end_page, confidence, needs_review, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [sourceFileId, vendorId, docType.id, docFilePath,
            start_page, end_page, confidence, needs_review,
            needs_review ? 'pending_review' : 'queued']
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

      await updateSourceFile(sourceFileId, 'processing', 50);
      await job.updateProgress(50);

      // ── FASE 2: Smart AI — Extraction per dokumen ──────────────────────
      const { rows: pendingJobs } = await pool.query(
        `SELECT ej.id AS job_id, ej.document_id, d.file_path, dt.schema_path, dt.code AS doc_code
        FROM extraction_jobs ej
        JOIN documents d ON d.id  = ej.document_id
        JOIN source_files sf ON sf.id = d.source_file_id
        LEFT JOIN document_types dt ON dt.id = d.document_type_id
        WHERE sf.id = $1 AND ej.status = 'queued'`,
        [sourceFileId]
      );

      console.info(`[Worker] Phase 2: extracting ${pendingJobs.length} document(s)...`);

      for (let i = 0; i < pendingJobs.length; i++) {
        const { job_id, document_id, file_path, schema_path, doc_code } = pendingJobs[i];
        await updateJob(job_id, 'processing', 0);

        try {
          const { fields, items, parseError } = await extractDocument(
            file_path,
            schema_path || 'schemas/999.json',
            doc_code || '999'
          );

          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            const { rows: resultRows } = await client.query(
              'INSERT INTO extraction_results (extraction_job_id) VALUES ($1) RETURNING id',
              [job_id]
            );
            const resultId = resultRows[0].id;

            await saveFields(client, resultId, fields);
            await saveItems(client, resultId, items);

            const status = parseError ? 'failed' : 'completed';
            await client.query(
              'UPDATE extraction_jobs SET status=$1, progress=100 WHERE id=$2',
              [status, job_id]
            );
            await client.query(
              'UPDATE documents SET status=$1 WHERE id=$2',
              [status, document_id]
            );

            await client.query('COMMIT');
            console.info(`[Worker] Document ${document_id}: ${status}`);
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

        const progress = 50 + Math.round(((i + 1) / pendingJobs.length) * 45);
        await updateSourceFile(sourceFileId, 'processing', progress);
        await job.updateProgress(progress);
      }

      await updateSourceFile(sourceFileId, 'completed', 100);
      await job.updateProgress(100);
      console.info(`[Worker] Job ${job.id} completed`);

      return { sourceFileId, total: normalized.length };

    } catch (err) {
      console.error(`[Worker] Fatal job ${job.id}: ${err.message}`);
      await updateSourceFile(sourceFileId, 'failed', 0, err.message);
      throw err;
    }
  },

  {
    connection,
    concurrency: CONCURRENCY,
  }
);

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