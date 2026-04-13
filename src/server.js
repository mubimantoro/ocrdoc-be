import { createServer } from 'http';
import app from './server/index.js';
import { initSocket } from './config/socket.js';

const host = process.env.HOST;
const port = process.env.PORT;
const httpServer = createServer(app);

initSocket(httpServer);

httpServer.listen(port, () => {
  console.log(`Server running at http://${host}:${port}`);
});