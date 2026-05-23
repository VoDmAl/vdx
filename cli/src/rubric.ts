import * as fs from 'node:fs';
import YAML from 'js-yaml';

export type LevelName = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type AxisClass = 'critical' | 'supporting';
export type Storage = 'level' | 'flags';

// Predicate структура динамическая — оставляем any для дешёвого парсинга
// со сахаром. Валидация — отдельная история v0.2.
export type Predicate = unknown;

export interface Flag {
  id: string;
  weight: number;
  predicate: Predicate;
}

export interface StackImpl {
  flags?: Flag[];
  level_thresholds?: Partial<Record<LevelName, number>>;
}

export interface Axis {
  id: string;
  class: AxisClass;
  description?: string;
  storage: Storage;
  default_target: LevelName;
  fact_sources?: string[];
  levels?: Partial<Record<LevelName, { requires: Predicate }>>;
  stack_implementations?: Record<string, StackImpl>;
  applies_to?: string[];
}

export interface Rubric {
  schema_version: string;
  metadata: {
    name: string;
    version: string;
    owner?: string;
    description?: string;
    homepage?: string;
  };
  scoring: {
    formula: string;
    supporting_threshold: number;
  };
  levels: Record<LevelName, { name: string; description: string }>;
  axes: Axis[];
}

export function loadRubric(yamlPath: string): Rubric {
  const text = fs.readFileSync(yamlPath, 'utf8');
  const data = YAML.load(text) as Rubric;
  if (!data || !data.schema_version || !data.axes) {
    throw new Error(`Invalid rubric at ${yamlPath}: missing schema_version or axes`);
  }
  // нормализуем default_target (если кто-то напишет "L4" со spaces)
  for (const ax of data.axes) {
    ax.default_target = (ax.default_target ?? 'L4') as LevelName;
    ax.storage = (ax.storage ?? 'level') as Storage;
  }
  return data;
}
