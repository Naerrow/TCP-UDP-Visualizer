# TCP Visualizer

Node.js `net` 소켓으로 실제 TCP 연결을 만들고, 브라우저에서 그 과정을 단계별로 시각화하는 프로젝트다.

이 프로젝트는 UDP 비교가 아니라 TCP 자체를 정확히 이해하는 데 집중한다.

## What This Project Explains

- 서버 측 `bind -> listen -> accept wait`
- 클라이언트 측 `connect()`
- `connect()` 뒤에서 커널이 수행하는 `SYN -> SYN-ACK -> ACK`
- handshake 완료 후 `connect() returned`와 `accept() returned`가 각각 무엇을 의미하는지
- `ESTABLISHED` 상태 이후의 바이트 스트림 송수신
- 클라이언트의 여러 `write()`가 서버의 한 번 `read()`로 합쳐질 수 있다는 점
- `close()` 이후 half-close와 full close 흐름

## Accuracy Model

이 프로젝트는 실제 TCP 소켓을 사용한다. 다만 Wireshark처럼 커널 내부 패킷을 직접 캡처하는 도구는 아니다.

화면은 다음 두 층을 연결해서 설명한다.

- 애플리케이션이 직접 관찰하는 소켓 API 단계: `listen()`, `accept()`, `connect()`, `read()`, `close()`
- 그 API 뒤에서 TCP 스택이 수행하는 개념 단계: `SYN`, `SYN-ACK`, `ACK`, `FIN`

즉, 이 데모는 “앱에서 무엇이 보이고, 그 순간 TCP는 내부적으로 무엇을 하고 있는가”를 설명하는 교육용 시각화다.

## Run

```bash
npm start
```

브라우저에서 `http://127.0.0.1:3000`에 접속한다.

포트 충돌이 있으면 다른 포트로 실행할 수 있다.

```bash
PORT=3004 TCP_PORT=4110 npm start
```

## Verify

서버를 실행한 상태에서 아래 명령으로 TCP 흐름을 검증할 수 있다.

```bash
npm run verify
```

검증 스크립트는 `start/next` API 응답에 담긴 이벤트를 모아 다음 핵심 단계가 모두 발생하는지 확인한다.

- `BIND`
- `LISTEN + ACCEPT WAIT`
- `connect()`
- `SYN`
- `SYN-ACK`
- `ACK`
- `connect() returned`
- `accept() returned`
- `ESTABLISHED`
- `write #1 / 4B`
- `write #2 / 4B`
- `APP WRITES x2 / 2 records`
- `read #N / ...B`
- `READ BUFFER / ...`
- `close() / FIN`
- `FIN RECEIVED / ACK IMPLIED`
- `server close() / FIN`
- `FINAL ACK IMPLIED / CLOSED`

## API Response Fields

`POST /demo/tcp/start`와 `POST /demo/tcp/next`는 아래와 같은 JSON을 반환한다.

```json
{
  "ok": true,
  "protocol": "tcp",
  "completed": true,
  "events": [
    {
      "protocol": "TCP",
      "session": "tcp-1773990348805",
      "type": "session",
      "phase": "complete",
      "title": "TCP session completed",
      "detail": "connect() 호출부터 SYN, SYN-ACK, ACK, connect() 반환, accept() 반환, ESTABLISHED, 데이터 송수신, 종료까지 확인했다.",
      "controls": {
        "canAdvance": false,
        "completed": true
      },
      "id": "1773992202885-dd36ba",
      "at": "2026-03-20T07:36:42.886Z"
    }
  ]
}
```

최상위 응답 필드:

- `ok`
  요청이 정상 처리됐는지 나타낸다.
- `protocol`
  어떤 데모 프로토콜에 대한 응답인지 나타낸다. 현재는 항상 `tcp`다.
- `completed`
  이번 단계 실행 후 TCP 데모가 종료됐는지 나타낸다.
- `events`
  이번 `start` 또는 `next` 호출로 인해 발생한 이벤트 목록이다.

이벤트 객체 필드:

- `protocol`
  이 이벤트가 어떤 프로토콜 데모에 속하는지 나타낸다. 현재는 `TCP`다.
- `session`
  하나의 데모 실행을 식별하는 고유 ID다. 같은 실행에서 나온 이벤트는 같은 `session` 값을 가진다.
- `type`
  이벤트 종류다. 예를 들어 `handshake`, `syscall`, `accept`, `data`, `read`, `response`, `close`, `session`, `state` 같은 값이 올 수 있다.
- `phase`
  `type`이 `session`일 때 세션의 시작인지 종료인지 나타낸다. 예: `start`, `complete`
- `title`
  이벤트 제목이다. 주로 세션 시작/종료 같은 큰 이벤트에 사용된다.
- `label`
  짧은 상태 요약이다. 예: `SYN`, `ACK`, `accept() returned`, `write #1 / 4B`, `read #1 / 8B`
- `detail`
  사람이 읽기 위한 상세 설명이다. 타임라인 본문에 표시된다.
- `message`
  실제 payload나 읽은 데이터처럼, 이벤트와 연결된 데이터 본문이다.
- `bytes`
  데이터 길이를 바이트 단위로 나타낸다.
- `from`
  이벤트가 시작된 쪽이다. 예: `client`, `server`
- `to`
  이벤트가 향한 쪽이다. 예: `server`, `client`
- `side`
  패킷 이동이 아니라 특정 쪽에서 관찰된 상태 이벤트일 때 사용한다. 예: `server`, `both`
- `controls`
  프런트 UI 제어를 위한 정보다.
- `controls.canAdvance`
  다음 단계 버튼을 눌러도 되는지 나타낸다.
- `controls.completed`
  이 이벤트 시점에서 데모가 끝났는지 나타낸다.
- `id`
  이벤트 객체 자체의 고유 ID다.
- `at`
  이벤트가 생성된 시각이다. UTC 기준 ISO 8601 문자열 형식이다.

## Portfolio Description

짧은 소개 문구:

> Node.js `net` 소켓으로 실제 TCP 연결을 만들고, `bind`, `listen`, `accept`, `connect()`, 3-way handshake, 데이터 전송, 종료 흐름을 웹 UI에서 단계별로 시각화한 학습용 네트워크 데모입니다.

긴 소개 문구:

> TCP를 단순한 텍스트 설명이 아니라 실제 코드와 시각화로 이해하기 위해 만든 프로젝트입니다. Node.js 내장 `net` 모듈로 TCP 서버와 클라이언트를 직접 실행하고, 서버의 `bind -> listen -> accept wait`, 클라이언트의 `connect()`, 그 뒤에서 커널이 수행하는 `SYN -> SYN-ACK -> ACK`, `connect() returned`와 `accept() returned`, `ESTABLISHED` 이후의 바이트 스트림 송수신, 그리고 `write()` 두 번이 서버의 한 번 또는 여러 번 `read()`로 관찰될 수 있다는 점, `close()`에 따른 half-close와 full close까지를 브라우저 타임라인과 패킷 애니메이션으로 단계별 설명합니다.
