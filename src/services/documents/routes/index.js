import { Router } from 'express';
import authenticationToken from '../../../middlewares/auth.js';
import { getAll as getDocs, getById as getDocById, getRawById, retryPendingReview } from '../controller/document-controller.js';

const router = Router();

router.get('/', authenticationToken, getDocs);
router.get('/:id', authenticationToken, getDocById);
router.get('/:id/raw', authenticationToken, getRawById);
router.post('/:id/retry',  authenticationToken, retryPendingReview);

export default router;
