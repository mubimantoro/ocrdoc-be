import { Router } from 'express';
import { login, logout, refreshAccessToken } from '../controller/authentication-controller.js';

const router = Router();

router.post('/login', login);
router.put('/refresh', refreshAccessToken);
router.delete('/logout', logout);

export default router;