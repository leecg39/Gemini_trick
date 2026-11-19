import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendLog, formatCompactPath, formatNowHHMMSS } from '../state/store.ts';
import type { AppState, SwarmCard, SwarmWorker } from '../types.ts';

interface HcTerminalInfo {
  address: string;
  agent?: string;
  cwd?: string;
  state?: string;
  status?: 'idle' | 'working' | 'done' | 'blocked' | 'error' | string;
  turn?: number;
  where?: string;
  name?: string;
}

function resolveHcBin(): string {
  const which = spawnSync('which', ['hc'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = path.join(os.homedir(), '.local/bin/hc');
  if (fs.existsSync(fallback)) return fallback;
  return 'hc';
}

const HC_BIN = resolveHcBin();

function execAsync(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: 'utf8', timeout: 3000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

function extractLastMeaningfulLine(screenText: string): string {
  const lines = screenText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith('[hc]') &&
        !l.startsWith('? for shortcuts') &&
        !l.startsWith('esc to dismiss') &&
        !l.startsWith('───') &&
        !l.startsWith('━━━')
    );
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.startsWith('>') && l.length <= 3) continue;
    if (l.includes('Auto mode:')) continue;
    return l.slice(0, 120);
  }
  return '';
}

export function attachHerdrWatcher(
  state: AppState,
  targetTerminals: string[] | null,
  onUpdate: () => void
): () => void {
  let stopped = false;
  let busy = false;
  const prevStatus = new Map<string, string>();
  const prevTurn = new Map<string, number>();
  const lastSnippet = new Map<string, string>();

  state.mode = 'watch';
  state.phase = '실시간 관제';
  state.mainSummary = 'Herdr 활성 agy 세션 스캔 중…';
  state.backSummary = '실제 실행 중인 터미널 상태를 실시간으로 반영합니다';
  state.neonSummary = '대기 중 · Neon 패널 상태 감시';
  state.latestAdvice = '» Carbon 패널 상태 감시 중';
  state.logs = [];
  state.adviceHistory = [];
  state.neonHistory = [];

  const poll = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const raw = await execAsync(HC_BIN, ['ls', '--json']);
      const parsed = JSON.parse(raw) as { terminals?: HcTerminalInfo[] };
      const allTerms = (parsed.terminals ?? []).filter((t) => t.state === 'live');

      // 지정된 터미널 목록이 있으면 우선 선택, 없으면 모든 live antigravity/코딩 에이전트 선택
      let watched: HcTerminalInfo[];
      if (targetTerminals && targetTerminals.length > 0) {
        const byAddr = new Map(allTerms.map((t) => [t.address, t]));
        watched = targetTerminals
          .map((addr) => byAddr.get(addr))
          .filter((t): t is HcTerminalInfo => Boolean(t));
      } else {
        watched = allTerms.filter(
          (t) => t.agent === 'antigravity' || t.agent === 'claude-code' || t.agent === 'codex'
        );
      }

      // 역할 매핑 (0: Argon, 1: Carbon, 2: Neon, 3: Hydrogen)
      const argonT = watched[0];
      const carbonT = watched[1];
      const neonT = watched[2];
      const hydrogenT = watched[3];

      // 화면 스니펫 비동기 읽기 (최대 4개)
      const roleTerms = [argonT, carbonT, neonT, hydrogenT].filter(
        (t): t is HcTerminalInfo => Boolean(t)
      );
      await Promise.all(
        roleTerms.map(async (t) => {
          const st = t.status ?? 'idle';
          const tr = t.turn ?? 0;
          const changed = prevStatus.get(t.address) !== st || prevTurn.get(t.address) !== tr;
          if (changed || st === 'working' || !lastSnippet.has(t.address)) {
            try {
              const txt = await execAsync(HC_BIN, ['read', '--lines', '0', t.address]);
              const line = extractLastMeaningfulLine(txt);
              if (line) lastSnippet.set(t.address, line);
            } catch {
              // 읽기 실패 무시
            }
          }
        })
      );

      // 상태 변화 로그 기록
      const roleMeta: Array<{ term?: HcTerminalInfo; name: string; color: 'orange' | 'purple' | 'neon' | 'blue' }> = [
        { term: argonT, name: 'Argon', color: 'orange' },
        { term: carbonT, name: 'Carbon', color: 'purple' },
        { term: neonT, name: 'Neon', color: 'neon' },
        { term: hydrogenT, name: 'Hydrogen', color: 'blue' },
      ];

      for (const rm of roleMeta) {
        if (!rm.term) continue;
        const addr = rm.term.address;
        const st = rm.term.status ?? 'idle';
        const tr = rm.term.turn ?? 0;
        const oldSt = prevStatus.get(addr);
        const oldTr = prevTurn.get(addr);

        if (oldSt !== st || oldTr !== tr) {
          prevStatus.set(addr, st);
          prevTurn.set(addr, tr);
          const snippet = lastSnippet.get(addr);
          const desc = snippet ? ` — ${snippet}` : '';
          if (oldSt !== undefined) {
            appendLog(state, rm.name, rm.color, `[${addr}] ${st} (turn ${tr})${desc}`);
          } else {
            appendLog(state, rm.name, rm.color, `[${addr}] 관제 연결됨 (${st}, turn ${tr})`);
          }
        }
      }

      // 상단 메트릭 & 각 계층 상태 업데이트 (실제 값만 사용)
      const workingCount = watched.filter((t) => t.status === 'working').length;
      const doneCount = watched.filter((t) => t.status === 'done').length;
      const totalWatched = watched.length;

      state.agentBusy = workingCount > 0;
      state.cwd = argonT?.cwd ? formatCompactPath(argonT.cwd) : state.cwd;
      state.argonBuilds = argonT?.turn ?? 0;
      state.carbonCalls = carbonT?.turn ?? 0;
      state.neonVerified = neonT?.turn ?? 0;
      state.totalForks = watched.reduce((acc, t) => acc + (t.turn ?? 0), 0);

      // Argon 메인 패널
      if (argonT) {
        const st = argonT.status ?? 'idle';
        state.phase = st === 'working' ? '실행 중' : st === 'blocked' ? '승인 대기' : st === 'done' ? '턴 완료' : '입력 대기';
        state.mainSummary =
          lastSnippet.get(argonT.address) ||
          `[${argonT.address}] ${argonT.agent ?? 'agy'} · ${st} (turn ${argonT.turn ?? 0})`;
      } else {
        state.phase = '연결 대기';
        state.mainSummary = 'Herdr에 실행 중인 agy 터미널을 찾는 중…';
      }

      // Carbon 자문 패널
      if (carbonT) {
        const st = carbonT.status ?? 'idle';
        state.advisorState = st === 'working' ? '자문 중' : '대기 중';
        state.activeTrigger = st === 'working' ? 0 : -1;
        state.latestAdvice = `» [${carbonT.address}] ${lastSnippet.get(carbonT.address) || `${st} (turn ${carbonT.turn ?? 0})`}`;
      }

      // Neon 교차 검증 패널
      if (neonT) {
        const st = neonT.status ?? 'idle';
        state.neonState = st === 'working' ? 'run' : st === 'error' ? 'fail' : st === 'done' ? 'pass' : 'idle';
        state.neonProgress = st === 'working' ? 65 : st === 'done' ? 100 : 0;
        state.neonLabel = `Neon (${neonT.address})`;
        state.neonSummary =
          lastSnippet.get(neonT.address) || `${st} · turn ${neonT.turn ?? 0}`;
      }

      // Decision 1 라우팅 확률 (실제 활성 상태 비율 반영)
      const activeRatio = totalWatched > 0 ? Math.max(0.2, workingCount / totalWatched) : 0;
      const doneRatio = totalWatched > 0 ? Math.max(0.2, (doneCount + workingCount) / totalWatched) : 0;
      state.routes = [
        { name: '활성 에이전트', p: Number(activeRatio.toFixed(2)) },
        { name: '작업 진행률', p: Number(doneRatio.toFixed(2)) },
        { name: '세션 안정성', p: watched.some((t) => t.status === 'error') ? 0.35 : 0.95 },
      ];

      // Hydrogen 스웜 카드 & 워커 (실제 터미널 목록)
      state.swarmActive = workingCount;
      state.swarmMax = Math.max(4, totalWatched);
      const cards: SwarmCard[] = roleMeta
        .filter((rm) => rm.term)
        .slice(0, 3)
        .map((rm) => {
          const t = rm.term!;
          const st = t.status ?? 'idle';
          return {
            name: `${rm.name} (${t.address})`,
            model: t.agent ?? 'agy',
            progress: st === 'working' ? 60 : st === 'done' ? 100 : 0,
            description: lastSnippet.get(t.address) || `${st} · turn ${t.turn ?? 0}`,
            status: st === 'working' ? 'running' : st === 'done' ? 'done' : st === 'error' ? 'error' : 'idle',
          };
        });
      if (cards.length > 0) {
        state.cards = cards;
      }

      const workers: SwarmWorker[] = watched.map((t, idx) => {
        const st = t.status ?? 'idle';
        return {
          id: idx + 1,
          role: idx === 0 ? 'search' : idx === 1 ? 'audit' : idx === 2 ? 'verify' : 'grep',
          target: `${t.address} (${t.where ?? t.agent ?? 'agy'})`,
          progress: st === 'working' ? 65 : st === 'done' ? 100 : 0,
          status: st === 'working' ? 'running' : st === 'done' ? 'done' : 'idle',
        };
      });
      state.workers = workers;

      state.backSummary = `실시간 Herdr 관제 · 활성 ${workingCount}/${totalWatched} · ${formatNowHHMMSS()}`;
      onUpdate();
    } catch {
      // hc 조회 실패 시 다음 주기에 재시도
    } finally {
      busy = false;
    }
  };

  void poll();
  const timer = setInterval(() => {
    void poll();
  }, 1200);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
