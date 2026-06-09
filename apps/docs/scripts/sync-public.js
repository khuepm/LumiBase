import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../');
const docsSrcDir = path.resolve(projectRoot, 'docs');
const publicDestDir = path.resolve(__dirname, '../public');

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    // Only copy markdown files and other doc assets (like images/diagrams if any)
    const ext = path.extname(src).toLowerCase();
    if (ext === '.md' || ext === '.txt' || ext === '.png' || ext === '.jpg' || ext === '.svg' || ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.xml') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

function sync() {
  console.log('[sync-public] Synchronizing docs for AIO...');
  
  // 1. Sync llms.txt
  const llmsSrc = path.join(docsSrcDir, 'llms.txt');
  const llmsDest = path.join(publicDestDir, 'llms.txt');
  if (fs.existsSync(llmsSrc)) {
    fs.copyFileSync(llmsSrc, llmsDest);
    console.log('  - Copied llms.txt to public/');
  }

  // 2. Sync docs/en/
  const enSrc = path.join(docsSrcDir, 'en');
  const enDest = path.join(publicDestDir, 'en');
  if (fs.existsSync(enSrc)) {
    // Clean old folder first to avoid stale files
    if (fs.existsSync(enDest)) {
      fs.rmSync(enDest, { recursive: true, force: true });
    }
    copyRecursiveSync(enSrc, enDest);
    console.log('  - Synchronized docs/en/ to public/en/');
  }

  // 3. Sync other locales if they exist
  const viSrc = path.join(docsSrcDir, 'vi');
  const viDest = path.join(publicDestDir, 'vi');
  if (fs.existsSync(viSrc)) {
    if (fs.existsSync(viDest)) {
      fs.rmSync(viDest, { recursive: true, force: true });
    }
    copyRecursiveSync(viSrc, viDest);
    console.log('  - Synchronized docs/vi/ to public/vi/');
  }

  console.log('[sync-public] Sync completed successfully!');
}

sync();
