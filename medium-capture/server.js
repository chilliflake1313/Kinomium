const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

function getLatestArchive() {
  const dir = path.join(__dirname, 'archive-data', 'archive');
  const folders = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  if (folders.length === 0) {
    return null;
  }

  return folders.sort().reverse()[0];
}

app.get('/capture', (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) {
    return res.send('No URL');
  }

  if (!url.includes('medium.com')) {
    return res.send('Invalid');
  }

  execFile(
    'docker',
    ['compose', 'exec', '--user=archivebox', '-T', 'archivebox', 'archivebox', 'add', '--depth=0', url],
    { cwd: __dirname },
    (err, stdout, stderr) => {
      if (err) {
        console.error('ArchiveBox exec error:', err);
        console.error('stdout:', stdout);
        console.error('stderr:', stderr);
        return res.send(`Capture failed: ${err.message || err}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
      }

      setTimeout(async () => {
        const latest = getLatestArchive();
        if (!latest) {
          return res.send('No archived snapshot found');
        }

        const archiveURL = `http://localhost:8000/archive/${latest}/index.html`;

        try {
          const response = await fetch(archiveURL);
          const html = await response.text();
          res.send(html);
        } catch (e) {
          res.send('Failed to load captured page: ' + (e.message || e));
        }
      }, 5000);
    }
  );
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000 - server.js:64');
});
