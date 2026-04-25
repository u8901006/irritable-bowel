import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { fetchPapers, loadSummarizedPmids, saveSummarizedPmids, getTaipeiDate } from './fetch_papers.js';
import { generateReport } from './generate_report.js';
import { generateIndex } from './generate_index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

async function main() {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error('[ERROR] ZHIPU_API_KEY environment variable is required');
    process.exit(1);
  }

  const skipAi = process.argv.includes('--skip-ai');
  const targetDate = process.argv.find(a => a.startsWith('--date='))?.split('=')[1] || getTaipeiDate();

  console.error(`[INFO] === BPD Research Daily Report ===`);
  console.error(`[INFO] Target date: ${targetDate}`);

  console.error(`[INFO] Step 1: Fetching papers from PubMed...`);
  const papersData = await fetchPapers(7, 50);
  console.error(`[INFO] Found ${papersData.count} new papers`);

  const papersJsonPath = resolve(ROOT, 'papers.json');
  writeFileSync(papersJsonPath, JSON.stringify(papersData, null, 2), 'utf-8');

  if (skipAi) {
    console.error('[INFO] --skip-ai flag set, skipping report generation');
    return;
  }

  const outputPath = resolve(ROOT, 'docs', `bpd-${targetDate}.html`);

  console.error(`[INFO] Step 2: Generating report with Zhipu AI...`);
  const analysis = await generateReport(apiKey, papersData, outputPath);

  console.error(`[INFO] Step 3: Updating summarized PMIDs...`);
  if (papersData.newPmids?.length) {
    const summarized = loadSummarizedPmids();
    papersData.newPmids.forEach(id => summarized.add(id));
    const dataDir = resolve(ROOT, 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    saveSummarizedPmids(summarized);
    console.error(`[INFO] Added ${papersData.newPmids.length} PMIDs to summarized list (total: ${summarized.size})`);
  }

  console.error(`[INFO] Step 4: Generating index page...`);
  generateIndex();

  console.error(`[INFO] === Done! ===`);
}

main().catch(err => {
  console.error(`[FATAL] ${err.message}`, err.stack);
  process.exit(1);
});
