#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tty from 'node:tty';
import {
  AgentRunner,
  type BackendPreference,
} from './backend/agentRunner.ts';
import {
  attachTranscriptWatcher,
  findLatestTranscriptPath,
} from './backend/transcriptMapper.ts';
import { attachHerdrWatcher } from './backend/herdrWatcher.ts';
import { parseKeyEvents, TerminalScreen, type KeyEvent } from './core/terminal.ts';
import {
  applyDemoTime,
  createDemoController,
  executePromptCommand,
  type LivePromptHooks,
} from './state/demoEngine.ts';
import {
  appendLog,
  createInitialState,
  cycleFocus,
  flashStatus,
  formatCompactPath,
  getFilteredLogs,
} from './state/store.ts';
import {
  attachFileStream,
  attachStdinStream,
  parseJsonLine,
} from './state/streamAdapter.ts';
import type { CompactTab, EffortLevel, ModalKind, QuadRole, RunMode } from './types.ts';
import { computeLayout } from './ui/layout.ts';
import { renderFrame } from './ui/renderApp.ts';
import { renderQuadRoleFrame } from './ui/renderQuadRole.ts';
import { QuadBusClient, QuadBusServer, type QuadMessage } from './ipc/quadBus.ts';

interface CliOptions {
  mode: RunMode;
  filePath: string | null;
  watchMode: boolean;
  watchDir: string | null;
  follow: boolean;
  replayMs: number;
  initialTime: number;
  paused: boolean;
  snapshotPlain: boolean;
  snapshotAnsi: boolean;
  colsOverride: number | null;
  rowsOverride: number | null;
  modalOverride: ModalKind;
  modelName: string | null;
  effort: EffortLevel | null;
  initialPrompt: string | null;
  backendPref: BackendPreference;
  autoApprove: boolean;
  showHelp: boolean;
  quad: boolean;
  quadRole: QuadRole | null;
  isHub: boolean;
  herdrWatch: boolean;
  herdrTerminals: string[] | null;
}

function parseArgs(argv: string[]): CliOptions {
  const stdinPiped = !process.stdin.isTTY;
  const opts: CliOptions = {
    mode: stdinPiped ? 'stream' : 'demo',
    filePath: null,
    watchMode: false,
    watchDir: null,
    follow: false,
    replayMs: 0,
    initialTime: 0,
    paused: false,
    snapshotPlain: false,
    snapshotAnsi: false,
    colsOverride: null,
    rowsOverride: null,
    modalOverride: 'none',
    modelName: null,
    effort: null,
    initialPrompt: null,
    backendPref: 'auto',
    autoApprove: false,
    showHelp: false,
    quad: false,
    quadRole: null,
    isHub: false,
    herdrWatch: false,
    herdrTerminals: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--demo':
        opts.mode = 'demo';
        break;
      case '--live':
      case '--agy':
        opts.mode = 'live';
        break;
      case '--watch':
      case '-w':
        opts.mode = 'watch';
        opts.watchMode = true;
        opts.follow = true;
        if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) {
          opts.filePath = argv[++i]!;
        }
        break;
      case '--watch-dir':
        opts.watchDir = argv[++i] ?? null;
        break;
      case '--stream':
        opts.mode = 'stream';
        break;
      case '--file':
      case '-f':
        opts.mode = 'stream';
        opts.filePath = argv[++i] ?? null;
        break;
      case '--follow':
        opts.follow = true;
        break;
      case '--replay-ms':
        opts.replayMs = Number(argv[++i] ?? '350') || 350;
        break;
      case '--model':
      case '-m':
        opts.modelName = argv[++i] ?? null;
        break;
      case '--effort': {
        const eff = argv[++i];
        if (eff === 'low' || eff === 'medium' || eff === 'high' || eff === 'max') {
          opts.effort = eff;
        }
        break;
      }
      case '--prompt':
      case '-p':
        opts.initialPrompt = argv[++i] ?? null;
        if (opts.mode === 'demo' && !stdinPiped) {
          opts.mode = 'live';
        }
        break;
      case '--backend': {
        const b = argv[++i];
        if (b === 'auto' || b === 'agy' || b === 'api') {
          opts.backendPref = b;
        }
        break;
      }
      case '--auto-approve':
        opts.autoApprove = true;
        break;
      case '--time':
      case '--seek':
      case '-t':
        opts.initialTime = Number(argv[++i] ?? '0') || 0;
        break;
      case '--paused':
        opts.paused = true;
        break;
      case '--snapshot':
        opts.snapshotPlain = true;
        break;
      case '--ansi-snapshot':
        opts.snapshotAnsi = true;
        break;
      case '--cols':
        opts.colsOverride = Number(argv[++i] ?? '148') || 148;
        break;
      case '--rows':
        opts.rowsOverride = Number(argv[++i] ?? '43') || 43;
        break;
      case '--modal': {
        const m = argv[++i];
        if (
          m === 'help' ||
          m === 'swarm' ||
          m === 'advisor' ||
          m === 'neon' ||
          m === 'decision' ||
          m === 'logs' ||
          m === 'response'
        ) {
          opts.modalOverride = m;
        }
        break;
      }
      case '--quad':
        opts.quad = true;
        break;
      case '--role': {
        const r = argv[++i];
        if (r === 'argon' || r === 'carbon' || r === 'neon' || r === 'hydrogen' || r === 'all') {
          opts.quadRole = r;
          opts.quad = true;
        }
        break;
      }
      case '--hub':
        opts.isHub = true;
        break;
      case '--herdr-watch':
        opts.mode = 'watch';
        opts.herdrWatch = true;
        break;
      case '--watch-terminals': {
        const raw = argv[++i] ?? '';
        const list = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length > 0) opts.herdrTerminals = list;
        break;
      }
      case '--help':
      case '-h':
        opts.showHelp = true;
        break;
    }
  }
  return opts;
}

function printCliHelp(): void {
  const usage = `
GEMINI CLI SUBAGENT TUI (Argon · Decision 1 · Hydrogen · Neon · Carbon)

사용법:
  node ./src/cli.ts [옵션]

실행 모드 옵션:
  --watch, -w [path]     실행 중인 agy/세션 트랜스크립트(transcript.jsonl) 자동 감지 및 실시간 관제
  --watch-dir <path>     트랜스크립트 검색 기본 디렉터리 지정 (기본: ~/.gemini/antigravity/brain)
  --live, --agy          실제 Antigravity(agy) / Gemini API 백엔드 에이전트 루프 연결 실행
  --demo                 gemini_sub_neon.html의 40초 멀티 에이전트 시나리오 데모 실행 (기본값)
  --stream               표준 입력(stdin)으로부터 JSONL(또는 agy stream-json) 실시간 렌더링
  --file, -f <path>      지정한 JSONL 이벤트 로그 파일을 로드하여 렌더링
  --follow               --file 사용 시 파일에 추가되는 새 이벤트를 실시간 추적 (tail -f)
  --replay-ms <ms>       --file 사용 시 각 이벤트를 지정 간격(ms)으로 순차 재생

라이브 백엔드 옵션 (--live):
  --model, -m <name>     사용할 모델 지정 (기본: gemini-4-argon-high, 예: gemini-4-neon-high)
  --effort <level>       추론 강도 지정 (low | medium | high | max)
  --prompt, -p <text>    시작과 동시에 실행할 초기 프롬프트 지정
  --backend <kind>       백엔드 선택 (auto | agy | api)
  --auto-approve         agy 실행 시 도구 권한 자동 승인(--dangerously-skip-permissions) 전달

타임라인 및 스냅샷 옵션:
  --time, -t <sec>       데모 시작 타임라인 초(0~40) 지정 (예: --time 10)
  --paused               일시정지 상태로 시작
  --snapshot             지정 해상도의 플레인 텍스트 프레임을 출력하고 종료
  --ansi-snapshot        지정 해상도의 24비트 ANSI 컬러 프레임을 출력하고 종료
  --cols <n> --rows <n>  스냅샷 렌더링 시 터미널 가로/세로 셀 크기 지정
  --help, -h             도움말 출력

단축키 요약:
  Tab / Shift+Tab        패널 포커스 이동
  Enter                  포커스된 패널 상세 모달 열기
  r / s / n / c / d / l  응답(r) · 스웜(s) · Neon(n) · Carbon(c) · 분기(d) · 로그(l) 모달 열기
  1~5 / 0                에이전트별 로그 필터 (1:Argon, 2:Hydrogen, 3:Decision, 4:Neon, 5:Carbon, 0:전체)
  / 또는 i               하단 프롬프트 입력창 진입 (/model, /neon, /carbon, /new, /cancel 지원)
  Space / ← →            데모 일시정지·재생 및 타임라인 탐색
  ?                      인앱 도움말 모달 열기
  q / Ctrl+C             종료
`.trim();
  console.log(usage);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.showHelp) {
    printCliHelp();
    return;
  }

  const state = createInitialState(opts.mode);
  state.paused = opts.paused;
  state.modal = opts.modalOverride;
  if (opts.modelName) {
    state.modelName = opts.modelName;
    state.modelFlag = `--model ${opts.modelName}`;
  }
  if (opts.effort) {
    state.effort = opts.effort;
  }

  const runner =
    opts.mode === 'live'
      ? new AgentRunner({
          preference: opts.backendPref,
          autoApprove: opts.autoApprove,
        })
      : null;
  if (runner) {
    state.backendKind = runner.backend;
  }

  const demoCtrl = createDemoController();

  let baseWallMs = Date.now();
  let timeOffsetSec = opts.initialTime;

  const seekTo = (sec: number) => {
    timeOffsetSec = ((sec % 40) + 40) % 40;
    baseWallMs = Date.now();
    if (state.mode === 'demo') {
      applyDemoTime(state, timeOffsetSec, demoCtrl);
    } else {
      state.simTime = timeOffsetSec;
    }
  };

  if (opts.mode === 'demo') {
    applyDemoTime(state, opts.initialTime, demoCtrl);
  } else if (opts.watchMode || opts.mode === 'watch') {
    if (!opts.filePath) {
      opts.filePath = findLatestTranscriptPath(opts.watchDir ?? undefined);
    }
    if (opts.filePath && (opts.snapshotPlain || opts.snapshotAnsi)) {
      const stop = attachTranscriptWatcher(opts.filePath, state, () => {});
      stop();
      state.simTime = opts.initialTime;
    }
  } else if (opts.filePath) {
    // 스냅샷 모드일 경우 즉시 동기 로드, 라이브일 경우 아래에서 attach
    if (opts.snapshotPlain || opts.snapshotAnsi) {
      const stop = attachFileStream(opts.filePath, state, false, 0, () => {});
      stop();
      state.simTime = opts.initialTime;
    }
  } else if ((opts.snapshotPlain || opts.snapshotAnsi) && !process.stdin.isTTY) {
    const piped = fs.readFileSync(0, 'utf8');
    for (const line of piped.split(/\r?\n/)) {
      parseJsonLine(line, state);
    }
    state.simTime = opts.initialTime;
  }

  // 단발성 스냅샷 출력 모드
  if (opts.snapshotPlain || opts.snapshotAnsi) {
    const cols = opts.colsOverride ?? (opts.quadRole ? 80 : 148);
    const rows = opts.rowsOverride ?? (opts.quadRole ? 24 : 43);
    const frame =
      opts.quad && opts.quadRole && opts.quadRole !== 'all'
        ? renderQuadRoleFrame(state, opts.quadRole, cols, rows)
        : renderFrame(state, cols, rows);
    console.log(opts.snapshotAnsi ? frame.toAnsiFullFrame() : frame.toPlainString());
    return;
  }

  // 인터랙티브 라이브 TUI 루프 시작
  const screen = new TerminalScreen();
  const stdinIsTty = Boolean(process.stdin.isTTY);
  screen.enter(stdinIsTty);

  let stopFileWatcher: (() => void) | null = null;
  let checkNewSessionTimer: ReturnType<typeof setInterval> | null = null;
  let extraTtyStream: tty.ReadStream | null = null;
  let busServer: QuadBusServer | null = null;
  let busClient: QuadBusClient | null = null;
  let isSyncedClient = false;

  const quitApp = () => {
    if (runner) {
      runner.cancel(state, () => {});
    }
    if (busServer) busServer.close();
    if (busClient) busClient.close();
    if (stopFileWatcher) stopFileWatcher();
    if (checkNewSessionTimer) clearInterval(checkNewSessionTimer);
    if (extraTtyStream) {
      try {
        extraTtyStream.setRawMode(false);
        extraTtyStream.destroy();
      } catch {
        // 무시
      }
    }
    screen.leave();
    process.exit(0);
  };

  const renderNow = () => {
    const { cols: rawCols, rows: rawRows } = screen.getSize();
    const cols = opts.colsOverride ?? rawCols;
    const rows = opts.rowsOverride ?? rawRows;
    const buf =
      opts.quad && opts.quadRole && opts.quadRole !== 'all'
        ? renderQuadRoleFrame(state, opts.quadRole, cols, rows)
        : renderFrame(state, cols, rows);
    screen.present(buf);
    if (busServer) {
      busServer.broadcast({ type: 'state', state });
    }
  };

  if (opts.isHub) {
    busServer = new QuadBusServer((msg) => {
      if (msg.type === 'action' && msg.action === 'prompt' && typeof msg.payload === 'string') {
        executePromptCommand(msg.payload, state, demoCtrl, {
          seekTo,
          renderNow,
          quitApp,
          liveHooks,
        });
      }
    });
    void busServer.start().catch(() => {
      // 소켓 바인드 실패 시 단독 모드로 동작
      busServer = null;
    });
  } else if (opts.quad && opts.quadRole && opts.quadRole !== 'argon') {
    busClient = new QuadBusClient((msg) => {
      if (msg.type === 'state' && msg.state) {
        isSyncedClient = true;
        Object.assign(state, msg.state);
        renderNow();
      }
    });
    busClient.connect();
  }

  const liveHooks: LivePromptHooks | undefined = runner
    ? {
        onLivePrompt: (text: string) => {
          void runner.runPrompt(text, state, renderNow);
        },
        onCarbonAsk: (q: string) => {
          runner.askCarbonAdvisor(q, state, renderNow);
        },
        onNeonVerify: (target: string) => {
          runner.askNeonVerify(target, state, renderNow);
        },
        onCancel: () => {
          runner.cancel(state, renderNow);
        },
        onNewSession: () => {
          state.conversationId = null;
          state.latestResponse = '';
          state.phase = '대기 중';
          appendLog(state, 'Argon', 'orange', '새 대화 세션이 초기화되었습니다');
          flashStatus(state, '새 대화 시작 (컨텍스트 초기화)');
          renderNow();
        },
      }
    : undefined;

  if (opts.mode === 'live' && runner) {
    if (runner.backend === 'none') {
      appendLog(
        state,
        'Carbon',
        'purple',
        '연결 가능한 백엔드(agy 또는 GEMINI_API_KEY)를 찾지 못했습니다'
      );
      flashStatus(state, 'agy 로그인 또는 GEMINI_API_KEY 설정이 필요합니다', 5000);
    } else {
      appendLog(
        state,
        'Argon',
        'orange',
        `백엔드 연결 준비 완료 (${runner.backend} · ${state.modelName})`
      );
      if (opts.initialPrompt) {
        void runner.runPrompt(opts.initialPrompt, state, renderNow);
      }
    }
  }

  // Herdr 활성 agy 터미널 실시간 감시 (--herdr-watch)
  if (opts.herdrWatch) {
    stopFileWatcher = attachHerdrWatcher(state, opts.herdrTerminals, renderNow);
    const label = opts.herdrTerminals ? opts.herdrTerminals.join(', ') : '전체 활성 agy';
    flashStatus(state, `Herdr 실시간 관제 연결: ${label}`, 5000);
  } else if (opts.watchMode || opts.mode === 'watch') {
    if (!opts.filePath) {
      opts.filePath = findLatestTranscriptPath(opts.watchDir ?? undefined);
    }
    if (opts.filePath) {
      stopFileWatcher = attachTranscriptWatcher(opts.filePath, state, renderNow);
      state.cwd = formatCompactPath(path.dirname(path.dirname(path.dirname(opts.filePath))));
      const sessShort = state.conversationId ? state.conversationId.slice(0, 8) : 'active';
      appendLog(state, 'Argon', 'orange', `세션 트랜스크립트 관제 연결됨 (${sessShort})`);
      flashStatus(state, `실시간 관제 연결: 세션 ${sessShort} (transcript.jsonl)`, 5000);
    } else {
      flashStatus(state, '활성 세션 트랜스크립트를 찾지 못했습니다. agy 실행 후 다시 시도하세요.', 6000);
    }

    if (opts.watchMode) {
      checkNewSessionTimer = setInterval(() => {
        const latest = findLatestTranscriptPath(opts.watchDir ?? undefined);
        if (latest && latest !== opts.filePath) {
          opts.filePath = latest;
          if (stopFileWatcher) stopFileWatcher();
          const sessShort = path.basename(path.dirname(path.dirname(latest))).slice(0, 8);
          flashStatus(state, `새 활성 세션 감지 및 자동 전환: ${sessShort}`);
          stopFileWatcher = attachTranscriptWatcher(latest, state, renderNow);
        }
      }, 2500);
    }
  } else if (opts.mode === 'stream') {
    if (opts.filePath) {
      stopFileWatcher = attachFileStream(
        opts.filePath,
        state,
        opts.follow,
        opts.replayMs,
        renderNow
      );
    } else if (!stdinIsTty) {
      attachStdinStream(state, renderNow);
      // 파이프 입력 중에도 로컬 터미널 키보드 조작이 가능하도록 /dev/tty 보조 연결 시도
      try {
        const ttyFd = fs.openSync('/dev/tty', 'r');
        extraTtyStream = new tty.ReadStream(ttyFd);
        extraTtyStream.setRawMode(true);
        extraTtyStream.on('data', (chunk: Buffer) => {
          for (const ev of parseKeyEvents(chunk)) {
            handleKey(ev);
          }
          renderNow();
        });
      } catch {
        // 비대화형 환경에서는 안전하게 무시
      }
    } else {
      flashStatus(state, 'LIVE STREAM 대기 중 (/help 로 사용법 확인)', 5000);
    }
  }

  const handleKey = (ev: KeyEvent) => {
    if (ev.kind === 'ctrl-c') {
      quitApp();
      return;
    }

    // 1. 프롬프트 입력 활성 모드 처리
    if (state.inputActive) {
      if (ev.kind === 'escape') {
        state.inputActive = false;
        return;
      }
      if (ev.kind === 'enter') {
        const submitted = state.inputValue;
        state.inputValue = '';
        state.inputActive = false;
        executePromptCommand(submitted, state, demoCtrl, seekTo, quitApp, liveHooks);
        return;
      }
      if (ev.kind === 'backspace') {
        const chars = Array.from(state.inputValue);
        chars.pop();
        state.inputValue = chars.join('');
        return;
      }
      if (ev.kind === 'char') {
        state.inputValue += ev.value;
        return;
      }
      return;
    }

    // 2. 모달이 열려 있을 때의 키 처리
    if (state.modal !== 'none') {
      if (ev.kind === 'escape' || (ev.kind === 'char' && ev.value === 'q')) {
        state.modal = 'none';
        return;
      }
      if (state.modal === 'logs') {
        const filteredLen = getFilteredLogs(state).length;
        if (ev.kind === 'arrow' && ev.dir === 'up') {
          state.logScrollOffset = Math.min(Math.max(0, filteredLen - 3), state.logScrollOffset + 1);
        } else if (ev.kind === 'arrow' && ev.dir === 'down') {
          state.logScrollOffset = Math.max(0, state.logScrollOffset - 1);
        }
      }
      if (state.modal === 'response') {
        if (ev.kind === 'arrow' && ev.dir === 'up') {
          state.responseScrollOffset = Math.max(0, state.responseScrollOffset - 1);
        } else if (ev.kind === 'arrow' && ev.dir === 'down') {
          state.responseScrollOffset += 1;
        } else if (ev.kind === 'page' && ev.dir === 'up') {
          state.responseScrollOffset = Math.max(0, state.responseScrollOffset - 10);
        } else if (ev.kind === 'page' && ev.dir === 'down') {
          state.responseScrollOffset += 10;
        } else if (ev.kind === 'char' && (ev.value === '/' || ev.value === 'i')) {
          state.modal = 'none';
          state.inputActive = true;
          if (ev.value === '/') state.inputValue = '/';
          return;
        }
      }
      if (ev.kind === 'char') {
        applyFilterShortcut(ev.value);
      }
      return;
    }

    // 3. 기본 관제 네비게이션 모드 처리
    if (ev.kind === 'tab') {
      cycleFocus(state, ev.shift);
      return;
    }

    if (ev.kind === 'enter') {
      switch (state.focus) {
        case 'advisor':
          state.modal = 'advisor';
          break;
        case 'main':
          state.inputActive = true;
          break;
        case 'neon':
          state.modal = 'neon';
          break;
        case 'decision':
          state.modal = 'decision';
          break;
        case 'swarm':
          state.modal = 'swarm';
          break;
        case 'logs':
          state.modal = 'logs';
          break;
      }
      return;
    }

    if (ev.kind === 'arrow') {
      if (ev.dir === 'up') {
        const maxOff = Math.max(0, getFilteredLogs(state).length - 3);
        state.logScrollOffset = Math.min(maxOff, state.logScrollOffset + 1);
      } else if (ev.dir === 'down') {
        state.logScrollOffset = Math.max(0, state.logScrollOffset - 1);
      } else if (ev.dir === 'left' && state.mode === 'demo') {
        const cur = state.simTime;
        state.paused = true;
        seekTo(cur - 2);
        flashStatus(state, `타임라인 ◀ t=${state.simTime.toFixed(1)}s (일시정지)`);
      } else if (ev.dir === 'right' && state.mode === 'demo') {
        const cur = state.simTime;
        state.paused = true;
        seekTo(cur + 2);
        flashStatus(state, `타임라인 ▶ t=${state.simTime.toFixed(1)}s (일시정지)`);
      }
      return;
    }

    if (ev.kind === 'char') {
      const ch = ev.value;
      if (ch === 'q') {
        quitApp();
        return;
      }
      if (ch === '?' || ch === 'h') {
        state.modal = 'help';
        return;
      }
      if (ch === '/' || ch === 'i') {
        state.inputActive = true;
        if (ch === '/') state.inputValue = '/';
        return;
      }
      if (ch === ' ') {
        if (state.mode === 'demo') {
          if (state.paused) {
            baseWallMs = Date.now();
            timeOffsetSec = state.simTime;
            state.paused = false;
            flashStatus(state, '▶ 데모 재생 재개');
          } else {
            timeOffsetSec = state.simTime;
            state.paused = true;
            flashStatus(state, '⏸ 데모 일시정지 (←/→ 탐색 가능)');
          }
        }
        return;
      }
      if (ch === 's') {
        state.modal = 'swarm';
        return;
      }
      if (ch === 'n') {
        state.modal = 'neon';
        return;
      }
      if (ch === 'c') {
        state.modal = 'advisor';
        return;
      }
      if (ch === 'd') {
        state.modal = 'decision';
        return;
      }
      if (ch === 'l') {
        state.modal = 'logs';
        return;
      }
      if (ch === 'r') {
        state.modal = 'response';
        return;
      }

      // Compact 레이아웃일 경우 1~4는 탭 전환을 겸함
      const { cols, rows } = screen.getSize();
      const curLayout = computeLayout(opts.colsOverride ?? cols, opts.rowsOverride ?? rows);
      if (curLayout.kind === 'compact' && (ch === '1' || ch === '2' || ch === '3' || ch === '4')) {
        state.compactTab = (Number(ch) - 1) as CompactTab;
        return;
      }

      applyFilterShortcut(ch);
    }
  };

  const applyFilterShortcut = (ch: string) => {
    if (ch === '0') {
      state.logFilter = 'all';
      state.logScrollOffset = 0;
      flashStatus(state, '로그 필터 해제 (전체 보기)');
    } else if (ch === '1') {
      state.logFilter = state.logFilter === 'argon' ? 'all' : 'argon';
      state.logScrollOffset = 0;
      flashStatus(state, `로그 필터: ${state.logFilter}`);
    } else if (ch === '2') {
      state.logFilter = state.logFilter === 'hydrogen' ? 'all' : 'hydrogen';
      state.logScrollOffset = 0;
      flashStatus(state, `로그 필터: ${state.logFilter}`);
    } else if (ch === '3') {
      state.logFilter = state.logFilter === 'decision' ? 'all' : 'decision';
      state.logScrollOffset = 0;
      flashStatus(state, `로그 필터: ${state.logFilter}`);
    } else if (ch === '4') {
      state.logFilter = state.logFilter === 'neon' ? 'all' : 'neon';
      state.logScrollOffset = 0;
      flashStatus(state, `로그 필터: ${state.logFilter}`);
    } else if (ch === '5') {
      state.logFilter = state.logFilter === 'carbon' ? 'all' : 'carbon';
      state.logScrollOffset = 0;
      flashStatus(state, `로그 필터: ${state.logFilter}`);
    }
  };

  if (stdinIsTty) {
    process.stdin.on('data', (chunk: Buffer) => {
      for (const ev of parseKeyEvents(chunk)) {
        handleKey(ev);
      }
      renderNow();
    });
  }

  process.stdout.on('resize', () => {
    screen.invalidate();
    renderNow();
  });

  // 80ms (약 12.5fps) 애니메이션 루프 — 와이어 펄스 및 시뮬레이션 시간 갱신
  setInterval(() => {
    if (isSyncedClient) return;
    state.tickCount += 1;
    if (state.mode === 'demo') {
      if (!state.paused) {
        const elapsed = (Date.now() - baseWallMs) / 1000;
        applyDemoTime(state, timeOffsetSec + elapsed, demoCtrl);
      }
    } else {
      // 라이브 스트림 모드에서도 와이어 흐름과 커서 점멸이 살아 움직이도록 시간 전진
      state.simTime += 0.08;
    }
    renderNow();
  }, 80);

  renderNow();
}

main();
