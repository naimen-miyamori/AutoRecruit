import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AgentInstructionValidation {
  valid: boolean;
  violations: string[];
}

interface AgentDocumentRequirement {
  filePath: string;
  headings: readonly string[];
}

interface RouteRequirement {
  parentPath: string;
  childPath: string;
  reference: string;
}

export const agentDocumentRequirements: readonly AgentDocumentRequirement[] = [
  {
    filePath: 'AGENTS.md',
    headings: ['Scope, Inheritance, and Routing', 'Verification Matrix'],
  },
  {
    filePath: 'src/browser/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
  {
    filePath: 'src/platforms/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
  {
    filePath: 'src/platforms/51job/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
  {
    filePath: 'src/platforms/liepin/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
  {
    filePath: 'src/platforms/zhilian/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
  {
    filePath: 'src/platforms/boss/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
  {
    filePath: 'src/talent-mapping/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
  {
    filePath: 'src/rag/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
  {
    filePath: 'src/server/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
  {
    filePath: 'frontend/AGENTS.md',
    headings: ['Scope and Inheritance', 'Ownership and Boundaries', 'Verification'],
  },
];

export const agentRouteRequirements: readonly RouteRequirement[] = [
  { parentPath: 'AGENTS.md', childPath: 'src/browser/AGENTS.md', reference: 'src/browser/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'src/platforms/AGENTS.md', reference: 'src/platforms/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'src/talent-mapping/AGENTS.md', reference: 'src/talent-mapping/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'src/rag/AGENTS.md', reference: 'src/rag/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'src/server/AGENTS.md', reference: 'src/server/AGENTS.md' },
  { parentPath: 'AGENTS.md', childPath: 'frontend/AGENTS.md', reference: 'frontend/AGENTS.md' },
  {
    parentPath: 'src/platforms/AGENTS.md',
    childPath: 'src/platforms/51job/AGENTS.md',
    reference: 'src/platforms/51job/AGENTS.md',
  },
  {
    parentPath: 'src/platforms/AGENTS.md',
    childPath: 'src/platforms/liepin/AGENTS.md',
    reference: 'src/platforms/liepin/AGENTS.md',
  },
  {
    parentPath: 'src/platforms/AGENTS.md',
    childPath: 'src/platforms/zhilian/AGENTS.md',
    reference: 'src/platforms/zhilian/AGENTS.md',
  },
  {
    parentPath: 'src/platforms/AGENTS.md',
    childPath: 'src/platforms/boss/AGENTS.md',
    reference: 'src/platforms/boss/AGENTS.md',
  },
];

function hasHeading(content: string, heading: string): boolean {
  const escapedHeading = heading.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  return new RegExp('^## ' + escapedHeading + '$', 'm').test(content);
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function validateAgentInstructions(rootDir: string): Promise<AgentInstructionValidation> {
  const root = path.resolve(rootDir);
  const contentByPath = new Map<string, string>();
  const violations: string[] = [];

  for (const requirement of agentDocumentRequirements) {
    const content = await readFileIfExists(path.join(root, requirement.filePath));
    if (content === undefined) {
      violations.push(requirement.filePath + ' is required');
      continue;
    }
    contentByPath.set(requirement.filePath, content);
    for (const heading of requirement.headings) {
      if (!hasHeading(content, heading)) {
        violations.push(requirement.filePath + ' must include ## ' + heading);
      }
    }
  }

  const parentByChild = new Map<string, string>();
  for (const route of agentRouteRequirements) {
    const existingParent = parentByChild.get(route.childPath);
    if (existingParent && existingParent !== route.parentPath) {
      violations.push(route.childPath + ' has multiple routing parents: ' + existingParent + ', ' + route.parentPath);
      continue;
    }
    parentByChild.set(route.childPath, route.parentPath);
    const parent = contentByPath.get(route.parentPath)
      ?? await readFileIfExists(path.join(root, route.parentPath));
    if (parent === undefined) continue;
    if (!parent.includes(route.reference)) {
      violations.push(route.parentPath + ' must route to ' + route.childPath);
    }
  }

  return { valid: violations.length === 0, violations };
}

export async function main(argv = process.argv.slice(2), rootDir = process.cwd()): Promise<void> {
  const [command = 'check', ...options] = argv;
  if (command !== 'check' || options.length > 0) {
    throw new Error('Usage: agents:check');
  }
  const validation = await validateAgentInstructions(rootDir);
  if (!validation.valid) {
    throw new Error('AGENTS validation failed:\n' + validation.violations.map((violation) => '- ' + violation).join('\n'));
  }
  console.log('AGENTS validation passed (' + agentDocumentRequirements.length + ' documents)');
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypointUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
