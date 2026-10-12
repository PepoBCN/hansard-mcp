import type { z } from 'zod';

export interface ToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: true;
  };
  handler: (input: z.infer<I>, ctx: { requestId: string }) => Promise<unknown>;
}

/** Every tool here is read-only over public data; the annotations never vary. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
