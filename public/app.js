const demoConfig = window.DEMO_CONFIG || {};
const demoProtocol = String(demoConfig.protocol || "TCP").toUpperCase();
const demoPath = demoProtocol.toLowerCase();

const timeline = document.getElementById("timeline");
const template = document.getElementById("timeline-item-template");
const demoState = document.getElementById("demo-state");
const clearLogButton = document.getElementById("clear-log");
const startDemoButton = document.getElementById("start-demo");
const nextDemoButton = document.getElementById("next-demo");
const demoScene = document.querySelector(`.network-scene[data-protocol="${demoProtocol}"]`);

const protocolControls = {
  start: startDemoButton,
  next: nextDemoButton,
  running: false,
};

function prettifyType(type) {
  return (type || "event").replace(/_/g, " ");
}

function displaySide(side) {
  switch (side) {
    case "client":
      return "클라이언트";
    case "server":
      return "서버";
    default:
      return side;
  }
}

function titleFor(event) {
  if (event.title) {
    return event.title;
  }
  if (event.label && event.from && event.to) {
    return `${displaySide(event.from)} -> ${displaySide(event.to)} : ${event.label}`;
  }
  if (event.label) {
    return event.label;
  }
  return "전송 계층 이벤트";
}

function addTimelineItem(event) {
  const node = template.content.firstElementChild.cloneNode(true);
  const protocol = event.protocol || "GENERIC";
  const protocolClass = protocol.toLowerCase();

  node.querySelector(".protocol-pill").textContent = protocol;
  node.querySelector(".protocol-pill").classList.add(protocolClass);

  node.querySelector(".event-type").textContent = prettifyType(event.type);
  node.querySelector(".event-type").classList.add(protocolClass);

  node.querySelector(".event-time").textContent = new Date(event.at).toLocaleTimeString("ko-KR", {
    hour12: false,
  });
  node.querySelector(".event-title").textContent = titleFor(event);
  node.querySelector(".event-detail").textContent = event.detail || event.message || "";

  timeline.prepend(node);
}

function updateState(event) {
  if (event.type === "session" && (event.phase === "start" || event.phase === "complete")) {
    demoState.textContent = event.detail;
    return;
  }

  if (event.label) {
    demoState.textContent = `${prettifyType(event.type)}: ${event.label}`;
  } else if (event.detail) {
    demoState.textContent = event.detail;
  }
}

function animatePacket(event) {
  if (!event.from || !event.to) {
    return;
  }
  if (event.protocol !== demoProtocol) {
    return;
  }
  if (!demoScene) {
    return;
  }

  const layer = demoScene.querySelector(".packet-layer");
  if (!layer) {
    return;
  }

  const fromNode = demoScene.querySelector(`.node[data-side="${event.from}"]`);
  const toNode = demoScene.querySelector(`.node[data-side="${event.to}"]`);
  if (!fromNode || !toNode) {
    return;
  }

  const packet = document.createElement("div");
  packet.className = `packet ${event.protocol.toLowerCase()}`;
  packet.textContent = event.label || prettifyType(event.type);

  layer.appendChild(packet);

  const sceneRect = demoScene.getBoundingClientRect();
  const fromRect = fromNode.getBoundingClientRect();
  const toRect = toNode.getBoundingClientRect();
  const packetWidth = packet.offsetWidth;
  const startX = fromRect.left - sceneRect.left + (fromRect.width - packetWidth) / 2;
  const endX = toRect.left - sceneRect.left + (toRect.width - packetWidth) / 2;
  const travelDistance = endX - startX;

  packet.style.left = `${startX}px`;
  packet.style.setProperty("--travel-x", `${travelDistance}px`);

  packet.addEventListener("animationend", () => {
    packet.remove();
  });
}

function setPending(button, pending, label = "처리 중...") {
  button.textContent = pending ? label : button.dataset.label;
}

function setDemoRunning(running) {
  protocolControls.running = running;
  protocolControls.next.disabled = !running;
}

async function startDemo() {
  setPending(protocolControls.start, true, "시작 중...");
  protocolControls.start.disabled = true;
  protocolControls.next.disabled = true;

  try {
    const response = await fetch(`/demo/${demoPath}/start`, { method: "POST" });
    if (!response.ok) {
      throw new Error(`${demoProtocol} 데모를 시작하지 못했다.`);
    }
    const data = await response.json();
    for (const event of data.events || []) {
      addTimelineItem(event);
      updateState(event);
      animatePacket(event);
    }
    setDemoRunning(true);
  } catch (error) {
    addTimelineItem({
      protocol: demoProtocol,
      type: "error",
      at: new Date().toISOString(),
      title: `${demoProtocol} 데모 실행 실패`,
      detail: error.message,
    });
    setDemoRunning(false);
  } finally {
    window.setTimeout(() => {
      setPending(protocolControls.start, false);
      protocolControls.start.disabled = false;
    }, 300);
  }
}

async function nextStep() {
  setPending(protocolControls.next, true, "진행 중...");
  protocolControls.next.disabled = true;

  try {
    const response = await fetch(`/demo/${demoPath}/next`, { method: "POST" });
    if (!response.ok) {
      throw new Error(`${demoProtocol} 데모를 다음 단계로 진행하지 못했다.`);
    }
    const data = await response.json();
    for (const event of data.events || []) {
      addTimelineItem(event);
      updateState(event);
      animatePacket(event);
    }
    if (data.completed) {
      setDemoRunning(false);
    } else {
      protocolControls.next.disabled = false;
    }
  } catch (error) {
    addTimelineItem({
      protocol: demoProtocol,
      type: "error",
      at: new Date().toISOString(),
      title: `${demoProtocol} 단계 진행 실패`,
      detail: error.message,
    });
    setDemoRunning(false);
  } finally {
    setPending(protocolControls.next, false);
    protocolControls.next.disabled = !protocolControls.running;
  }
}

startDemoButton.dataset.label = startDemoButton.textContent;
nextDemoButton.dataset.label = nextDemoButton.textContent;

startDemoButton.addEventListener("click", () => startDemo());
nextDemoButton.addEventListener("click", () => nextStep());

clearLogButton.addEventListener("click", () => {
  timeline.innerHTML = "";
  demoState.textContent = "대기 중";
  setDemoRunning(false);
});
