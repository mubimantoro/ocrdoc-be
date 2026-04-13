/* eslint-disable camelcase */
import { extractionQueue } from '../../../config/queue.js';
import { InvariantError, NotFoundError } from '../../../exceptions/index.js';
import { formatDocumentResponse, formatListDocumentResponse } from '../../../utils/mapper/document-mapper.js';
import { transformRawData } from '../../../utils/mapper/raw-transformer.js';
import response from '../../../utils/response.js';
import DocumentRepositories from '../repositories/document-repositories.js';

export const getDocuments = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const offset = (page - 1) * limit;

    const filters = {};
    if (req.query.source_file_id) filters.sourceFileId = req.query.source_file_id;

    // Eksekusi count dan list data secara paralel
    const [totalItems, rawDocs] = await Promise.all([
      DocumentRepositories.countAll(filters),
      DocumentRepositories.findAll(limit, offset, filters)
    ]);

    const formattedData = rawDocs.map((doc) => formatListDocumentResponse(doc));
    const totalPages = Math.ceil(totalItems / limit);

    const pagination = {
      page,
      limit,
      total_items: parseInt(totalItems, 10),
      total_pages: totalPages,
      has_next_page: page < totalPages,
      has_prev_page: page > 1
    };

    return response(res, 200, 'Berhasil mengambil daftar dokumen', formattedData, pagination);
  } catch (error) {
    next(error);
  }
};

export const getDocumentDetail = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { raw } = req.query;

    // Ambil data Induk + Relasi + EAV Arrays
    const { document, fields, items, rawData } = await DocumentRepositories.findById(id);

    // Format menjadi Nested JSON
    const formattedData = formatDocumentResponse(document, fields, items);

    if (raw === 'true' && rawData) {
      const sortedRaw = transformRawData(rawData, document.doc_type_code);
      return res.status(200).json(sortedRaw);
    }

    return response(res, 200, 'Berhasil mengambil detail dokumen', formattedData);
  } catch (error) {
    next(error);
  }
};

/**
 * Controller: Memproses ulang dokumen yang gagal (Retry)
 */
export const retryDocument = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { document } = await DocumentRepositories.findById(id);
    if (!document) {
      throw new NotFoundError('Dokumen tidak ditemukan');
    }

    if (document.status === 'completed') {
      throw new InvariantError('Dokumen sudah berhasil diproses, tidak perlu di-retry');
    }

    await DocumentRepositories.updateStatus(id, 'queued', null);


    await extractionQueue.add('extract-document', {
      documentId: document.id,
      sourceFileId: document.source_file_id,
      splitFilePath: document.file_path,
      docCode: document.doc_type_code
    });

    return response(res, 200, 'Dokumen berhasil dimasukkan kembali ke antrean untuk diproses ulang');
  } catch (error) {
    next(error);
  }
};

const RESPONSE_KEY = {
  '380': 'InvoiceResponse',
  '217': 'PackingListResponse',
  '001': 'CiplResponse',
  '705': 'BlResponse',
  '706': 'SeaWaybillResponse',
  '740': 'AwbResponse',
  '860': 'EcooResponse',
  '861': 'CooResponse',
  '704': 'MasterBlResponse',
  '741': 'MasterAwbResponse',
  '958': 'LartasResponse',
  '457': 'SkbPphResponse',
  '800': 'PostelResponse',
  '813': 'CkResponse',
  '846': 'SkemResponse',
  '854': 'BpomResponse',
  '871': 'AklResponse',
  '888': 'PengecualianResponse',
  '957': 'SniResponse',
  '959': 'PiResponse',
  '000': 'CukaiResponse',
  '999': 'LainnyaResponse',
};


export const getRawById = async (req, res, next) => {
  try {
    const result = await DocumentRepositories.findRawById(req.params.id);

    if (!result.data) {
      return next(new NotFoundError('Raw data belum tersedia untuk dokumen ini'));
    }

    const responseKey = RESPONSE_KEY[result.doc_code] ?? 'DocumentResponse';

    return res.status(200).json({
      [responseKey]: {
        data: result.data
      },
    });
  } catch (error) {
    return next(error);
  }
};

export const retryPendingReview = async (req, res, next) => {
  try {
    const doc = await DocumentRepositories.findById(req.params.id);

    if (doc.status !== 'pending_review') {
      return next(new InvariantError('Hanya dokumen dengan status pending_review yang bisa di-retry'));
    }

    const { jobId } = await DocumentRepositories.resetPendingReviewForExtraction(req.params.id);

    await extractionQueue.add('retry-document', {
      jobId,
      documentId: doc.id,
      filePath: doc.file_path,
      schemaPath: `schemas/${doc.document_type?.code || '999'}.json`,
      docCode: doc.document_type?.code || '999',
      isRetry: false,
    });

    const updated = await DocumentRepositories.findById(req.params.id);
    return response(res, 200, 'Dokumen berhasil dimasukkan ke antrian ekstraksi', updated);
  } catch (err) {
    next(err);
  }
};