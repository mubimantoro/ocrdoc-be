import { Router } from 'express';
import { login, logout, refresh } from '../controller/authentication-controller.js';

const router = Router();

router.post('/login', login);
router.put('/refresh', refresh);
router.delete('/logout', logout);

export default router;