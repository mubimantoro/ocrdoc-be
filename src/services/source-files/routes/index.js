/* eslint-disable camelcase */
import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import path from 'path';
import authenticationToken from '../../../middlewares/auth.js';
import { getById as getFileById, getAll as getFiles, retry as retryFile, stream, upload } from '../controller/source-file-controller.js';


const router = Router();

const authenticateSSE = (req, res, next) => {
  if (req.query.token) {
    req.headers['authorization'] = `Bearer ${req.query.token}`;
  }
  return authenticationToken(req, res, next);
};


const storage = multer.diskStorage({
  destination: process.env.UPLOAD_DIR || './uploads/temp',
  filename: (req, file, cb) => cb(null, `${nanoid()}${path.extname(file.originalname)}`),
});

const upload_mw = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 100) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
      return cb(new Error('Tipe file tidak didukung'));
    cb(null, true);
  },
});

router.post('/', authenticationToken, upload_mw.single('file'), upload);
router.get('/', authenticationToken, getFiles);
router.get('/:id', authenticationToken, getFileById);
router.post('/:id/retry', authenticationToken, retryFile);

// router.get('/:id/stream', (req, res) => {
//   // 1. Validasi Token dari Query Param
//   const token = req.query.token;
//   if (!isValid(token)) return res.status(401).end();
//   // 2. Set Headers untuk SSE
//   res.writeHead(200, {
//     'Content-Type': 'text/event-stream',
//     'Cache-Control': 'no-cache',
//     'Connection': 'keep-alive',
//     'Access-Control-Allow-Origin': '*' // Sesuaikan
//   });
//   // 3. Heartbeat (opsional) agar koneksi tidak timeout oleh proxy/LB
//   const heartbeat = setInterval(() => {
//     res.write(':heartbeat\n\n');
//   }, 30000);
//   // 4. Listen ke event (bisa menggunakan Redis Pub/Sub atau EventEmitter)
//   const onFileUpdate = (data) => {
//     res.write(data: ${JSON.stringify(data)}\n\n);

//     // Jika selesai/gagal, tutup koneksi jika perlu
//     if (data.status === 'completed' || data.status === 'failed') {
//        // res.end();
//     }
//   };
//   fileEventEmitter.on(update:${req.params.id}, onFileUpdate);
//   // 5. Cleanup saat client putus koneksi
//   req.on('close', () => {
//     clearInterval(heartbeat);
//     fileEventEmitter.off(update:${req.params.id}, onFileUpdate);
//   });
// });

router.get('/:id/stream', authenticateSSE, stream);

export default router;