import { Router } from 'express';
import authenticationToken from '../../../middlewares/auth.js';
import { getById as getJobById, retry as retryJob } from '../controller/job-controller.js';

const router = Router();

router.get('/:id', authenticationToken, getJobById);
router.post('/:id/retry', authenticationToken, retryJob);

export default router;