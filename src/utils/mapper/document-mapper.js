/* eslint-disable camelcase */
import 'dotenv/config';

const calculateDuration = (startedAt, completedAt) => {
  if (!startedAt || !completedAt) return { duration_ms: null, duration_sec: null };
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return { duration_ms: ms, duration_sec: Number((ms / 1000).toFixed(2)) };
};

const parseNumber = (val) => Number(val) || 0;


export const formatDocumentResponse = (doc, eavFields = [], eavItems = []) => {
  if (!doc) return null;

  const jobTime = calculateDuration(doc.job_started_at, doc.job_completed_at);

  const rateInput = parseFloat(process.env.GEMINI_FLAGSHIP_INPUT_RATE);
  const rateOutput = parseFloat(process.env.GEMINI_FLAGSHIP_OUTPUT_RATE);

  const inputPrice = doc.token_input ? (doc.token_input + doc.token_ocr) * rateInput : 0;
  const outputPrice = doc.token_output ? doc.token_output * rateOutput : 0;

  const itemsMap = new Map();
  eavItems.forEach((row) => {
    if (!itemsMap.has(row.row_index)) {
      itemsMap.set(row.row_index, { row_index: row.row_index });
    }
    itemsMap.get(row.row_index)[row.key] = row.value;
  });

  return {
    id: doc.id,
    start_page: doc.start_page,
    end_page: doc.end_page,
    status: doc.status,
    confidence: parseNumber(doc.confidence),
    needs_review: doc.needs_review || false,
    error_message: doc.error_message,
    file_path: doc.file_path,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    job_id: doc.job_id,

    processing_time: {
      started_at: doc.job_started_at,
      completed_at: doc.job_completed_at,
      ...jobTime
    },

    document_type: {
      id: doc.doc_type_id,
      code: doc.doc_type_code,
      name: doc.doc_type_name
    },

    vendor: doc.vendor_id ? {
      id: doc.vendor_id,
      name: doc.vendor_name
    } : null,

    source_file: {
      id: doc.source_file_id,
      file_name: doc.source_file_name
    },

    fields: eavFields.map((f) => ({ key: f.key, value: f.value })),
    items: Array.from(itemsMap.values()).sort((a, b) => a.row_index - b.row_index),

    ai_usage: {
      model: doc.ai_model,
      prompt_tokens: (doc.token_input || 0) + (doc.token_ocr || 0),
      output_tokens: doc.token_output || 0,
      total_tokens: doc.total_tokens || 0,
      input_price: parseNumber(inputPrice),
      output_price: parseNumber(outputPrice),
      total_price: parseNumber(doc.price),
      total_pages: (doc.end_page - doc.start_page) + 1,
      duration_ms: doc.processing_duration_ms,
      duration_sec: doc.processing_duration_ms ? parseNumber((doc.processing_duration_ms / 1000).toFixed(2)) : null
    }
  };
};

export const formatListDocumentResponse = (doc) => {
  const summary = formatDocumentResponse(doc, [], []);

  if (!summary) return null;

  delete summary.fields;
  delete summary.items;

  return summary;
};