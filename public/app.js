const timeline = document.getElementById("timeline");
const template = document.getElementById("timeline-item-template");
const tcpState = document.getElementById("tcp-state");
const clearLogButton = document.getElementById("clear-log");
const startTcpButton = document.getElementById("start-tcp");
const nextTcpButton = document.getElementById("next-tcp");
const tcpScene = document.querySelector('.network-scene[data-protocol="TCP"]');

const protocolControls = {
  start: startTcpButton,
  next: nextTcpButton,
  running: false,
};

function prettifyType(type) {
  return (type || "event").replace(/_/g, " ");
}

function titleFor(event) {
  if (event.title) return event.title;
  if (event.label && event.from && event.to) return `${event.from} -> ${event.to} : ${event.label}`;
  if (event.label) return event.label;
  return "Transport event";
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
  if (event.type === "session" && event.phase === "start") {
    tcpState.textContent = event.detail;
    return;
  }

  if (event.type === "session" && event.phase === "complete") {
    tcpState.textContent = event.detail;
    return;
  }

  if (event.label) {
    tcpState.textContent = `${prettifyType(event.type)}: ${event.label}`;
  } else if (event.detail) {
    tcpState.textContent = event.detail;
  }
}

function animatePacket(event) {
  if (!event.from || !event.to) return;
  if (event.protocol !== "TCP") return;
  const scene = tcpScene;
  const layer = scene.querySelector(".packet-layer");
  if (!layer) return;
  const fromNode = scene.querySelector(`.node[data-side="${event.from}"]`);
  const toNode = scene.querySelector(`.node[data-side="${event.to}"]`);
  if (!fromNode || !toNode) return;

  const packet = document.createElement("div");
  packet.className = `packet ${event.protocol.toLowerCase()}`;
  packet.textContent = event.label || prettifyType(event.type);

  layer.appendChild(packet);

  const sceneRect = scene.getBoundingClientRect();
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

function setPending(button, pending, label = "Working...") {
  button.textContent = pending ? label : button.dataset.label;
}

function setTcpRunning(running) {
  protocolControls.running = running;
  protocolControls.next.disabled = !running;
}

async function startDemo() {
  setPending(protocolControls.start, true, "Starting...");
  protocolControls.start.disabled = true;
  protocolControls.next.disabled = true;

  try {
    const response = await fetch("/demo/tcp/start", { method: "POST" });
    if (!response.ok) {
      throw new Error("Failed to start TCP demo");
    }
    setTcpRunning(true);
  } catch (error) {
    addTimelineItem({
      protocol: "TCP",
      type: "error",
      at: new Date().toISOString(),
      title: "TCP demo failed",
      detail: error.message,
    });
    setTcpRunning(false);
  } finally {
    window.setTimeout(() => {
      setPending(protocolControls.start, false);
      protocolControls.start.disabled = false;
    }, 300);
  }
}

async function nextStep() {
  setPending(protocolControls.next, true, "Advancing...");
  protocolControls.next.disabled = true;

  try {
    const response = await fetch("/demo/tcp/next", { method: "POST" });
    if (!response.ok) {
      throw new Error("Failed to advance TCP demo");
    }
    const data = await response.json();
    if (data.completed) {
      setTcpRunning(false);
    } else {
      protocolControls.next.disabled = false;
    }
  } catch (error) {
    addTimelineItem({
      protocol: "TCP",
      type: "error",
      at: new Date().toISOString(),
      title: "TCP step failed",
      detail: error.message,
    });
    setTcpRunning(false);
  } finally {
    setPending(protocolControls.next, false);
    protocolControls.next.disabled = !protocolControls.running;
  }
}

startTcpButton.dataset.label = startTcpButton.textContent;
nextTcpButton.dataset.label = nextTcpButton.textContent;

startTcpButton.addEventListener("click", () => startDemo());
nextTcpButton.addEventListener("click", () => nextStep());

clearLogButton.addEventListener("click", () => {
  timeline.innerHTML = "";
  tcpState.textContent = "Idle";
  setTcpRunning(false);
});

const eventSource = new EventSource("/events");
eventSource.onmessage = (message) => {
  const event = JSON.parse(message.data);
  addTimelineItem(event);
  if (event.protocol === "TCP") {
    updateState(event);
  }
  animatePacket(event);

  if (event.protocol === "TCP" && event.controls) {
    setTcpRunning(Boolean(event.controls.canAdvance) && !event.controls.completed);
  }
};

eventSource.onerror = () => {
  addTimelineItem({
    protocol: "SYSTEM",
    type: "error",
    at: new Date().toISOString(),
    title: "Event stream disconnected",
    detail: "Refresh the page if live updates stop arriving.",
  });
};
