# TCP Visualizer

Node.js `net` 소켓으로 실제 TCP 연결을 만들고, 브라우저에서 그 과정을 단계별로 시각화하는 프로젝트다.

이 프로젝트는 UDP 비교가 아니라 TCP 자체를 정확히 이해하는 데 집중한다.

## What This Project Explains

- 서버 측 `bind -> listen -> accept wait`
- 클라이언트 측 `connect()`
- `connect()` 뒤에서 커널이 수행하는 `SYN -> SYN-ACK -> ACK`
- handshake 완료 후 `accept()`가 새 연결 소켓을 반환하는 이유
- `ESTABLISHED` 상태 이후의 바이트 스트림 송수신
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
- `SYN -> SYN-ACK -> ACK COMPLETE`
- `ACCEPT RETURNED`
- `ESTABLISHED`
- `close() / FIN`
- `FIN RECEIVED / ACK IMPLIED`
- `server close() / FIN`
- `FINAL ACK IMPLIED / CLOSED`

## Portfolio Description

짧은 소개 문구:

> Node.js `net` 소켓으로 실제 TCP 연결을 만들고, `bind`, `listen`, `accept`, `connect()`, 3-way handshake, 데이터 전송, 종료 흐름을 웹 UI에서 단계별로 시각화한 학습용 네트워크 데모입니다.

긴 소개 문구:

> TCP를 단순한 텍스트 설명이 아니라 실제 코드와 시각화로 이해하기 위해 만든 프로젝트입니다. Node.js 내장 `net` 모듈로 TCP 서버와 클라이언트를 직접 실행하고, 서버의 `bind -> listen -> accept wait`, 클라이언트의 `connect()`, 그 뒤에서 커널이 수행하는 `SYN -> SYN-ACK -> ACK`, `ESTABLISHED` 이후의 바이트 스트림 송수신, `close()`에 따른 half-close와 full close까지를 브라우저 타임라인과 패킷 애니메이션으로 단계별 설명합니다.
