#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as TOML from 'smol-toml';

import { loadRubric } from './rubric.ts';
import { loadManifest, loadOverrides } from './manifest.ts';
import { autoDetectStack, readToml, type Ctx } from './facts.ts';
import { audit } from './audit.ts';
import { reportJson, reportMarkdown } from './report.ts';
import { STANDARD_VERBS, type Verb } from './init.ts';

const DEFAULT_RUBRIC = '/Users/vdm/AI Projects/vdx-rubric-vodmal/vdx-rubric.yaml';

function resolveProjectRoot(argv: string[]): string {
  const i = argv.indexOf('--project');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]!);
  return process.cwd();
}

const PROJECT_ROOT = resolveProjectRoot(process.argv);

function freshCtx(): Ctx {
  const stack = autoDetectStack(PROJECT_ROOT);
  return { projectRoot: PROJECT_ROOT, stack, cache: new Map() };
}

function readMiseToml(): any {
  return readToml(freshCtx(), 'mise.toml');
}

function getVdxBlock(): any {
  const t = readMiseToml();
  return t?.vdx ?? null;
}

function getTasks(): Record<string, any> {
  const t = readMiseToml();
  return (t?.tasks as Record<string, any>) ?? {};
}

interface RunResult {
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

function spawnVerb(verb: Verb, extraArgs: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('mise', ['run', verb, ...extraArgs], {
      cwd: PROJECT_ROOT,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });
    child.on('error', (e) => {
      resolve({
        ok: false,
        exit_code: -1,
        stdout,
        stderr: stderr + `\nspawn-error: ${e.message}`,
        duration_ms: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        exit_code: code ?? -1,
        stdout,
        stderr,
        duration_ms: Date.now() - started,
      });
    });
  });
}

function buildCapabilities() {
  const vdxBlock = getVdxBlock();
  const tasks = getTasks();
  const verbsList = (vdxBlock?.verbs as string[] | undefined) ?? STANDARD_VERBS.slice();
  const verbs = verbsList.map((name) => {
    const t = tasks[name];
    const nativeCommand =
      t && typeof t === 'object' && typeof t.run === 'string' ? t.run : null;
    return {
      name,
      has_manifest: Boolean(t),
      native_command: nativeCommand,
    };
  });

  const sharedInfra = vdxBlock?.shared_infra
    ? {
        provider: String(vdxBlock.shared_infra.provider ?? ''),
        precheck: Boolean(vdxBlock.shared_infra.precheck),
        is_running: false,
      }
    : null;

  return {
    schema_version: String(vdxBlock?.schema_version ?? '0.2'),
    stack: String(vdxBlock?.stack ?? autoDetectStack(PROJECT_ROOT)),
    baseline: String(vdxBlock?.baseline ?? `file://${DEFAULT_RUBRIC}`),
    verbs,
    shared_infra: sharedInfra,
    last_verified: vdxBlock?.success_path?.last_verified ?? null,
  };
}

function buildAuditPayload(baselineOverride: string | undefined, fmt: 'json' | 'markdown') {
  const ctx = freshCtx();
  const rubricPath = DEFAULT_RUBRIC;
  const rubric = loadRubric(rubricPath);
  const manifest = loadManifest(PROJECT_ROOT);
  const overrides = loadOverrides(PROJECT_ROOT);
  const baselineRef = baselineOverride ?? manifest?.baseline ?? `file://${rubricPath}`;
  const result = audit(rubric, ctx, overrides, baselineRef, manifest);
  if (fmt === 'markdown') return reportMarkdown(result);
  return reportJson(result);
}

function recordSuccessPath(input: {
  verbs: { name: string; command: string }[];
  shared_infra?: { provider: string; precheck: boolean };
  notes?: string;
}): { ok: boolean; manifest_path: string; agents_md_updated: boolean } {
  const manifestPath = path.join(PROJECT_ROOT, 'mise.toml');
  let doc: any = {};
  if (fs.existsSync(manifestPath)) {
    const text = fs.readFileSync(manifestPath, 'utf8');
    try {
      doc = TOML.parse(text);
    } catch (e: any) {
      throw new Error(`mise.toml parse error: ${e?.message}`);
    }
  }

  doc.tasks = doc.tasks ?? {};
  for (const v of input.verbs) {
    doc.tasks[v.name] = { run: v.command };
  }

  doc.vdx = doc.vdx ?? {
    schema_version: '0.2',
    baseline: 'github.com/VoDmAl/vdx-rubric-vodmal@v0.2.1',
    stack: autoDetectStack(PROJECT_ROOT),
  };
  doc.vdx.verbs = input.verbs.map((v) => v.name);

  if (input.shared_infra) {
    doc.vdx.shared_infra = {
      provider: input.shared_infra.provider,
      precheck: input.shared_infra.precheck,
    };
  }

  doc.vdx.success_path = {
    last_verified: new Date().toISOString().slice(0, 10),
    verified_by: 'vdx-mcp',
    ...(input.notes ? { notes: input.notes } : {}),
  };

  const newText = TOML.stringify(doc);
  fs.writeFileSync(manifestPath, newText, 'utf8');

  return { ok: true, manifest_path: manifestPath, agents_md_updated: false };
}

const server = new McpServer({
  name: 'vdx',
  version: '0.1.0',
});

server.registerTool(
  'list_capabilities',
  {
    description:
      'Возвращает manifest проекта: stack, baseline, доступные глаголы и их native команды, shared_infra и last_verified. Самый частый вызов агента, входящего в проект.',
    inputSchema: {},
  },
  async () => {
    const payload = buildCapabilities();
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
);

for (const verb of STANDARD_VERBS) {
  server.registerTool(
    `vdx_${verb}`,
    {
      description: `Запускает lifecycle-глагол '${verb}' через 'mise run ${verb}'. Возвращает stdout/stderr/exit_code/duration_ms.`,
      inputSchema: { args: z.array(z.string()).optional() },
    },
    async ({ args }) => {
      const result = await spawnVerb(verb, args ?? []);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}

server.registerTool(
  'vdx_audit',
  {
    description:
      'Запускает аудит проекта против owner-рубрики. Возвращает JSON-отчёт по контракту (per_axis с уровнями) или markdown.',
    inputSchema: {
      baseline: z.string().optional(),
      format: z.enum(['json', 'markdown']).optional(),
    },
  },
  async ({ baseline, format }) => {
    const fmt = format ?? 'json';
    const payload = buildAuditPayload(baseline, fmt);
    return { content: [{ type: 'text', text: payload }] };
  },
);

server.registerTool(
  'vdx_record_success_path',
  {
    description:
      'Записывает обнаруженные команды в [tasks.X] секцию mise.toml + обновляет [vdx.success_path]. Используется после успешной верификации команд агентом.',
    inputSchema: {
      verbs: z.array(z.object({ name: z.string(), command: z.string() })),
      shared_infra: z
        .object({ provider: z.string(), precheck: z.boolean() })
        .optional(),
      notes: z.string().optional(),
    },
  },
  async ({ verbs, shared_infra, notes }) => {
    const args: Parameters<typeof recordSuccessPath>[0] = { verbs };
    if (shared_infra) args.shared_infra = shared_infra;
    if (notes !== undefined) args.notes = notes;
    const result = recordSuccessPath(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`vdx-mcp connected (project: ${PROJECT_ROOT})\n`);
}

main().catch((e) => {
  process.stderr.write(`vdx-mcp fatal: ${e?.message ?? e}\n`);
  process.exit(1);
});
