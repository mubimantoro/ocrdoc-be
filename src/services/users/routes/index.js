import { Router } from 'express';
import authenticationToken from '../../../middlewares/auth.js';
import { createUser, deleteUser, getUserById, getUsers, resetPassword, updateUser } from '../controller/user-controller.js';
import authorizeRole from '../../../middlewares/authorize.js';

const router = Router();

router.post('/', authenticationToken, authorizeRole(['admin']), createUser);
router.get('/', authenticationToken, authorizeRole(['admin']), getUsers);
router.get('/:id', authenticationToken, authorizeRole(['admin']), getUserById);
router.put('/:id', authenticationToken, authorizeRole(['admin']), updateUser);
router.delete('/:id', authenticationToken, authorizeRole(['admin']), deleteUser);
router.patch('/:id/reset-password', authenticationToken, authorizeRole(['admin']), resetPassword);

export default router;