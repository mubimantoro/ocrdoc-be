import { Router } from 'express';
import authenticationToken from '../../../middlewares/auth.js';
import authorize from '../../../middlewares/authorize.js';
import { create as createUser, deleteUser, getAll as getUsers, getById as getUserById } from '../controller/user-controller.js';

const router = Router();

router.get('/', authenticationToken, authorize('admin'), getUsers);
router.get('/:id', authenticationToken, authorize('admin'), getUserById);
router.post('/', authenticationToken, authorize('admin'), createUser);
router.delete('/:id', authenticationToken, authorize('admin'), deleteUser);

export default router;