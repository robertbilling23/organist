import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use((req, res, next) => {
  const blocked = ['/server.js', '/package.json', '/package-lock.json'];
  if (blocked.includes(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.static(__dirname, {
  extensions: ['html']
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Lodge Music server listening on http://${HOST}:${PORT}`);
});
