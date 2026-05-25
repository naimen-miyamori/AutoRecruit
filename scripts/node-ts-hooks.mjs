import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

function isLocalRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function stripSearchAndHash(url) {
  const cleanUrl = new URL(url.href);
  cleanUrl.search = '';
  cleanUrl.hash = '';
  return cleanUrl;
}

export function mapLocalJavaScriptSpecifierToTypeScriptPath(specifier, parentURL) {
  if (!isLocalRelativeSpecifier(specifier) || !parentURL?.href.startsWith('file://')) {
    return null;
  }

  const resolvedSpecifierUrl = new URL(specifier, parentURL);
  if (!resolvedSpecifierUrl.pathname.endsWith('.js')) {
    return null;
  }

  const candidatePath = fileURLToPath(stripSearchAndHash(resolvedSpecifierUrl));
  const candidateTypeScriptPath = candidatePath.slice(0, -3) + '.ts';

  if (!fs.existsSync(candidateTypeScriptPath)) {
    return null;
  }

  const candidateTypeScriptUrl = pathToFileURL(candidateTypeScriptPath);
  candidateTypeScriptUrl.search = resolvedSpecifierUrl.search;
  candidateTypeScriptUrl.hash = resolvedSpecifierUrl.hash;
  return candidateTypeScriptUrl;
}

export function loadTypeScriptModuleSource(url, sourceText) {
  return ts.transpileModule(sourceText, {
    fileName: fileURLToPath(stripSearchAndHash(url)),
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  }).outputText;
}

function registerTypeScriptResolutionHooks() {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const mappedUrl = mapLocalJavaScriptSpecifierToTypeScriptPath(specifier, context.parentURL ? new URL(context.parentURL) : null);

      if (mappedUrl) {
        return nextResolve(mappedUrl.href, context);
      }

      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const moduleUrl = new URL(url);
      if (moduleUrl.protocol === 'file:' && moduleUrl.pathname.endsWith('.ts')) {
        const sourceText = fs.readFileSync(fileURLToPath(stripSearchAndHash(moduleUrl)), 'utf8');
        return {
          format: 'module',
          shortCircuit: true,
          source: loadTypeScriptModuleSource(moduleUrl, sourceText),
        };
      }

      return nextLoad(url, context);
    },
  });
}

registerTypeScriptResolutionHooks();
