#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolveBinary(name: string, fallback: string): string {
  const which = spawnSync('which', [name], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return name;
}

const HERDR_APP = resolveBinary('herdr-app', path.join(os.homedir(), '.local/bin/herdr-app'));
const HC_BIN = resolveBinary('hc', path.join(os.homedir(), '.local/bin/hc'));

interface AgyQuadOptions {
  layout: 'split' | 'tabs';
  folder: string;
  tabName: string;
  models: string[];
  prompts: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): AgyQuadOptions {
  const opts: AgyQuadOptions = {
    layout: 'split',
    folder: process.cwd(),
    tabName: 'AGY 4-Split + TUI Watch',
    models: [],
    prompts: [],
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--layout': {
        const l = argv[++i];
        if (l === 'split' || l === 'tabs') opts.layout = l;
        break;
      }
      case '--tabs':
        opts.layout = 'tabs';
        break;
      case '--split':
        opts.layout = 'split';
        break;
      case '--folder':
      case '--cwd':
        opts.folder = path.resolve(argv[++i] ?? process.cwd());
        break;
      case '--name':
      case '--tab':
        opts.tabName = argv[++i] ?? opts.tabName;
        break;
      case '--models': {
        const raw = argv[++i] ?? '';
        opts.models = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      }
      case '--prompts': {
        const raw = argv[++i] ?? '';
        opts.prompts = raw
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      }
      case '--prompt':
      case '-p': {
        const p = argv[++i];
        if (p) opts.prompts = [p];
        break;
      }
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Herdr AGY 4-Split + Unified TUI Watch Launcher
==============================================
Herdr App에서 4개의 분할 터미널로 'agy --dangerously-skip-permissions'를 띄워 코딩을 실행하고,
동시에 다른 패널(또는 별도 탭)에 5계층 통합 TUI(--watch)를 띄워 실제 작업 진행을 실시간 관제합니다.

사용법:
  node ./scripts/herdr-agy-quad-watch.ts [옵션]

옵션:
  --layout <split|tabs>   배치 방식 (기본: split)
                            - split: 한 탭에 [좌측 2×2 agy 4분할] + [우측 통합 TUI 관제] 동시 표시
                            - tabs : [탭1: 2×2 agy 4분할] + [탭2: 전체화면 통합 TUI 관제]
  --folder <path>         작업 디렉터리 (기본: 현재 디렉터리)
  --models <m1,m2,m3,m4>  각 패널별 모델 지정 (쉼표 구분, 예: gemini-3.8-flash-high,gemini-3.8-flash-medium)
  --prompts <p1|p2|...>   각 패널 초기 인터랙티브 프롬프트 ('|' 구분)
  --name <title>          탭 이름
  --dry-run               실행하지 않고 명령어만 출력
`);
        process.exit(0);
    }
  }
  return opts;
}

function runJson(bin: string, args: string[], dryRun: boolean): any {
  if (dryRun) {
    console.log(`[DRY-RUN] ${bin} ${args.join(' ')}`);
    return { pane: 'p_mock', terminal: 't_mock', focused_pane: 'p_mock' };
  }
  const out = execFileSync(bin, args, { encoding: 'utf8' });
  try {
    return JSON.parse(out);
  } catch {
    return out.trim();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureHerdrRunning(dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const check = spawnSync(HERDR_APP, ['status'], { encoding: 'utf8' });
  if (check.status === 0) return;

  console.log('🚀 Herdr App을 시작합니다...');
  spawnSync('open', ['-a', 'Herdr'], { encoding: 'utf8' });
  for (let i = 0; i < 15; i++) {
    await sleep(500);
    const retry = spawnSync(HERDR_APP, ['status'], { encoding: 'utf8' });
    if (retry.status === 0) return;
  }
  throw new Error('Herdr App 상태를 확인할 수 없습니다.');
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildAgyCommand(folder: string, model?: string, prompt?: string): string {
  const parts = ['agy', '--dangerously-skip-permissions'];
  if (model) {
    parts.push('--model', shellEscape(model));
  }
  if (prompt) {
    parts.push('-i', shellEscape(prompt));
  }
  return `cd ${shellEscape(folder)} && ${parts.join(' ')}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  await ensureHerdrRunning(opts.dryRun);

  const tuiCmd = `cd ${shellEscape(PROJECT_ROOT)} && node ./src/cli.ts --watch`;

  if (opts.layout === 'split') {
    console.log(`\n📐 한 화면에 [좌측 4× agy 분할] + [우측 통합 TUI 관제] 패널을 생성합니다...`);

    // 1. 새 탭 생성 (p1: 좌측 영역)
    const tabRes = runJson(
      HERDR_APP,
      ['do', 'tab.new', '--name', opts.tabName, '--folder', opts.folder],
      opts.dryRun
    );
    const t1 = tabRes.terminal as string;
    const statusRes = runJson(HERDR_APP, ['status'], opts.dryRun);
    const p1 = (statusRes.focused_pane as string) || 'p1';

    // 2. 우측에 통합 TUI 관제 패널 분리 (pTui)
    const splitTuiRes = runJson(
      HERDR_APP,
      ['do', 'pane.split', '--pane', p1, '--direction', 'right'],
      opts.dryRun
    );
    const pTui = splitTuiRes.pane as string;
    const tTui = splitTuiRes.terminal as string;

    // 3. 좌측 영역(p1)을 2×2로 4분할 (p1, p2, p3, p4)
    const splitRightRes = runJson(
      HERDR_APP,
      ['do', 'pane.split', '--pane', p1, '--direction', 'right'],
      opts.dryRun
    );
    const p2 = splitRightRes.pane as string;
    const t2 = splitRightRes.terminal as string;

    const splitLeftDownRes = runJson(
      HERDR_APP,
      ['do', 'pane.split', '--pane', p1, '--direction', 'down'],
      opts.dryRun
    );
    const p3 = splitLeftDownRes.pane as string;
    const t3 = splitLeftDownRes.terminal as string;

    const splitRightDownRes = runJson(
      HERDR_APP,
      ['do', 'pane.split', '--pane', p2, '--direction', 'down'],
      opts.dryRun
    );
    const p4 = splitRightDownRes.pane as string;
    const t4 = splitRightDownRes.terminal as string;

    const agyPanes = [
      { pane: p1, term: t1, idx: 0, label: 'agy-1' },
      { pane: p2, term: t2, idx: 1, label: 'agy-2' },
      { pane: p3, term: t3, idx: 2, label: 'agy-3' },
      { pane: p4, term: t4, idx: 3, label: 'agy-4' },
    ];

    for (const item of agyPanes) {
      if (!opts.dryRun) {
        spawnSync(HC_BIN, ['label', item.term, `name=${item.label}`, 'role=coder'], {
          encoding: 'utf8',
        });
      }
      const cmd = buildAgyCommand(
        opts.folder,
        opts.models[item.idx],
        opts.prompts[item.idx]
      );
      console.log(`  ⚡ [${item.label}] (${item.term}) -> ${cmd}`);
      runJson(HC_BIN, ['send', item.term, cmd], opts.dryRun);
    }

    if (!opts.dryRun) {
      spawnSync(HC_BIN, ['label', tTui, 'name=TUI-Monitor', 'role=monitor'], {
        encoding: 'utf8',
      });
    }
    console.log(`  📺 [TUI-Monitor] (${tTui}) -> ${tuiCmd}`);
    runJson(HC_BIN, ['send', tTui, tuiCmd], opts.dryRun);

    // 포커스를 첫 번째 agy 패널로 이동
    runJson(HERDR_APP, ['do', 'pane.focus', '--pane', p1], opts.dryRun);

    console.log(`\n✅ 구성 완료! (한 화면 5패널: 좌측 4분할 agy 코딩 + 우측 통합 TUI 관제)`);
    console.log(`   ┌─────────────┬─────────────┬──────────────────────────┐`);
    console.log(`   │ agy #1      │ agy #2      │                          │`);
    console.log(`   ├─────────────┼─────────────┤   통합 TUI 실시간 관제    │`);
    console.log(`   │ agy #3      │ agy #4      │   (--watch)              │`);
    console.log(`   └─────────────┴─────────────┴──────────────────────────┘\n`);
  } else {
    console.log(`\n📐 2개 탭 구성: [탭1: 4분할 agy] + [탭2: 통합 TUI 관제]를 생성합니다...`);

    // 탭 1: 4분할 agy
    const tab1Res = runJson(
      HERDR_APP,
      ['do', 'tab.new', '--name', 'Coding · 4× agy', '--folder', opts.folder],
      opts.dryRun
    );
    const t1 = tab1Res.terminal as string;
    const status1 = runJson(HERDR_APP, ['status'], opts.dryRun);
    const p1 = (status1.focused_pane as string) || 'p1';

    const splitR = runJson(HERDR_APP, ['do', 'pane.split', '--pane', p1, '--direction', 'right'], opts.dryRun);
    const p2 = splitR.pane as string;
    const t2 = splitR.terminal as string;

    const splitLD = runJson(HERDR_APP, ['do', 'pane.split', '--pane', p1, '--direction', 'down'], opts.dryRun);
    const p3 = splitLD.pane as string;
    const t3 = splitLD.terminal as string;

    const splitRD = runJson(HERDR_APP, ['do', 'pane.split', '--pane', p2, '--direction', 'down'], opts.dryRun);
    const p4 = splitRD.pane as string;
    const t4 = splitRD.terminal as string;

    const agyPanes = [
      { pane: p1, term: t1, idx: 0, label: 'agy-1' },
      { pane: p2, term: t2, idx: 1, label: 'agy-2' },
      { pane: p3, term: t3, idx: 2, label: 'agy-3' },
      { pane: p4, term: t4, idx: 3, label: 'agy-4' },
    ];

    for (const item of agyPanes) {
      if (!opts.dryRun) {
        spawnSync(HC_BIN, ['label', item.term, `name=${item.label}`, 'role=coder'], {
          encoding: 'utf8',
        });
      }
      const cmd = buildAgyCommand(
        opts.folder,
        opts.models[item.idx],
        opts.prompts[item.idx]
      );
      runJson(HC_BIN, ['send', item.term, cmd], opts.dryRun);
    }

    // 탭 2: 전체 화면 통합 TUI 관제
    const tab2Res = runJson(
      HERDR_APP,
      ['do', 'tab.new', '--name', 'Monitor · TUI', '--folder', PROJECT_ROOT],
      opts.dryRun
    );
    const tTui = tab2Res.terminal as string;
    if (!opts.dryRun) {
      spawnSync(HC_BIN, ['label', tTui, 'name=TUI-Monitor', 'role=monitor'], {
        encoding: 'utf8',
      });
    }
    runJson(HC_BIN, ['send', tTui, tuiCmd], opts.dryRun);

    console.log(`\n✅ 구성 완료! 탭1(4분할 agy)과 탭2(통합 TUI 관제)가 생성되었습니다.\n`);
  }
}

main().catch((err) => {
  console.error('❌ 오류:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
