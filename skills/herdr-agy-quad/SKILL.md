---
name: herdr-agy-quad
description: "Herdr App에서 4개의 분할 터미널 창에 'agy --dangerously-skip-permissions'를 실행해 코딩을 수행하고, 동시에 다른 패널(또는 별도 탭)에 5계층 통합 TUI(--watch)를 띄워 실제 작업 진행을 실시간 관제하는 스킬. 사용자가 4분할 agy 코딩 실행 + 통합 TUI 실시간 관제를 요청할 때 사용한다."
---

# Herdr AGY 4-Split Coding + Unified TUI Monitor

Herdr App에서 자동으로 터미널을 분할하여 **4개의 `agy --dangerously-skip-permissions` 코딩 세션**을 띄우고, 동시에 **처음 제작한 5계층 통합 TUI 대시보드(`node ./src/cli.ts --watch`)**를 띄워 실제 `agy` 작업(`transcript.jsonl`)을 실시간으로 관제하는 스킬입니다.

## 화면 배치 구조

### 1. 기본 모드 (`--layout split`): 한 화면 동시 관제 (5패널)
```text
┌───────────────────┬───────────────────┬──────────────────────────────────┐
│ agy #1            │ agy #2            │                                  │
│ --dangerously-... │ --dangerously-... │   5계층 통합 TUI 실시간 관제      │
├───────────────────┼───────────────────┤   (node ./src/cli.ts --watch)    │
│ agy #3            │ agy #4            │   실제 agy 세션 자동 감지·표시    │
│ --dangerously-... │ --dangerously-... │                                  │
└───────────────────┴───────────────────┴──────────────────────────────────┘
```

### 2. 탭 분리 모드 (`--layout tabs`): 2개 탭 구성
- **탭 1 (`Coding · 4× agy`)**: 2×2 4분할로 `agy --dangerously-skip-permissions` 4개 실행
- **탭 2 (`Monitor · TUI`)**: 전체 화면으로 `node ./src/cli.ts --watch` 실행

## 실행 방법

### 기본 실행 (한 화면 4분할 `agy` + 우측 통합 TUI 관제)
```bash
node /Users/user01/Desktop/Gemini_trick/scripts/herdr-agy-quad-watch.ts --folder "$(pwd)"
```

### 탭 분리 실행 (화면이 좁거나 통합 TUI를 전체 화면으로 보고 싶을 때)
```bash
node /Users/user01/Desktop/Gemini_trick/scripts/herdr-agy-quad-watch.ts --layout tabs --folder "$(pwd)"
```

### 주요 옵션
- `--folder <path>`: `agy`가 코딩을 수행할 프로젝트 폴더 (기본: 현재 디렉터리)
- `--models <m1,m2,m3,m4>`: 각 패널별 모델 지정 (쉼표 구분)
- `--prompts <p1|p2|p3|p4>`: 각 패널 시작 시 전달할 초기 인터랙티브 프롬프트 (`|` 구분)
- `--name <title>`: 생성할 탭 이름
- `--dry-run`: 실행하지 않고 명령어만 확인

## 프로젝트 내 npm 스크립트
`/Users/user01/Desktop/Gemini_trick`에서 다음 명령으로도 실행할 수 있습니다:
- `npm run herdr:agy`
- `npm run herdr:agy:tabs`
