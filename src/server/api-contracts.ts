import { z } from 'zod';

export const supportedPlatformSchema = z.enum(['51job', 'liepin', 'zhilian', 'boss']);
export const platformSelectionSchema = z.union([supportedPlatformSchema, z.literal('all')]);

export const taskStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export const taskKindSchema = z.enum([
  'resume-capture',
  'batch',
  'search-subscription',
  'boss-auto-chat',
  'boss-talent-search',
  'boss-greet',
  'boss-chat-operation',
  'boss-job-sync',
  'login-refresh',
  'rag-ops',
  'talent-mapping',
  'talent-mapping-classification',
]);

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const artifactDescriptorSchema = z.object({
  artifactId: z.string().min(1),
  label: z.string().min(1),
  fileName: z.string().min(1),
  contentType: z.string().min(1),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type ArtifactDescriptor = z.infer<typeof artifactDescriptorSchema>;
