import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'guo-autorecruit-resume.html');
const pdfPath = path.join(__dirname, 'guo-autorecruit-resume.pdf');
const pngPath = path.join(__dirname, 'guo-autorecruit-resume.png');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1240, height: 1754 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '0', right: '0', bottom: '0', left: '0' },
});
await page.screenshot({ path: pngPath, fullPage: true });
await browser.close();

console.log(JSON.stringify({ htmlPath, pdfPath, pngPath }, null, 2));
