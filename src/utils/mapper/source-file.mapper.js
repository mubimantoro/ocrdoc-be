/* eslint-disable camelcase */
/**
 * Helper: Menghitung durasi pemrosesan dalam ms dan detik
 */
const calculateDuration = (startedAt, completedAt) => {
  if (!startedAt || !completedAt) return { duration_ms: null, duration_sec: null };
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return { duration_ms: ms, duration_sec: Number((ms / 1000).toFixed(2)) };
};

/**
 * Helper: Memastikan nilai mata uang ter-parsing sebagai angka dengan aman
 */
const parsePrice = (priceString) => Number(priceString) || 0;

/**
 * Main Mapper: Format raw database record ke Nested DTO
 */
export const formatSourceFileResponse = (record) => {
  if (!record) return null;

  const { duration_ms, duration_sec } = calculateDuration(record.started_at, record.completed_at);

  const promptTokens = (record.cheap_token_input || 0) + (record.cheap_token_ocr || 0);
  const outputTokens = record.cheap_token_output || 0;
  const totalTokens = promptTokens + outputTokens;

  return {
    id: record.id,
    file_name: record.file_name,
    file_path: record.file_path,
    mime_type: record.mime_type,
    page_count: record.page_count,
    status: record.status,
    progress: record.progress,
    error_message: record.error_message,
    created_at: record.created_at,
    updated_at: record.updated_at,

    processing_time: {
      started_at: record.started_at,
      completed_at: record.completed_at,
      duration_ms,
      duration_sec
    },

    ai_usage: {
      model: record.ai_model,
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cheap_model_price: parsePrice(record.cheap_price),
      flagship_model_price: parsePrice(record.total_flagship_price),
      total_price: parsePrice(record.total_price_all)
    },

    uploaded_by: {
      id: record.uploaded_by,
      name: record.uploaded_by_name
    },
    boundary_results: record.boundary_results || []
  };
};