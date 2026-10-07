import { z } from 'zod';

/** data/scenarios/open-chat.yaml: the recurring friend 安安. Not a Scenario (no goal steps),
 * so the scenario build skips this file and compiles it to data/build/open-chat.json. */
export const OpenChatPersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  personality: z.string(),
  speechStyle: z.string(),
  particles: z.array(z.string()).default([]),
  setting: z.string(),
});
export type OpenChatPersona = z.infer<typeof OpenChatPersonaSchema>;

export const OpenChatPersonaFileSchema = z.object({
  meta: z.object({ version: z.string(), buildDate: z.string() }),
  persona: OpenChatPersonaSchema,
});
