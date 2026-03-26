/* eslint-disable no-unused-vars */
/* eslint-disable camelcase */
import { Router } from 'express';
import authenticationToken from '../../middlewares/auth.js';
import SourceFileRepositories from '../../services/source-files/repositories/source-file-repositories.js';
import { addClient, removeClient } from '../index.js';

const router = Router();

router.get('/:id/stream', authenticationToken, async (req, res) => {
  const { id } = req.params;

  // Validasi source file ada
  try {
    await SourceFileRepositories.findById(id);
  } catch (err) {
    return res.status(404).json({ meta: { success: false, message: 'Source file tidak ditemukan' } });
  }

  // Setup SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // penting untuk Nginx
  res.flushHeaders();

  // Kirim status awal saat connect
  const sourceFile = await SourceFileRepositories.findById(id);
  res.write(`event: connected\ndata: ${JSON.stringify({
    source_file_id: id,
    status: sourceFile.status,
    progress: sourceFile.progress,
    message: 'Connected to stream',
  })}\n\n`);

  // Daftarkan client
  addClient(id, res);

  // Heartbeat tiap 30 detik agar koneksi tidak timeout
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(id, res);
  });
});

export default router;