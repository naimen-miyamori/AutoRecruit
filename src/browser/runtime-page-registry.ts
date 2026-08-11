import type { BrowserContext, Page } from 'playwright';

export type RuntimeTemporaryPageEvidence = {
  purpose: string;
  identity: string;
  cleanupPolicy: 'close' | 'retain-for-inspection';
};

type RuntimePageRegistrar = (page: Page, evidence: RuntimeTemporaryPageEvidence) => void;

const registrarsByContext = new WeakMap<BrowserContext, RuntimePageRegistrar>();

export function bindRuntimePageRegistrar(context: BrowserContext, registrar: RuntimePageRegistrar): void {
  registrarsByContext.set(context, registrar);
}

export function unbindRuntimePageRegistrar(context: BrowserContext): void {
  registrarsByContext.delete(context);
}

export function registerTemporaryRuntimePageForContext(
  context: BrowserContext,
  page: Page,
  evidence: RuntimeTemporaryPageEvidence,
): void {
  registrarsByContext.get(context)?.(page, evidence);
}
