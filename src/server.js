import http from 'http';
import server from './server/index.js';
import app from './server/index.js';
import { initSocket } from './socket.js';

const host = process.env.HOST;
const port = process.env.PORT;
const httpServer = http.createServer(app);

await initSocket(httpServer);

httpServer.listen(port, () => {
  console.log(`Server running at http://${host}:${port}`);
});