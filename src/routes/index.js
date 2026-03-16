import { Router } from 'express';
import users from '../service/users/routes/index.js';
import authentications from '../service/authentications/routes/index.js';

const router = Router();

router.use('/auth', authentications);
router.use('/users', users);

export default router;