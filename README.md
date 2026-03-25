# TCP/UDP Visualizer + Real TCP Lab

Node.js `net` / `dgram` 소켓으로 TCP와 UDP를 학습하고, 실제 TCP 실험까지 할 수 있는 프로젝트다.

- `TCP 학습용 데모`
  TCP 연결 과정을 단계별 학습용 이벤트로 시각화한다.
- `UDP 학습용 데모`
  UDP datagram 송수신 과정을 단계별 학습용 이벤트로 시각화한다.
- `Real TCP Lab`
  실제 TCP 서버와 실제 TCP 클라이언트를 실행하고, 송수신/FIN/close/error를 로그 파일과 라이브 UI에 남긴다.

즉, 이 프로젝트는 "TCP/UDP 개념 학습용 화면"과 "실제 TCP 실험실"을 함께 제공한다.

## Project Modes

### 1. TCP 학습용 데모

브라우저에서 `bind`, `listen`, `accept`, `connect()`, 3-way handshake, 데이터 송수신, 종료 흐름을 단계별로 설명하는 학습용 페이지다.

이 모드는 TCP를 이해하기 쉽게 보여주기 위한 재구성된 타임라인이며, Wireshark처럼 실제 패킷을 직접 캡처해서 보여주는 도구는 아니다.

### 2. UDP 학습용 데모

브라우저에서 `bind`, `recvfrom` 대기, datagram 전송과 수신, 응답, 종료 흐름을 단계별로 설명하는 학습용 페이지다.

이 모드는 UDP가 왜 비연결형 프로토콜인지, 왜 datagram 경계가 유지되는지 이해하기 쉽게 보여주기 위한 재구성된 타임라인이다.

### 3. Real TCP Lab

상단 탭의 `Real TCP Lab` 페이지에서는 실제 Node TCP 서버를 열고, 실제 Node TCP 클라이언트를 붙일 수 있다.

이 페이지에서는 아래를 실제로 확인할 수 있다.

- listener가 실제로 열리는지
- 어떤 local/remote address, port로 연결됐는지
- 어떤 소켓이 몇 바이트를 썼고 읽었는지
- `socket.end()` 이후 FIN 관련 이벤트가 어떻게 보이는지
- 로그 파일에 어떤 기록이 남는지
- `nc`, `lsof`, `tcpdump`, Wireshark 같은 외부 도구로도 같은 연결을 볼 수 있는지

## What This Project Explains

### TCP 학습용 데모

- 서버 측 `bind -> listen -> accept wait`
- 클라이언트 측 `connect()`
- `connect()` 뒤에서 커널이 수행하는 `SYN -> SYN-ACK -> ACK`
- handshake 완료 후 `connect() returned`와 `accept() returned`
- `ESTABLISHED` 상태 이후의 바이트 스트림 송수신
- 클라이언트의 여러 `write()`가 서버의 한 번 `read()`로 합쳐질 수 있다는 점
- `close()` 이후 half-close와 full close 흐름

### UDP 학습용 데모

- 서버 측 `bind -> recvfrom wait`
- 클라이언트 측 `socket() + bind()`
- `NO HANDSHAKE / NO ACCEPT`
- datagram 2회 전송과 `recvfrom()` 2회 수신
- datagram 경계 유지
- 응답 datagram 전송과 수신
- `close()` 시 FIN 기반 종료 절차가 없다는 점

### Real TCP Lab

- 실제 `net.createServer()` listener
- 실제 `net.Socket()` 연결
- 실제 `socket.write()`와 반대편의 `data`
- 실제 `socket.end()`와 `end` / `close`
- 실제 local/remote endpoint 추적
- 실제 로그 파일 누적

## Accuracy Model

이 프로젝트는 두 층으로 나뉜다.

### 학습용 데모의 정확성 기준

TCP 페이지는 실제 TCP 소켓을 사용하지만, `SYN`, `SYN-ACK`, `ACK`, `FIN`은 학습용 개념 이벤트로 설명한다.

UDP 페이지는 실제 UDP 소켓을 사용하지만, localhost에서 datagram이 잘 도착하는 이번 실행 결과를 바탕으로 UDP의 비연결성과 datagram 경계를 설명하는 시각화다.

### Real TCP Lab의 정확성 기준

이 페이지는 실제 TCP 서버와 실제 TCP 클라이언트를 실행한다.

다만 이 화면도 패킷 캡처기 자체는 아니다. 브라우저는 raw TCP를 직접 열지 못하므로, 실제 TCP 소켓은 Node 서버 프로세스가 관리하고 브라우저는 그 결과를 제어/표시한다.

따라서 `Real TCP Lab`에서 보는 `write`, `data`, `end`, `close`는 실제 소켓 이벤트이며, 패킷 레벨은 `tcpdump`나 Wireshark로 추가 확인하면 된다.

## Run

```bash
npm start
```

브라우저에서 `http://127.0.0.1:3000`에 접속한다.

환경변수:

- `PORT`
  웹 UI 포트. 기본값은 `3000`
- `TCP_PORT`
  TCP 학습용 데모에서 사용하는 내부 TCP 포트. 기본값은 `4100`
- `UDP_PORT`
  UDP 학습용 데모에서 사용하는 내부 UDP 포트. 기본값은 `4300`
- `TCP_LAB_PORT`
  `Real TCP Lab`의 기본 listener 포트. 기본값은 `4200`

포트 충돌이 있으면 예를 들어 이렇게 실행할 수 있다.

```bash
PORT=3004 TCP_PORT=4110 UDP_PORT=4310 TCP_LAB_PORT=4210 npm start
```

## Verify

TCP/UDP 학습용 데모는 아래 명령으로 검증할 수 있다.

```bash
npm run verify
```

검증 스크립트는 `start/next` API 응답에 담긴 이벤트를 모아 다음 핵심 단계가 모두 발생하는지 확인한다.

TCP 검증 항목:

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

UDP 검증 항목:

- `BIND`
- `RECVFROM WAIT`
- `socket() + bind()`
- `NO HANDSHAKE / NO ACCEPT`
- `send() #1 / 4B`
- `recvfrom() #1 / 4B`
- `send() #2 / 4B`
- `recvfrom() #2 / 4B`
- `DATAGRAM BOUNDARIES PRESERVED`
- `send() reply / ...`
- `recvfrom() reply / ...`
- `close() / NO FIN`

## How To Use

### A. TCP 학습용 데모 사용법

1. 브라우저에서 `/` 페이지를 연다.
2. `TCP 시작`을 누른다.
3. `다음 단계`를 계속 누르면서 단계별 이벤트를 본다.
4. 아래 타임라인에서 `connect()`, `SYN`, `SYN-ACK`, `ACK`, `accept() returned`, `ESTABLISHED`, `write`, `read`, `close()` 흐름을 확인한다.

이 모드는 학습용이므로, 화면에 보이는 handshake 이벤트는 실제 패킷을 직접 캡처한 결과가 아니라 학습용 설명 순서다.

### B. UDP 학습용 데모 사용법

1. 브라우저에서 `/udp-demo.html` 페이지를 연다.
2. `UDP 시작`을 누른다.
3. `다음 단계`를 계속 누르면서 단계별 이벤트를 본다.
4. 아래 타임라인에서 `send()`, `recvfrom()`, `DATAGRAM BOUNDARIES PRESERVED`, `close() / NO FIN` 흐름을 확인한다.

이 모드는 UDP가 TCP처럼 연결을 수립하지 않고 datagram 단위로 동작한다는 점을 학습시키기 위한 설명용 화면이다.

### C. Real TCP Lab 빠른 사용법

1. 상단 탭에서 `Real TCP Lab`로 이동한다.
2. `바인드 호스트`에 `127.0.0.1`, `포트`에 `4200`을 둔다.
3. `서버 시작`을 누른다.
4. 상태 줄에 `127.0.0.1:4200 에서 실제 TCP 리스너가 열려 있다.`가 보이면 실제 TCP 리스너가 열린 것이다.
5. `클라이언트 연결`을 누른다.
6. `소켓 현황`에 보통 아래 두 소켓이 생긴다.
   - `클라이언트 소켓`
   - `서버 소켓`
7. `소켓 제어`에서 소켓 하나를 선택한다.
8. 메시지를 입력하고 `메시지 전송`을 누른다.
9. `실시간 소켓 로그`에서 실제 `전송`과 반대편 `수신`을 확인한다.

### D. Real TCP Lab에서 무엇을 보는가

#### 소켓 현황

- `ID`
  소켓 식별자
- `Role`
  `클라이언트 소켓` 또는 `서버 소켓`
- `Status`
  `open`, `ending`, `half-closed`, `closed` 등
- `Local`
  내 주소와 포트
- `Remote`
  상대 주소와 포트
- `Bytes In`
  읽은 누적 바이트
- `Bytes Out`
  쓴 누적 바이트

#### 실시간 소켓 로그

주요 로그 의미:

- `accepted`
  서버가 실제 TCP 연결을 수락함
- `write`
  해당 소켓이 실제 바이트를 보냄
- `data`
  반대편 소켓이 실제 바이트를 받음
- `end-request`
  `socket.end()` 호출로 FIN 전송 시작
- `end`
  상대 FIN을 관찰함
- `close`
  소켓이 닫힘
- `error`
  연결 오류

### E. 추천 실습: 브라우저 + netcat

이 조합이 가장 직관적이다.

1. `Real TCP Lab`에서 `서버 시작`
2. 별도 터미널에서 아래 명령 실행

```bash
nc 127.0.0.1 4200
```

3. 터미널에 문자열 입력 후 엔터
4. 브라우저 `실시간 소켓 로그`에서 `연결 수락`, `수신` 확인
5. 브라우저에서 `서버 소켓` 선택
6. 메시지를 입력하고 `메시지 전송`
7. 터미널 `nc` 창에서 응답 확인
8. 브라우저에서 `정상 종료 시작` 또는 `소켓 강제 종료`로 종료 과정 확인

즉:

- 외부 클라이언트 역할은 `nc`
- 서버 제어와 관찰은 브라우저 `Real TCP Lab`

### F. 추천 실습: 브라우저만으로 확인

1. `서버 시작`
2. `클라이언트 연결`
3. `클라이언트 소켓` 선택 후 `메시지 전송`
4. 로그에서 `클라이언트 소켓 전송`과 `서버 소켓 수신` 확인
5. `서버 소켓` 선택 후 응답 전송
6. 로그에서 `서버 소켓 전송`과 `클라이언트 소켓 수신` 확인
7. `정상 종료 시작`으로 종료 흐름 확인

## Logs And External Tools

### 1. 로그 파일 확인

실제 기록은 `logs/tcp-lab.ndjson`에 남는다.

```bash
tail -f logs/tcp-lab.ndjson
```

이 파일은 줄마다 JSON 1개인 NDJSON 형식이다.

### 2. listening socket 확인

```bash
lsof -n -P -iTCP:4200
```

### 3. 패킷 캡처 확인

macOS:

```bash
sudo tcpdump -i lo0 -nn tcp port 4200
```

Linux:

```bash
sudo tcpdump -i lo -nn tcp port 4200
```

Wireshark를 쓰는 경우에도 같은 포트를 필터링하면 된다.

### 4. tcpdump에서 무엇을 보면 되는가

보통 아래 플래그를 본다.

- `[S]`
  SYN. 연결 시작
- `[S.]`
  SYN-ACK. 서버의 수락 응답
- `[.]`
  ACK. 확인 응답
- `[P.]`
  payload가 있는 데이터 전송이 자주 이렇게 보인다
- `[F.]`
  FIN. 정상 종료 시작
- `[R]`
  RST. 강제 종료 또는 비정상 종료

실습 중 기대할 수 있는 전형적인 흐름:

1. `클라이언트 연결` 직후
   - `SYN`
   - `SYN-ACK`
   - `ACK`
2. 메시지 전송 직후
   - `P.` 또는 `length > 0`인 세그먼트
3. `정상 종료 시작` 직후
   - `FIN`
   - 반대편 `ACK`
   - 필요하면 반대 방향 `FIN`
4. `소켓 강제 종료`의 경우
   - 환경에 따라 `RST`가 보일 수 있다

### 5. 브라우저 DevTools에서 보이는 것

브라우저 DevTools에는 raw TCP가 직접 보이지 않는다.

보이는 것:

- 브라우저가 서버에 보내는 HTTP 제어 요청
- `/lab/tcp/stream` SSE 연결

직접 안 보이는 것:

- raw TCP 패킷 자체
- Node 프로세스 내부의 `net.Socket()` 이벤트

raw TCP는 아래 세 곳에서 확인한다.

- `Real TCP Lab`의 라이브 로그
- `logs/tcp-lab.ndjson`
- `tcpdump` / Wireshark / `lsof` / `nc`

## 종료 방법

- 특정 소켓 정상 종료: `정상 종료 시작`
- 특정 소켓 강제 종료: `소켓 강제 종료`
- 전체 listener 종료: `서버 중지`

## TCP Lab API

새 실험 페이지는 아래 API를 사용한다.

- `GET /lab/tcp/state`
  현재 listener, 소켓 목록, 최근 로그 조회
- `GET /lab/tcp/stream`
  SSE 실시간 상태 스트림
- `GET /lab/tcp/logs/download`
  누적 로그 파일 다운로드
- `POST /lab/tcp/server/start`
  실제 TCP lab 서버 시작
- `POST /lab/tcp/server/stop`
  실제 TCP lab 서버 중지
- `POST /lab/tcp/client/connect`
  TCP 클라이언트 생성 및 연결
- `POST /lab/tcp/socket/send`
  선택한 소켓에서 문자열 전송
- `POST /lab/tcp/socket/end`
  선택한 소켓에서 `socket.end()` 실행
- `POST /lab/tcp/socket/destroy`
  선택한 소켓 강제 종료

## Learning Demo API Response Fields

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
  하나의 데모 실행을 식별하는 고유 ID다.
- `type`
  이벤트 종류다. 예: `handshake`, `syscall`, `accept`, `data`, `read`, `response`, `close`, `session`, `state`
- `phase`
  `type`이 `session`일 때 세션의 시작인지 종료인지 나타낸다.
- `title`
  이벤트 제목이다.
- `label`
  짧은 상태 요약이다.
- `detail`
  사람이 읽기 위한 상세 설명이다.
- `message`
  실제 payload나 읽은 데이터처럼, 이벤트와 연결된 데이터 본문이다.
- `bytes`
  데이터 길이를 바이트 단위로 나타낸다.
- `from`
  이벤트가 시작된 쪽이다.
- `to`
  이벤트가 향한 쪽이다.
- `side`
  패킷 이동이 아니라 특정 쪽에서 관찰된 상태 이벤트일 때 사용한다.
- `controls`
  프런트 UI 제어를 위한 정보다.
- `id`
  이벤트 객체 자체의 고유 ID다.
- `at`
  이벤트가 생성된 시각이다.

## Portfolio Description

짧은 소개 문구:

> Node.js `net` 소켓으로 TCP의 학습용 시각화 페이지와 실제 TCP 실험실 페이지를 함께 구현한 프로젝트입니다. 한쪽에서는 handshake와 종료 과정을 단계별로 학습하고, 다른 한쪽에서는 실제 TCP 서버/클라이언트, 로그 파일, 외부 네트워크 도구로 실제 통신을 검증할 수 있습니다.

긴 소개 문구:

> TCP를 설명용 화면으로만 보여주는 것이 아니라 실제 코드와 실제 로그로 함께 이해하기 위해 만든 프로젝트입니다. `Learning Demo` 페이지에서는 `bind`, `listen`, `accept`, `connect()`, handshake, 데이터 송수신, 종료를 단계별로 시각화하고, `Real TCP Lab` 페이지에서는 실제 Node TCP 서버와 실제 TCP 클라이언트를 실행해 local/remote endpoint, `write`, `data`, `end`, `close`, `error`를 라이브 로그와 NDJSON 파일로 남긴다. 또한 `nc`, `lsof`, `tcpdump`, Wireshark 같은 외부 도구로도 동일한 연결을 확인할 수 있게 구성했다.
