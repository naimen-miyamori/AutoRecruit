import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { extractWorkLines } from '../browser/resume-detail.js';
import { parsePlatformArg } from '../platforms/registry.js';

function isTimeRangeLine(line: string): boolean {
  return /(\d{4}\.\d{2})\s*-\s*(至今|\d{4}\.\d{2})/.test(line);
}

function isIndustryLine(line: string): boolean {
  return /\d+-\d+人|少于\d+人|国企|民营|外资|合资|上市公司|机械\/设备\/重工|仪器仪表\/工业自动化|批发\/零售|贸易\/进出口|装修装饰|家居\/家具\/家电|医疗设备\/器械|人工智能|院校/.test(line);
}

function isWorkTitle(line: string): boolean {
  return /(工程师|主管|经理|总监|专员|销售|顾问|运营|业务员|主任|检验员|项目|教师|助理)/.test(line)
    && !/[：:；;，,。]/.test(line)
    && line.length <= 20;
}

async function main(): Promise<void> {
  const platform = parsePlatformArg(process.argv[2]);
  const jobKey = process.argv[3];
  const candidateId = process.argv[4];

  if (!jobKey || !candidateId) {
    throw new Error('Usage: tsx src/scripts/debug-work-boundaries.ts <platform> <jobKey> <candidateId>');
  }

  const snapshotPath = path.join(config.dataDir, platform, 'jobs', jobKey, 'snapshots', `${candidateId}.txt`);
  const snapshot = await fs.readFile(snapshotPath, 'utf8');
  const workLines = extractWorkLines(snapshot);

  for (let i = 0; i < workLines.length; i += 1) {
    const line = workLines[i];
    const next = workLines[i + 1];
    const next2 = workLines[i + 2];
    const next3 = workLines[i + 3];
    const headerPattern = Boolean(
      next
        && isWorkTitle(next)
        && next2
        && ((isIndustryLine(next2) && next3 && isTimeRangeLine(next3)) || isTimeRangeLine(next2)),
    );

    console.log(JSON.stringify({ i, line, next, next2, next3, headerPattern }, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
