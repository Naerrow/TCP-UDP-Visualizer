const serverStateEl = document.getElementById("udp-lab-server-state");
const managedClientStateEl = document.getElementById("udp-client-state");
const listenerAddressEl = document.getElementById("udp-listener-address");
const logFilePathEl = document.getElementById("udp-log-file-path");
const labHostInput = document.getElementById("udp-lab-host");
const labPortInput = document.getElementById("udp-lab-port");
const clientHostInput = document.getElementById("udp-client-host");
const clientPortInput = document.getElementById("udp-client-port");
const clientLabelInput = document.getElementById("udp-client-label");
const socketSelect = document.getElementById("udp-socket-select");
const targetHostInput = document.getElementById("udp-target-host");
const targetPortInput = document.getElementById("udp-target-port");
const socketMessage = document.getElementById("udp-socket-message");
const socketTableBody = document.getElementById("udp-socket-table-body");
const labLog = document.getElementById("udp-lab-log");
const logTemplate = document.getElementById("udp-lab-log-item-template");
const commandNetcat = document.getElementById("udp-command-netcat");
const commandLsof = document.getElementById("udp-command-lsof");
const commandTail = document.getElementById("udp-command-tail");
const commandTcpdump = document.getElementById("udp-command-tcpdump");

const startServerButton = document.getElementById("start-udp-lab-server");
const stopServerButton = document.getElementById("stop-udp-lab-server");
const bindClientButton = document.getElementById("bind-udp-client");
const refreshButton = document.getElementById("refresh-udp-lab");
const sendButton = document.getElementById("send-udp-datagram");
const closeButton = document.getElementById("close-udp-socket");

const uiState = {
  snapshot: null,
  syncTimerId: null,
};
const MAX_LOG_ITEMS = 300;

function prettify(value) {
  return (value || "event").replace(/[_-]/g, " ");
}

function formatClock(at) {
  return new Date(at).toLocaleTimeString("ko-KR", { hour12: false });
}

function formatEndpoint(address, port) {
  if (!address || !port) {
    return "-";
  }

  return `${address}:${port}`;
}

function activeSockets(snapshot) {
  return (snapshot?.sockets || []).filter((socket) => socket.status !== "closed");
}

function writableSockets(snapshot) {
  return activeSockets(snapshot).filter((socket) => socket.status !== "error");
}

function snapshotVersion(snapshot) {
  return Number(snapshot?.version) || 0;
}

function setPending(button, pending, label) {
  button.textContent = pending ? label : button.dataset.label;
  button.disabled = pending;
}

function scheduleStateSync(delay = 150) {
  if (uiState.syncTimerId) {
    window.clearTimeout(uiState.syncTimerId);
  }

  uiState.syncTimerId = window.setTimeout(async () => {
    uiState.syncTimerId = null;
    try {
      await refreshState();
    } catch (error) {
      console.warn("Delayed UDP lab state sync failed.", error);
    }
  }, delay);
}

function applyButtonLabels() {
  for (const button of [
    startServerButton,
    stopServerButton,
    bindClientButton,
    refreshButton,
    sendButton,
    closeButton,
  ]) {
    button.dataset.label = button.textContent;
  }
}

function logTitle(event) {
  const parts = [displayCategory(event.category), "상세 로그"];
  return parts.filter(Boolean).join(" / ");
}

function displayCategory(category) {
  switch (category) {
    case "server":
      return "서버";
    case "client":
      return "클라이언트";
    case "socket":
      return "소켓";
    default:
      return prettify(category);
  }
}

function displayAction(action) {
  switch (action) {
    case "listening":
      return "바인드 완료";
    case "bound":
      return "바인드 완료";
    case "send":
      return "Datagram 전송";
    case "data":
      return "Datagram 수신";
    case "close":
      return "닫힘";
    case "stopped":
      return "소켓 정리";
    case "error":
      return "오류";
    default:
      return prettify(action);
  }
}

function displayLabel(label) {
  switch (label) {
    case "서버 소켓":
      return "서버 소켓";
    case "클라이언트":
      return "클라이언트";
    default:
      return label;
  }
}

function displayRole(role) {
  switch (role) {
    case "managed-client":
      return "클라이언트 소켓";
    case "server-socket":
      return "서버 소켓";
    default:
      return prettify(role);
  }
}

function displayStatus(status) {
  switch (status) {
    case "opening":
      return "준비 중";
    case "open":
      return "열림";
    case "closed":
      return "닫힘";
    case "error":
      return "오류";
    default:
      return prettify(status);
  }
}

function subjectFor(event) {
  const parts = [];

  if (event.label) {
    parts.push(displayLabel(event.label));
  } else if (event.category === "server") {
    parts.push("서버");
  } else if (event.category === "client") {
    parts.push("클라이언트");
  } else {
    parts.push("소켓");
  }

  if (event.role) {
    const roleLabel = displayRole(event.role);
    if (roleLabel && roleLabel !== parts[parts.length - 1]) {
      parts.push(roleLabel);
    }
  }

  return parts.join(" · ");
}

function summaryFor(event) {
  switch (event.action) {
    case "listening":
      return `${event.host}:${event.port} 에서 UDP 서버 소켓 바인드를 시작했다.`;
    case "bound":
      return `${subjectFor(event)} 가 로컬 UDP 소켓 바인드를 마쳤다.`;
    case "send":
      return `${subjectFor(event)} 가 ${event.peerAddress}:${event.peerPort} 로 ${event.bytes}B datagram을 보냈다.`;
    case "data":
      return `${subjectFor(event)} 가 ${event.bytes}B datagram을 받았다.`;
    case "close":
      return `${subjectFor(event)} 닫힘이 확인됐다.`;
    case "stopped":
      return "UDP 실험실 소켓을 모두 정리했다.";
    case "error":
      return event.message || event.detail || "UDP 소켓 오류가 발생했다.";
    default:
      return event.detail || `${prettify(event.action)} 이벤트`;
  }
}

function logDetail(event) {
  const details = [];

  if (event.socketId) {
    details.push(`소켓=${event.socketId}`);
  }

  if (event.detail) {
    details.push(event.detail);
  }

  const local = formatEndpoint(event.localAddress, event.localPort);
  const peer = formatEndpoint(event.peerAddress, event.peerPort);
  if (local !== "-" || peer !== "-") {
    details.push(`로컬=${local} 상대=${peer}`);
  }

  return details.join(" ");
}

function renderLogItem(event) {
  const node = logTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.action = event.action || "generic";
  node.querySelector(".event-type").textContent = `${displayCategory(event.category)} / ${displayAction(event.action)}`;
  node.querySelector(".event-time").textContent = formatClock(event.at);
  node.querySelector(".log-subject").textContent = subjectFor(event);
  node.querySelector(".log-summary").textContent = summaryFor(event);
  node.querySelector(".event-title").textContent = logTitle(event);
  node.querySelector(".event-detail").textContent = logDetail(event);

  const payload = node.querySelector(".log-payload");
  if (typeof event.bytes === "number") {
    payload.hidden = false;
    payload.textContent = `바이트 수: ${event.bytes}\nUTF-8: ${event.utf8}\n16진수: ${event.hex}`;
  }

  return node;
}

function renderLogs(logs) {
  labLog.innerHTML = "";
  logs
    .slice()
    .reverse()
    .forEach((event) => {
      labLog.append(renderLogItem(event));
    });
}

function renderSocketTable(sockets) {
  socketTableBody.innerHTML = "";

  if (sockets.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="9" class="empty-cell">아직 생성된 UDP 소켓이 없다.</td>';
    socketTableBody.append(row);
    return;
  }

  for (const socket of sockets) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${socket.id}</td>
      <td>${displayRole(socket.role)}</td>
      <td>${displayStatus(socket.status)}</td>
      <td>${formatEndpoint(socket.localAddress, socket.localPort)}</td>
      <td>${formatEndpoint(socket.peerAddress, socket.peerPort)}</td>
      <td>${socket.bytesRead}</td>
      <td>${socket.bytesWritten}</td>
      <td>${socket.packetsRead}</td>
      <td>${socket.packetsWritten}</td>
    `;
    socketTableBody.append(row);
  }
}

function renderSocketOptions(snapshot) {
  const previous = socketSelect.value;
  const sockets = writableSockets(snapshot);
  socketSelect.innerHTML = "";

  if (sockets.length === 0) {
    const option = document.createElement("option");
    option.textContent = "전송 가능한 UDP 소켓이 없다";
    option.value = "";
    socketSelect.append(option);
    socketSelect.disabled = true;
    sendButton.disabled = true;
    closeButton.disabled = true;
    return;
  }

  for (const socket of sockets) {
    const option = document.createElement("option");
    option.value = socket.id;
    option.textContent = `${socket.id} | ${displayRole(socket.role)} | ${formatEndpoint(socket.localAddress, socket.localPort)} -> ${formatEndpoint(socket.peerAddress, socket.peerPort)}`;
    socketSelect.append(option);
  }

  if (sockets.some((socket) => socket.id === previous)) {
    socketSelect.value = previous;
  }

  socketSelect.disabled = false;
  sendButton.disabled = false;
  closeButton.disabled = false;
}

function appendLiveLog(event) {
  if (!uiState.snapshot) {
    return;
  }

  const currentVersion = snapshotVersion(uiState.snapshot);
  const incomingVersion = Number(event?.stateVersion) || 0;
  if (incomingVersion && incomingVersion < currentVersion) {
    return;
  }

  const currentLogs = uiState.snapshot.logs || [];
  if (currentLogs.some((item) => item.id === event.id)) {
    return;
  }

  const nextLogs = currentLogs.concat(event).slice(-MAX_LOG_ITEMS);
  applyState({
    ...uiState.snapshot,
    version: Math.max(currentVersion, incomingVersion),
    logs: nextLogs,
  });
}

function renderCommands(snapshot) {
  const host = snapshot?.host || "127.0.0.1";
  const port = snapshot?.port || 4301;
  const logFile = snapshot?.logFile || "logs/udp-lab.ndjson";

  commandNetcat.textContent = `nc -u ${host} ${port}`;
  commandLsof.textContent = `lsof -n -P -iUDP:${port}`;
  commandTail.textContent = `tail -f ${logFile}`;
  commandTcpdump.textContent = `macOS: sudo tcpdump -i lo0 -nn udp port ${port}\nLinux: sudo tcpdump -i lo -nn udp port ${port}`;
}

function renderServerState(snapshot) {
  const listening = snapshot?.listening;
  const endpoint = `${snapshot?.host || "127.0.0.1"}:${snapshot?.port || 4301}`;
  listenerAddressEl.textContent = endpoint;
  logFilePathEl.textContent = snapshot?.logFile || "logs/udp-lab.ndjson";
  serverStateEl.textContent = listening
    ? `${endpoint} 에서 실제 UDP 서버 소켓이 바인드돼 있다.`
    : `${endpoint} UDP 서버 소켓은 현재 중지 상태다.`;
}

function renderManagedClientState(snapshot) {
  const clients = activeSockets(snapshot).filter((socket) => socket.role === "managed-client");
  if (clients.length === 0) {
    managedClientStateEl.textContent = "활성 UDP 클라이언트가 아직 없다.";
    return;
  }

  const latest = clients[0];
  managedClientStateEl.textContent = `최근 클라이언트: ${latest.id} ${formatEndpoint(latest.localAddress, latest.localPort)} -> ${formatEndpoint(latest.peerAddress, latest.peerPort)} (${displayStatus(latest.status)})`;
}

function populateTargetFromSelection(force = false) {
  if (!uiState.snapshot) {
    return;
  }

  const selected = (uiState.snapshot.sockets || []).find((socket) => socket.id === socketSelect.value);
  if (!selected) {
    return;
  }

  if (!force && (document.activeElement === targetHostInput || document.activeElement === targetPortInput)) {
    return;
  }

  const nextHost = selected.peerAddress || (selected.role === "managed-client" ? uiState.snapshot.host : "");
  const nextPort = selected.peerPort || (selected.role === "managed-client" ? uiState.snapshot.port : "");

  if (nextHost) {
    targetHostInput.value = nextHost;
  }
  if (nextPort) {
    targetPortInput.value = String(nextPort);
  }
}

function syncPrimaryButtons() {
  startServerButton.disabled = Boolean(uiState.snapshot?.listening);
  stopServerButton.disabled = !uiState.snapshot?.listening;
  bindClientButton.disabled = false;
  refreshButton.disabled = false;
}

function applyState(snapshot) {
  const currentVersion = snapshotVersion(uiState.snapshot);
  const incomingVersion = snapshotVersion(snapshot);
  if (uiState.snapshot && incomingVersion < currentVersion) {
    return;
  }

  uiState.snapshot = snapshot;

  labHostInput.value = snapshot.host || labHostInput.value;
  labPortInput.value = snapshot.port || labPortInput.value;
  clientHostInput.value = snapshot.host || clientHostInput.value;

  renderServerState(snapshot);
  renderManagedClientState(snapshot);
  renderCommands(snapshot);
  renderSocketTable(snapshot.sockets || []);
  renderSocketOptions(snapshot);
  renderLogs(snapshot.logs || []);
  populateTargetFromSelection();
  syncPrimaryButtons();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `요청 처리에 실패했다. (${response.status})`);
  }

  return data;
}

async function refreshState() {
  const state = await requestJson("/lab/udp/state");
  applyState(state);
}

async function postJson(url, body, button, pendingLabel) {
  if (button) {
    setPending(button, true, pendingLabel);
  }

  try {
    const state = await requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body || {}),
    });
    applyState(state);
    scheduleStateSync();
  } catch (error) {
    window.alert(error.message);
  } finally {
    if (button) {
      setPending(button, false, pendingLabel);
    }
    syncPrimaryButtons();
    syncActionButtons();
  }
}

function syncActionButtons() {
  const hasSocket = Boolean(socketSelect.value);
  if (!uiState.snapshot) {
    sendButton.disabled = true;
    closeButton.disabled = true;
    return;
  }

  const writable = writableSockets(uiState.snapshot);
  const available = writable.some((socket) => socket.id === socketSelect.value);

  sendButton.disabled = !(hasSocket && available);
  closeButton.disabled = !(hasSocket && available);
}

function connectStream() {
  const stream = new EventSource("/lab/udp/stream");

  stream.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "state") {
      applyState(payload.state);
      return;
    }

    if (payload.type === "log") {
      appendLiveLog(payload.event);
    }
  };

  stream.onerror = () => {
    window.setTimeout(connectStream, 1500);
    stream.close();
  };
}

startServerButton.addEventListener("click", () => {
  postJson(
    "/lab/udp/server/start",
    {
      host: labHostInput.value,
      port: Number(labPortInput.value),
    },
    startServerButton,
    "시작 중...",
  );
});

stopServerButton.addEventListener("click", () => {
  postJson("/lab/udp/server/stop", {}, stopServerButton, "중지 중...");
});

bindClientButton.addEventListener("click", () => {
  postJson(
    "/lab/udp/client/bind",
    {
      host: clientHostInput.value,
      port: Number(clientPortInput.value),
      label: clientLabelInput.value,
    },
    bindClientButton,
    "바인드 중...",
  );
});

refreshButton.addEventListener("click", async () => {
  setPending(refreshButton, true, "새로고침 중...");
  try {
    await refreshState();
  } catch (error) {
    window.alert(error.message);
  } finally {
    setPending(refreshButton, false, "새로고침 중...");
    syncPrimaryButtons();
    syncActionButtons();
  }
});

sendButton.addEventListener("click", () => {
  postJson(
    "/lab/udp/socket/send",
    {
      socketId: socketSelect.value,
      host: targetHostInput.value,
      port: targetPortInput.value,
      text: socketMessage.value,
    },
    sendButton,
    "전송 중...",
  );
});

closeButton.addEventListener("click", () => {
  postJson(
    "/lab/udp/socket/close",
    {
      socketId: socketSelect.value,
    },
    closeButton,
    "닫는 중...",
  );
});

socketSelect.addEventListener("change", () => {
  populateTargetFromSelection(true);
  syncActionButtons();
});

applyButtonLabels();
refreshState().catch((error) => {
  window.alert(error.message);
});
connectStream();
