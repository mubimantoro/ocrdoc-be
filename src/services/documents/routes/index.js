import { Router } from 'express';
import authenticationToken from '../../../middlewares/auth.js';
import { getAll as getDocs, getById as getDocById } from '../controller/document-controller.js';

const router = Router();

router.get('/', authenticationToken, getDocs);
router.get('/:id', authenticationToken, getDocById);

export default router;
