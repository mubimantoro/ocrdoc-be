
import { Router } from 'express';
import authenticationToken from '../../../middlewares/auth.js';
import { getAll, getById as getFileById, retry as retryFile, uploadFile } from '../controller/source-file-controller.js';
import upload from '../../../middlewares/upload.js';


const router = Router();


router.post('/', authenticationToken, upload.single('file'), uploadFile);
router.get('/', authenticationToken, getAll);
router.get('/:id', authenticationToken, getFileById);
router.post('/:id/retry', authenticationToken, retryFile);

export default router;