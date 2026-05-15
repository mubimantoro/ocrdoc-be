import { Router } from 'express';
import path from 'path';
import authenticationToken from '../middlewares/auth.js';
import users from '../services/users/routes/index.js';
import authentications from '../services/authentications/routes/index.js';
import documents from '../services/documents/routes/index.js';
import sourceFiles from '../services/source-files/routes/index.js';
import dashboard from '../services/dashboard/routes/index.js';

const router = Router();

// PROTECTED FILE SERVING (Under /api prefix)
router.get('/uploads/:filename', authenticationToken, (req, res) => {
  const { filename } = req.params;
  const filePath = path.resolve('uploads', filename);

  res.sendFile(filePath, (err) => {
    if (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File tidak ditemukan' });
      }
      return res.status(500).json({ error: 'Gagal mengambil file' });
    }
  });
});

router.use('/auth', authentications);
router.use('/users', users);
router.use('/documents', documents);
router.use('/source-files', sourceFiles);
router.use('/dashboard', dashboard);

export default router;