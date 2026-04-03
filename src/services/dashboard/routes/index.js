import { Router } from 'express';
import authenticationToken from '../../../middlewares/auth.js';
import { getStats } from '../controller/dashboard-controller.js';

const router = Router();
router.get('/stats', authenticationToken, getStats);

export default router;