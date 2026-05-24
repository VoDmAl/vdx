import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const BUNDLED_RUBRIC_PATH = path.resolve(here, '..', 'rubric', 'vdx-rubric.yaml');

export function resolveDefaultRubric(): string {
  return process.env['VDX_RUBRIC'] ?? BUNDLED_RUBRIC_PATH;
}
