import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { extractWorkLines } from '../browser/resume-detail.js';
import { parsePlatformArg } from '../platforms/registry.js';

function isTimeRangeLine(line: string): boolean {
  return /(\d{4}\.\d{2})\s*-\s*(至今|\d{4}\.\d{2})/.test(line);
}

function isIndustryMetaFragment(line: string): boolean {
  return /\d+-\d+人|少于\d+人|国企|民营|外资|合资|已上市|上市公司|机械\/设备\/重工|仪器仪表\/工业自动化|批发\/零售|贸易\/进出口|装修装饰|家居\/家具\/家电|医疗设备\/器械|人工智能|院校|汽车|政府机关|公共事业|政府\/公共事业|其他专业服务|房地产|服装\/纺织\/皮革|建材/.test(line);
}

function isLikelyWorkTitle(line: string): boolean {
  if (['文员', '会计师', '成本管理员', '出纳', '英语老师实习'].includes(line)) {
    return true;
  }

  if (!['工程师', '主管', '经理', '总监', '专员', '销售', '顾问', '运营', '业务员', '主任', '检验员', '项目', '教师', '助理'].some((keyword) => line.includes(keyword))) {
    return false;
  }

  if (/^[0-9A-Za-z]+[、.．)]/.test(line)) {
    return false;
  }

  if (line.length > 60) {
    return false;
  }

  if (/[：:；;，,。]/.test(line)) {
    return false;
  }

  if (/负责|参与|主导|统筹|通过|协助|实现|推动|处理|跟进|完成|搭建|建立/.test(line)) {
    return false;
  }

  return true;
}

function isLikelyCompany(line: string): boolean {
  if (line.length < 2 || line.length > 80) {
    return false;
  }

  if (/^\d+[、.]|^\d{4}\.\d{2}|^（?\d+年|^[▪•●■◆]/.test(line)) {
    return false;
  }

  if (line.includes('负责') || line.includes('参与') || line.includes('项目经验') || line.includes('工作期间') || line.includes('工作经历') || line.includes('教育经历')) {
    return false;
  }

  if (line.includes('：') || /[。；，]/.test(line)) {
    return false;
  }

  if (['工程师', '主管', '经理', '总监', '专员', '销售', '顾问', '运营', '业务员', '主任', '检验员', '项目', '教师', '助理'].some((keyword) => line.includes(keyword))) {
    return false;
  }

  if (/熟练掌握|责任心|沟通协调能力|文件处理能力|突发事件处理|员工培训监督与考核|项目管理工作|中级会计职称|初级会计职称|ERP系统|外企|CET-?6/i.test(line)) {
    return false;
  }

  if (/\d+-\d+人|少于\d+人|国企|民营|外资|合资|上市公司|已上市|机械\/设备\/重工|仪器仪表\/工业自动化|批发\/零售|贸易\/进出口|装修装饰|家居\/家具\/家电|医疗设备\/器械|人工智能|院校|政府机关|公共事业|政府\/公共事业|其他专业服务|房地产|服装\/纺织\/皮革|建材/.test(line)) {
    return false;
  }

  return line.includes('有限公司')
    || line.includes('集团')
    || line.includes('科技')
    || line.includes('咨询')
    || line.includes('流体控制')
    || line.includes('服务中心')
    || line.includes('分公司')
    || line.includes('培训中心')
    || line.includes('办公室')
    || line.includes('学校')
    || line.includes('酒店')
    || line.includes('株式会社')
    || /（[^）]+）/.test(line);
}

async function main(): Promise<void> {
  const platform = parsePlatformArg(process.argv[2]);
  const jobKey = process.argv[3];
  const candidateId = process.argv[4];

  if (!jobKey || !candidateId) {
    throw new Error('Usage: tsx src/scripts/debug-work-header-checks.ts <platform> <jobKey> <candidateId>');
  }

  const snapshotPath = path.join(config.dataDir, platform, 'jobs', jobKey, 'snapshots', `${candidateId}.txt`);
  const snapshot = await fs.readFile(snapshotPath, 'utf8');
  const workLines = extractWorkLines(snapshot);

  for (let index = 0; index < workLines.length; index += 1) {
    const line = workLines[index];
    const nextLine = workLines[index + 1];

    if (!line || !nextLine) {
      continue;
    }

    if (!(isLikelyCompany(line) && isLikelyWorkTitle(nextLine))) {
      continue;
    }

    let cursor = index + 2;
    const skipped: string[] = [];
    while (cursor < workLines.length && isIndustryMetaFragment(workLines[cursor] ?? '')) {
      skipped.push(workLines[cursor]);
      cursor += 1;
    }

    const timeLine = workLines[cursor];
    console.log(JSON.stringify({
      index,
      line,
      nextLine,
      skipped,
      timeLine,
      company: isLikelyCompany(line),
      title: isLikelyWorkTitle(nextLine),
      time: Boolean(timeLine && isTimeRangeLine(timeLine)),
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
