import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_ROOT = path.resolve(__dirname, 'audio');
const DIST_ROOT = path.resolve(__dirname, 'dist');
const ALLOWED_AUDIO_EXTS = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac']);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

async function listAudioFilesRecursive(dir, relativeBase = 'audio') {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = `${relativeBase}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await listAudioFilesRecursive(fullPath, relPath);
      results.push(...nested);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_AUDIO_EXTS.has(ext)) {
        results.push(relPath);
      }
    }
  }
  return results;
}

const BLOCKED_PATHS = new Set([
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/bun.lock',
  '/firebase-applet-config.json',
  '/firestore.rules',
  '/firebase-blueprint.json',
  '/eslint.config.js',
  '/tsconfig.json',
  '/vite.config.ts',
  '/security_spec.md',
  '/firestore.rules.test.ts'
]);

app.use((req, res, next) => {
  if (BLOCKED_PATHS.has(req.path) || req.path.startsWith('/src/')) {
    return res.status(404).send('Not found');
  }
  next();
});

app.get('/api/audio-files', async (_req, res) => {
  try {
    const files = await listAudioFilesRecursive(AUDIO_ROOT);
    files.sort((a, b) => a.localeCompare(b));
    return res.json({ files });
  } catch (err) {
    console.error('Failed to list audio files:', err);
    return res.status(500).json({ error: 'Failed to list audio files' });
  }
});

app.post('/api/upload-audio', express.raw({ type: '*/*', limit: '60mb' }), async (req, res) => {
  try {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!requestedPath || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Missing file path or audio payload' });
    }

    const resolvedTarget = path.resolve(__dirname, requestedPath);
    const ext = path.extname(resolvedTarget).toLowerCase();
    if (!resolvedTarget.startsWith(AUDIO_ROOT + path.sep) || !ALLOWED_AUDIO_EXTS.has(ext)) {
      return res.status(400).json({ error: 'Invalid audio destination path' });
    }

    await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
    await fs.writeFile(resolvedTarget, req.body);
    return res.json({ ok: true, file: requestedPath, bytes: req.body.length });
  } catch (err) {
    console.error('Audio upload failed:', err);
    return res.status(500).json({ error: 'Failed to save audio file' });
  }
});

app.use(express.static(DIST_ROOT, {
  extensions: ['html']
}));

app.use(express.static(__dirname, {
  extensions: ['html']
}));

app.get('/', (_req, res) => {
  res.sendFile(path.join(DIST_ROOT, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Lodge Music server listening on http://${HOST}:${PORT}`);
});
