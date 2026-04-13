import { Router } from 'express';
import authenticationToken from '../../../middlewares/auth.js';
import { getRawById, getDocuments, getDocumentDetail, retryDocument } from '../controller/document-controller.js';
import authorizeRole from '../../../middlewares/authorize.js';

const router = Router();

router.get('/', authenticationToken, getDocuments);
router.get('/:id', authenticationToken, getDocumentDetail);
router.get('/:id/raw', authenticationToken, getRawById);
router.post('/:id/retry',  authenticationToken, authorizeRole(['admin', 'operator']), retryDocument);

export default router;
