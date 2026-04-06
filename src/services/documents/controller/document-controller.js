import { extractionQueue } from '../../../config/queue.js';
import { InvariantError, NotFoundError } from '../../../exceptions/index.js';
import response from '../../../utils/response.js';
import DocumentRepositories from '../repositories/document-repositories.js';

export const getAll = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sourceFileId = req.query.source_file_id  || null;
    if (page < 1 || limit < 1) {
      return next(new InvariantError('page dan limit harus berupa angka positif'));
    }

    const result = await DocumentRepositories.findAll({ page, limit, sourceFileId });
    return response(res, 200, 'Berhasil mengambil daftar dokumen', result);
  } catch (err) {
    next(err);
  }
};

export const getById = async (req, res, next) => {
  try {
    const doc = await DocumentRepositories.findById(req.params.id);
    return response(res, 200, 'Berhasil mengambil detail dokumen', doc);
  } catch (err) { next(err); }
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