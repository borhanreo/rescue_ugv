document.querySelectorAll('.mdc-button').forEach((btn) => {
  try {
    mdc.ripple.MDCRipple.attachTo(btn);
  } catch (err) {
    // Ignore if MDC isn't available yet.
  }
});

// DEfault configuration - Change these if you have a different STUN or TURN server.
const configuration = {
  iceServers: [
    {
      urls: [
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
  iceCandidatePoolSize: 10,
};

let peerConnection = null;
let localStream = null;
let remoteStream = null;
let roomDialog = null;
let roomId = null;

let dataChannel = null;

let mqttSocket = null;
let mqttBridgeConnected = false;
let mqttBrokerConnected = false;
let inferredDeviceId = null;
let inferredTelemetryRoomId = null;

const QUICK_JOIN_BASE_URL = 'https://103.197.206.61/';

let robotDcStatusText = 'Not connected';
let robotMqttStatusText = 'MQTT disconnected';

const MQTT_CMD_KEYS = new Set(['restart', 'reload', 'force_stop', 'get_info']);


const chatEls = {
  status: null,
  messages: null,
  input: null,
  sendBtn: null,
};

const mqttEls = {
  status: null,
  messages: null,
  maxLines: 250,
};

const robotEls = {
  status: null,
  buttons: [],
  servo1Slider: null,
  servo2Slider: null,
  speedSlider: null,
  servo1Value: null,
  servo2Value: null,
  speedValue: null,
};

const quickJoinEls = {
  button: null,
};

const DEFAULT_CMD_V = 100;

const ROBOT_CMD_MAP = {
  forward: { t: 1, v: DEFAULT_CMD_V },
  back: { t: 2, v: DEFAULT_CMD_V },
  left: { t: 3, v: DEFAULT_CMD_V },
  right: { t: 4, v: DEFAULT_CMD_V },

  // Defaults for the additional requested buttons.
  // If your robot uses different codes/values, change these.
  pos_hold: { t: 0, v: DEFAULT_CMD_V },
  alt_hold: { t: 6, v: DEFAULT_CMD_V },
  extra_1: { t: 7, v: DEFAULT_CMD_V },
  extra_2: { t: 8, v: DEFAULT_CMD_V },
  extra_3: { t: 9, v: DEFAULT_CMD_V },

  // System actions
  restart: { t: 14, v: "20" },
  reload: { t: 18, v: "20" },
  force_stop: { t: 0, v: "20" },
  get_info: { t: 19, v: "20" },
};

const SERVO_CMD_MAP = {
  servo1: 16,
  servo2: 17,
};

// --- Serial joystick (Web Serial API) ---------------------------------
// A hardware joystick connected to this machine's serial/USB port sends
// one text label per line whenever a button is pressed (e.g. "FORWARD").
// Each label is mapped to an existing robot command key and dispatched
// through the exact same sendRobotCommandByKey() used by the on-screen
// buttons, so joystick input behaves identically to clicking a button.
// Add more aliases here as new joystick buttons are wired up.
const JOYSTICK_BAUD_RATE = 9600;

const JOYSTICK_CMD_ALIASES = {
  FORWARD: 'forward',
  FWD: 'forward',
  BACK: 'back',
  BACKWARD: 'back',
  LEFT: 'left',
  RIGHT: 'right',
  HOLD: 'pos_hold',
  POS_HOLD: 'pos_hold',
  POSHOLD: 'pos_hold',
  ALT_HOLD: 'alt_hold',
  ALTHOLD: 'alt_hold',
  EXTRA_1: 'extra_1',
  EXTRA_2: 'extra_2',
  EXTRA_3: 'extra_3',
  RESTART: 'restart',
  RELOAD: 'reload',
  FORCE_STOP: 'force_stop',
  STOP: 'force_stop',
  GET_INFO: 'get_info',
};

const joystickEls = {
  connectBtn: null,
  status: null,
};

let joystickPort = null;
let joystickReader = null;
let joystickReadableStreamClosed = null;
let joystickReadLoopPromise = null;
let joystickKeepReading = false;

function isWebSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

function setJoystickStatus(text) {
  if (joystickEls.status) joystickEls.status.textContent = text;
}

function getJoystickBaudRate() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = Number(params.get('joystick_baud'));
    if (Number.isFinite(raw) && raw > 0) return raw;
  } catch {
    // ignore
  }
  return JOYSTICK_BAUD_RATE;
}

function resolveJoystickCommandKey(rawLabel) {
  const label = String(rawLabel || '').trim();
  if (!label) return null;
  const upper = label.toUpperCase();
  if (JOYSTICK_CMD_ALIASES[upper]) return JOYSTICK_CMD_ALIASES[upper];
  // Also allow the joystick to send the raw command key directly (e.g. "forward").
  const lower = label.toLowerCase();
  if (ROBOT_CMD_MAP[lower]) return lower;
  return null;
}

function handleJoystickLine(line) {
  const text = line.trim();
  if (!text) return;
  const cmdKey = resolveJoystickCommandKey(text);
  if (!cmdKey) {
    console.warn('Joystick: unmapped button label:', text);
    return;
  }
  console.log('Joystick button ->', cmdKey);
  sendRobotCommandByKey(cmdKey);
}

async function joystickReadLoop(port) {
  const textDecoder = new TextDecoderStream();
  joystickReadableStreamClosed = port.readable.pipeTo(textDecoder.writable);
  const reader = textDecoder.readable.getReader();
  joystickReader = reader;

  let buffer = '';
  try {
    while (joystickKeepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        buffer += value;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleJoystickLine(line);
        }
      }
    }
  } catch (err) {
    console.error('Joystick read error:', err);
    setJoystickStatus(`Joystick: read error - ${err.message || err}`);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    try {
      await joystickReadableStreamClosed.catch(() => {});
    } catch {
      // ignore
    }
  }
}

async function connectJoystick() {
  if (!isWebSerialSupported()) {
    setJoystickStatus('Joystick: Web Serial not supported in this browser');
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: getJoystickBaudRate() });
    joystickPort = port;
    joystickKeepReading = true;
    setJoystickStatus('Joystick: Connected');
    if (joystickEls.connectBtn) {
      joystickEls.connectBtn.querySelector('.mdc-button__label').textContent = 'Disconnect Joystick';
    }
    joystickReadLoopPromise = joystickReadLoop(port);
  } catch (err) {
    console.error('Joystick connect failed:', err);
    setJoystickStatus(`Joystick: Connect failed - ${err.message || err}`);
  }
}

async function disconnectJoystick() {
  joystickKeepReading = false;
  try {
    if (joystickReader) {
      await joystickReader.cancel().catch(() => {});
    }
    if (joystickReadLoopPromise) {
      await joystickReadLoopPromise.catch(() => {});
    }
    if (joystickPort) {
      await joystickPort.close().catch(() => {});
    }
  } finally {
    joystickPort = null;
    joystickReader = null;
    joystickReadableStreamClosed = null;
    joystickReadLoopPromise = null;
    setJoystickStatus('Joystick: Not connected');
    if (joystickEls.connectBtn) {
      joystickEls.connectBtn.querySelector('.mdc-button__label').textContent = 'Connect Joystick';
    }
  }
}

function toggleJoystickConnection() {
  if (joystickPort) {
    disconnectJoystick();
  } else {
    connectJoystick();
  }
}

function initJoystickUi() {
  joystickEls.connectBtn = document.querySelector('#joystickConnectBtn');
  joystickEls.status = document.querySelector('#joystickStatus');

  if (!joystickEls.connectBtn || !joystickEls.status) {
    console.warn('Joystick UI elements not found; serial joystick disabled.');
    return;
  }

  if (!isWebSerialSupported()) {
    joystickEls.connectBtn.disabled = true;
    setJoystickStatus('Joystick: Web Serial not supported (use Chrome/Edge over HTTPS)');
    return;
  }

  setJoystickStatus('Joystick: Not connected');
  joystickEls.connectBtn.addEventListener('click', toggleJoystickConnection);

  navigator.serial.addEventListener('disconnect', (event) => {
    if (joystickPort && event.target === joystickPort) {
      disconnectJoystick();
    }
  });
}

function getRoomActionFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const joinId = (params.get('room_join') || '').trim();
    const createId = (params.get('room_create') || '').trim();

    if (joinId) return { action: 'join', roomId: joinId };
    if (createId) return { action: 'create', roomId: createId };
    return { action: null, roomId: null };
  } catch (err) {
    console.warn('Failed to parse URL params:', err);
    return { action: null, roomId: null };
  }
}

function isValidRoomId(id) {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed) return false;
  // Firestore document IDs must not contain '/' (path separator).
  if (trimmed.includes('/')) return false;
  // Keep it reasonably sized for URLs and UI.
  if (trimmed.length > 200) return false;
  return true;
}

function initChatUi() {
  chatEls.status = document.querySelector('#chatStatus');
  chatEls.messages = document.querySelector('#messages');
  chatEls.input = document.querySelector('#msgInput');
  chatEls.sendBtn = document.querySelector('#sendMsgBtn');

  if (!chatEls.status || !chatEls.messages || !chatEls.input || !chatEls.sendBtn) {
    console.warn('Chat UI elements not found; DataChannel chat disabled.');
    return;
  }

  setChatEnabled(false);
  setChatStatus('Not connected');

  chatEls.sendBtn.addEventListener('click', sendChatMessage);
  chatEls.input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChatMessage();
    }
  });
}

function setChatStatus(text) {
  if (chatEls.status) {
    chatEls.status.textContent = text;
  }
}

function setChatEnabled(enabled) {
  if (chatEls.input) chatEls.input.disabled = !enabled;
  if (chatEls.sendBtn) chatEls.sendBtn.disabled = !enabled;
}

function appendChatMessage(prefix, message) {
  if (!chatEls.messages) return;
  const line = document.createElement('div');
  line.textContent = `${prefix}: ${message}`;
  chatEls.messages.appendChild(line);
  chatEls.messages.scrollTop = chatEls.messages.scrollHeight;
}

function initMqttUi() {
  mqttEls.status = document.querySelector('#mqttStatus');
  mqttEls.messages = document.querySelector('#mqttMessages');

  if (!mqttEls.status || !mqttEls.messages) {
    console.warn('MQTT UI elements not found; monitor disabled.');
    return;
  }

  setMqttStatus('MQTT: Connecting...');
  connectMqttMonitor();
}

function setMqttStatus(text) {
  if (mqttEls.status) mqttEls.status.textContent = text;
}

function appendMqttMessage(topic, payload, timestamp) {
  if (!mqttEls.messages) return;
  const line = document.createElement('div');
  const ts = timestamp || new Date().toISOString();
  line.textContent = `[${ts}] ${topic}: ${payload}`;
  mqttEls.messages.appendChild(line);

  while (mqttEls.messages.childElementCount > mqttEls.maxLines) {
    mqttEls.messages.removeChild(mqttEls.messages.firstChild);
  }

  mqttEls.messages.scrollTop = mqttEls.messages.scrollHeight;
}

function extractTelemetryRoomIdFromText(text) {
  const source = String(text || '');
  const match = source.match(/\brnd_[A-Za-z0-9_-]+\b/);
  return match ? match[0] : null;
}

function setQuickJoinRoom(roomId) {
  const btn = quickJoinEls.button;
  inferredTelemetryRoomId = roomId || null;
  if (!btn || !inferredTelemetryRoomId) return;

  btn.disabled = false;
  btn.style.display = '';
  btn.title = `Join ${inferredTelemetryRoomId}`;
}

function hideQuickJoinRoom() {
  const btn = quickJoinEls.button;
  inferredTelemetryRoomId = null;
  if (!btn) return;

  btn.disabled = true;
  btn.style.display = 'none';
  btn.title = '';
}

function handleQuickJoinRoomClick() {
  if (!inferredTelemetryRoomId) return;
  const joinUrl = `${QUICK_JOIN_BASE_URL}?room_join=${encodeURIComponent(inferredTelemetryRoomId)}`;
  window.location.href = joinUrl;
}

function connectMqttMonitor() {
  const bridgeOrigin = (() => {
    // If the page is served from Firebase dev server (commonly :5500 over http),
    // the Socket.IO bridge is still the HTTPS proxy on the same hostname.
    const hostname = window.location.hostname;
    const isLikelyFirebaseDevServer = window.location.port === '5500' || window.location.protocol === 'http:';
    if (isLikelyFirebaseDevServer) {
      return `https://${hostname}`;
    }
    return window.location.origin;
  })();

  const loadSocketIoClient = (src) => new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-socketio-client="true"]');
    if (existing) {
      // Already attempted/loaded.
      if (typeof io !== 'undefined') return resolve();
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.setAttribute('data-socketio-client', 'true');
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });

  const ensureIoLoaded = async () => {
    if (typeof io !== 'undefined') return;
    // First try the bridge's built-in client script.
    try {
      await loadSocketIoClient(`${bridgeOrigin}/socket.io/socket.io.js`);
    } catch (err) {
      // Fallback to CDN (same major as server: 4.x)
      await loadSocketIoClient('https://cdn.socket.io/4.8.1/socket.io.min.js');
    }
  };

  (async () => {
    try {
      await ensureIoLoaded();
    } catch (err) {
      console.error('Socket.IO client load failed:', err);
      setMqttStatus('MQTT: Socket client not loaded');
      return;
    }

    if (typeof io === 'undefined') {
      setMqttStatus('MQTT: Socket client not loaded');
      return;
    }

    const socket = io(bridgeOrigin, {
      // Be explicit so we don't accidentally connect to the Firebase origin.
      path: '/socket.io',
    });

    mqttSocket = socket;

    socket.on('connect', () => {
      setMqttStatus('MQTT: Web socket connected');
      mqttBridgeConnected = true;
      setRobotStatus('MQTT bridge connected');
    });

    socket.on('disconnect', () => {
      setMqttStatus('MQTT: Web socket disconnected');
      mqttBridgeConnected = false;
      mqttBrokerConnected = false;
      setRobotMqttStatus('MQTT disconnected');
      setMqttButtonsEnabled(false);
    });

    socket.on('connect_error', (err) => {
      const msg = (err && err.message) ? err.message : String(err || 'Unknown error');
      setMqttStatus(`MQTT: Web socket error - ${msg}`);
      mqttBridgeConnected = false;
      mqttBrokerConnected = false;
      setRobotMqttStatus('MQTT connection error');
      setMqttButtonsEnabled(false);
    });

    socket.on('mqtt_status', (status) => {
      if (!status || typeof status !== 'object') return;
      if (status.connected) {
        setMqttStatus(`MQTT: Connected (topic: ${status.topic || '#'})`);
        mqttBrokerConnected = true;
        setRobotMqttStatus(inferredDeviceId ? `MQTT connected (device: ${inferredDeviceId})` : 'MQTT connected');
        setMqttButtonsEnabled(true);
        return;
      }
      if (status.reconnecting) {
        setMqttStatus('MQTT: Reconnecting...');
        mqttBrokerConnected = false;
        setRobotMqttStatus('MQTT reconnecting...');
        setMqttButtonsEnabled(false);
        return;
      }
      if (status.error) {
        setMqttStatus(`MQTT: Error - ${status.error}`);
        mqttBrokerConnected = false;
        setRobotMqttStatus(`MQTT error: ${status.error}`);
        setMqttButtonsEnabled(false);
        return;
      }
      setMqttStatus('MQTT: Disconnected');
      mqttBrokerConnected = false;
      setRobotMqttStatus('MQTT disconnected');
      setMqttButtonsEnabled(false);
    });

    socket.on('mqtt_publish_error', (err) => {
      const msg = (err && err.error) ? err.error : String(err || 'Publish error');
      console.warn('MQTT publish error:', msg);
    });

    socket.on('mqtt_message', (message) => {
      if (!message || typeof message !== 'object') return;
      appendMqttMessage(message.topic || '', message.payload || '', message.timestamp);

      const telemetryRoomId = extractTelemetryRoomIdFromText(message.payload || '');
      if (telemetryRoomId) {
        setQuickJoinRoom(telemetryRoomId);
      }

      // Infer device id from telemetry topic: v301/ugv/telemetry/{DEVICE_ID}
      try {
        const topic = String(message.topic || '');
        const prefix = 'v301/ugv/telemetry/';
        if (!inferredDeviceId && topic.startsWith(prefix)) {
          const rest = topic.slice(prefix.length);
          const device = rest.split('/')[0].trim();
          if (device) {
            inferredDeviceId = device;
            if (mqttBrokerConnected) {
              setRobotMqttStatus(`MQTT connected (device: ${inferredDeviceId})`);
            }
          }
        }
      } catch {
        // ignore
      }
    });
  })();
}

function initQuickJoinUi() {
  quickJoinEls.button = document.querySelector('#quickJoinRoomBtn');
  if (!quickJoinEls.button) return;

  hideQuickJoinRoom();
  quickJoinEls.button.addEventListener('click', handleQuickJoinRoomClick);
}

function getMqttCommandTopic() {
  // Optional overrides:
  // - ?cmd_topic=v301/ugv/commands/<id>
  // - ?device=<id>  (builds v301/ugv/commands/<id>)
  try {
    const params = new URLSearchParams(window.location.search);
    const cmdTopic = (params.get('cmd_topic') || '').trim();
    if (cmdTopic) return cmdTopic;
    const device = (params.get('device') || '').trim();
    if (device) return `v301/ugv/commands/${device}`;
  } catch {
    // ignore
  }

  if (inferredDeviceId) {
    return `v301/ugv/commands/${inferredDeviceId}`;
  }
  return null;
}

function mqttPublishJson(obj) {
  if (!mqttSocket || !mqttBridgeConnected) {
    setRobotMqttStatus('MQTT bridge not connected');
    return;
  }
  if (!mqttBrokerConnected) {
    setRobotMqttStatus('MQTT broker not connected');
    return;
  }

  const topic = getMqttCommandTopic();
  if (!topic) {
    setRobotMqttStatus('No device yet (wait telemetry)');
    return;
  }

  const payload = JSON.stringify(obj);
  mqttSocket.emit('mqtt_publish', { topic, payload }, (ack) => {
    if (ack && ack.ok) {
      setRobotMqttStatus(`Sent MQTT command → ${topic}`);
      return;
    }
    const err = (ack && ack.error) ? ack.error : 'Publish failed';
    setRobotMqttStatus(`MQTT publish failed: ${err}`);
  });
}

function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => {
    setChatStatus('Connected');
    setChatEnabled(true);
    setRobotDcStatus('Connected');
    setRobotControlsEnabled(true);
  };
  dataChannel.onclose = () => {
    setChatStatus('Closed');
    setChatEnabled(false);
    setRobotDcStatus('Closed');
    setRobotControlsEnabled(false);
  };
  dataChannel.onerror = (err) => {
    console.error('DataChannel error:', err);
  };
  dataChannel.onmessage = (event) => {
    const payloadText = String(event.data ?? '');
    appendChatMessage('Peer', payloadText);
    try {
      const parsed = JSON.parse(payloadText);
      if (parsed && typeof parsed === 'object' && 't' in parsed && 'v' in parsed) {
        console.log('Received robot command:', parsed);
      }
    } catch {
      // Ignore non-JSON messages
    }
  };
}

function initRobotUi() {
  robotEls.status = document.querySelector('#robotStatus');
  robotEls.buttons = Array.from(document.querySelectorAll('[data-cmd]'));
  robotEls.mqttButtons = robotEls.buttons.filter((btn) => (btn.getAttribute('data-transport') || '') === 'mqtt');
  robotEls.dcButtons = robotEls.buttons.filter((btn) => (btn.getAttribute('data-transport') || '') !== 'mqtt');
  robotEls.servo1Slider = document.querySelector('#servo1Pot');
  robotEls.servo2Slider = document.querySelector('#servo2Pot');
  robotEls.speedSlider = document.querySelector('#speedPot');
  robotEls.servo1Value = document.querySelector('#servo1Value');
  robotEls.servo2Value = document.querySelector('#servo2Value');
  robotEls.speedValue = document.querySelector('#speedValue');

  if (!robotEls.status || robotEls.buttons.length === 0 || !robotEls.servo1Slider || !robotEls.servo2Slider || !robotEls.speedSlider) {
    console.warn('Robot UI elements not found; robot controls disabled.');
    return;
  }

  setRobotControlsEnabled(false);
  setMqttButtonsEnabled(false);
  setRobotDcStatus('Not connected');
  setRobotMqttStatus('MQTT disconnected');

  robotEls.buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmdKey = btn.getAttribute('data-cmd');
      sendRobotCommandByKey(cmdKey);
    });
  });

  bindServoSlider(robotEls.servo1Slider, robotEls.servo1Value, 'servo1');
  bindServoSlider(robotEls.servo2Slider, robotEls.servo2Value, 'servo2');
  bindSpeedSlider(robotEls.speedSlider, robotEls.speedValue);
}

function setRobotStatus(text) {
  // Backward-compatible alias for existing callers.
  setRobotDcStatus(text);
}

function renderRobotStatus() {
  if (!robotEls.status) return;
  robotEls.status.textContent = `DC: ${robotDcStatusText} | MQTT: ${robotMqttStatusText}`;
}

function setRobotDcStatus(text) {
  robotDcStatusText = text;
  renderRobotStatus();
}

function setRobotMqttStatus(text) {
  robotMqttStatusText = text;
  renderRobotStatus();
}

function setRobotControlsEnabled(enabled) {
  const buttons = robotEls.dcButtons || robotEls.buttons;
  buttons.forEach((btn) => {
    btn.disabled = !enabled;
  });
  if (robotEls.servo1Slider) robotEls.servo1Slider.disabled = !enabled;
  if (robotEls.servo2Slider) robotEls.servo2Slider.disabled = !enabled;
  if (robotEls.speedSlider) robotEls.speedSlider.disabled = !enabled;
}

function setMqttButtonsEnabled(enabled) {
  const buttons = robotEls.mqttButtons || [];
  buttons.forEach((btn) => {
    btn.disabled = !enabled;
  });
}

function bindSpeedSlider(sliderEl, valueEl) {
  if (!sliderEl) return;

  const updateLabel = () => {
    if (valueEl) valueEl.textContent = sliderEl.value;
  };

  updateLabel();
  sliderEl.addEventListener('input', updateLabel);
  sliderEl.addEventListener('change', updateLabel);
}

function getCurrentSpeedValue() {
  if (!robotEls.speedSlider) return DEFAULT_CMD_V;
  const raw = Number(robotEls.speedSlider.value);
  const speed = Number.isFinite(raw) ? Math.max(0, Math.min(255, Math.round(raw))) : DEFAULT_CMD_V;
  robotEls.speedSlider.value = String(speed);
  if (robotEls.speedValue) robotEls.speedValue.textContent = String(speed);
  return speed;
}

function bindServoSlider(sliderEl, valueEl, servoKey) {
  if (!sliderEl) return;

  const updateLabel = () => {
    if (valueEl) valueEl.textContent = sliderEl.value;
  };

  const sendValue = () => {
    const raw = Number(sliderEl.value);
    const angle = Number.isFinite(raw) ? Math.max(0, Math.min(180, Math.round(raw))) : 0;
    sliderEl.value = String(angle);
    updateLabel();
    sendServoCommand(servoKey, angle);
  };

  updateLabel();
  sliderEl.addEventListener('input', sendValue);
  sliderEl.addEventListener('change', sendValue);
}

function sendServoCommand(servoKey, angle) {
  const t = SERVO_CMD_MAP[servoKey];
  if (!t) {
    console.warn('Unknown servo key:', servoKey);
    return;
  }
  sendRobotPayload({ t, v: angle });
}

function sendRobotCommandByKey(cmdKey) {
  if (!cmdKey) return;
  const cmd = ROBOT_CMD_MAP[cmdKey];
  if (!cmd) {
    console.warn('Unknown robot command key:', cmdKey);
    return;
  }
  const payload = { ...cmd };
  if (payload.v === DEFAULT_CMD_V) {
    payload.v = getCurrentSpeedValue();
  }

  if (MQTT_CMD_KEYS.has(cmdKey)) {
    mqttPublishJson(payload);
    return;
  }

  sendRobotPayload(payload);
}

function sendRobotPayload(payload) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    setRobotDcStatus('Not connected');
    setRobotControlsEnabled(false);
    return;
  }
  const jsonText = JSON.stringify(payload);
  dataChannel.send(jsonText);
  console.log('Sent robot command (DataChannel):', jsonText);
}

function sendChatMessage() {
  if (!chatEls.input) return;
  const text = chatEls.input.value.trim();
  if (!text) return;
  if (!dataChannel || dataChannel.readyState !== 'open') {
    setChatStatus('Not connected');
    return;
  }
  dataChannel.send(text);
  appendChatMessage('Me', text);
  chatEls.input.value = '';
  chatEls.input.focus();
}

function init() {
  document.querySelector('#cameraBtn').addEventListener('click', openUserMedia);
  document.querySelector('#hangupBtn').addEventListener('click', hangUp);
  document.querySelector('#createBtn').addEventListener('click', createRoom);
  document.querySelector('#joinBtn').addEventListener('click', joinRoom);
  roomDialog = new mdc.dialog.MDCDialog(document.querySelector('#room-dialog'));

  initChatUi();
  initRobotUi();
  initMqttUi();
  initQuickJoinUi();
  initJoystickUi();

  // Optional auto-create / auto-join via URL params.
  // Examples:
  //   ?room_create=test_test
  //   ?room_join=test_test
  autoStartFromUrl().catch(err => {
    console.warn('Auto start from URL failed:', err);
  });
}

async function autoStartFromUrl() {
  const { action, roomId: requestedRoomId } = getRoomActionFromUrl();
  if (!action) return;

  if (!isValidRoomId(requestedRoomId)) {
    console.warn('Ignoring invalid room id from URL:', requestedRoomId);
    return;
  }

  // The existing flow requires camera to be opened first.
  // This will prompt for permissions if not already granted.
  try {
    await openUserMedia();
  } catch (err) {
    console.error('Failed to open user media for auto start:', err);
    document.querySelector('#currentRoom').innerText =
      'Camera/mic permission is required to auto create/join a room.';
    throw err;
  }

  if (action === 'create') {
    await createRoomWithId(requestedRoomId);
  } else if (action === 'join') {
    await joinRoomWithId(requestedRoomId);
  }
}

async function createRoom() {
  return createRoomInternal();
}

async function createRoomWithId(customRoomId) {
  return createRoomInternal(customRoomId);
}

async function createRoomInternal(customRoomId) {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
  const db = firebase.firestore();

  console.log('Create PeerConnection with configuration: ', configuration);
  peerConnection = new RTCPeerConnection(configuration);

  // Caller creates the DataChannel.
  setupDataChannel(peerConnection.createDataChannel('chat'));
  setChatStatus('Connecting...');

  registerPeerConnectionListeners();

  try {
    // Add code for creating a room here
    const roomRef = customRoomId
      ? db.collection('rooms').doc(customRoomId)
      : db.collection('rooms').doc();

    if (customRoomId) {
      const existing = await roomRef.get();
      if (existing.exists) {
        document.querySelector('#currentRoom').innerText =
          `Room id ${customRoomId} already exists. Use ?room_join=${customRoomId} to join instead.`;
        document.querySelector('#createBtn').disabled = false;
        document.querySelector('#joinBtn').disabled = false;
        setChatStatus('Not connected');
        setChatEnabled(false);
        try {
          peerConnection.close();
        } catch {
          // ignore
        }
        peerConnection = null;
        return;
      }
    }

    roomId = roomRef.id;
    document.querySelector('#currentRoom').innerText = `Current room is ${roomId} - You are the caller!`;
  
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  const callerCandidatesCollection = roomRef.collection('callerCandidates');
  peerConnection.addEventListener('icecandidate', event => {
    if (!event.candidate) {
      console.log('Got final candidate!');
      return;
    }
    console.log('Got candidate: ', event.candidate);
    callerCandidatesCollection.add(event.candidate.toJSON());
  });

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  const roomWithOffer = {
    offer: {
      type: offer.type,
      sdp: offer.sdp,
    },
  };
    await roomRef.set(roomWithOffer);

  peerConnection.addEventListener('track', event => {
    console.log('Got remote track:', event.streams[0]);
    event.streams[0].getTracks().forEach(track => {
      console.log('Add a track to the remoteStream:', track);
      remoteStream.addTrack(track);
    });
  });

  // Listening for remote session description below
    roomRef.onSnapshot(async snapshot => {
      const data = snapshot.data();
      if (!peerConnection.currentRemoteDescription && data && data.answer) {
        console.log('Got remote description: ', data.answer);
        const rtcSessionDescription = new RTCSessionDescription(data.answer);
        await peerConnection.setRemoteDescription(rtcSessionDescription);
      }
    });

  // Listen for remote ICE candidates below
    roomRef.collection('calleeCandidates').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          const data = change.doc.data();
          console.log('Got new remote ICE candidate: ', data);
          await peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
  } catch (err) {
    console.error('Failed to create room (Firestore)', err);
    setChatStatus('Not connected');
    setChatEnabled(false);
    document.querySelector('#currentRoom').innerText = 'Failed to create room. Check Firestore is enabled and you are online.';
    document.querySelector('#createBtn').disabled = false;
    document.querySelector('#joinBtn').disabled = false;
    throw err;
  }
}

function joinRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;

  document.querySelector('#confirmJoinBtn').
      addEventListener('click', async () => {
        roomId = document.querySelector('#room-id').value;
        console.log('Join room: ', roomId);
        document.querySelector(
            '#currentRoom').innerText = `Current room is ${roomId} - You are the callee!`;
        await joinRoomById(roomId);
      }, {once: true});
  roomDialog.open();
}

async function joinRoomWithId(customRoomId) {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;

  roomId = customRoomId;
  console.log('Join room (URL): ', roomId);
  document.querySelector('#currentRoom').innerText =
    `Current room is ${roomId} - You are the callee!`;
  await joinRoomById(roomId);
}

async function joinRoomById(roomId) {
  const db = firebase.firestore();
  const roomRef = db.collection('rooms').doc(`${roomId}`);
  let roomSnapshot;
  try {
    roomSnapshot = await roomRef.get();
  } catch (err) {
    console.error('Failed to join room (Firestore)', err);
    document.querySelector('#currentRoom').innerText = 'Failed to join room. Check Firestore is enabled and you are online.';
    document.querySelector('#createBtn').disabled = false;
    document.querySelector('#joinBtn').disabled = false;
    throw err;
  }
  console.log('Got room:', roomSnapshot.exists);

  if (!roomSnapshot.exists) {
    document.querySelector('#currentRoom').innerText =
      `Room id ${roomId} was not found. Ask the caller to create it first.`;
    document.querySelector('#createBtn').disabled = false;
    document.querySelector('#joinBtn').disabled = false;
    return;
  }

  if (roomSnapshot.exists) {
    console.log('Create PeerConnection with configuration: ', configuration);
    peerConnection = new RTCPeerConnection(configuration);
    registerPeerConnectionListeners();

    // Callee receives the DataChannel.
    peerConnection.addEventListener('datachannel', event => {
      console.log('Received DataChannel');
      setupDataChannel(event.channel);
      setChatStatus('Connecting...');
    });

    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Code for collecting ICE candidates below
    const calleeCandidatesCollection = roomRef.collection('calleeCandidates');
    peerConnection.addEventListener('icecandidate', event => {
      if (!event.candidate) {
        console.log('Got final candidate!');
        return;
      }
      console.log('Got candidate: ', event.candidate);
      calleeCandidatesCollection.add(event.candidate.toJSON());
    });

    peerConnection.addEventListener('track', event => {
      console.log('Got remote track:', event.streams[0]);
      event.streams[0].getTracks().forEach(track => {
        console.log('Add a track to the remoteStream:', track);
        remoteStream.addTrack(track);
      });
    });

    // Code for creating SDP answer below
    const offer = roomSnapshot.data().offer;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    const roomWithAnswer = {
      answer: {
        type: answer.type,
        sdp: answer.sdp,
      },
    };
    await roomRef.update(roomWithAnswer);

    // Listening for remote ICE candidates below
    roomRef.collection('callerCandidates').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          const data = change.doc.data();
          console.log('Got new remote ICE candidate: ', data);
          await peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
  }
}

async function openUserMedia(e) {
  //console.log(navigator.mediaDevices);
  console.log("console here 01");
  const stream = await navigator.mediaDevices.getUserMedia(
      {video: true, audio: true});
  document.querySelector('#localVideo').srcObject = stream;
  localStream = stream;
  remoteStream = new MediaStream();
  document.querySelector('#remoteVideo').srcObject = remoteStream;

  console.log('Stream:', document.querySelector('#localVideo').srcObject);
  document.querySelector('#cameraBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = false;
  document.querySelector('#createBtn').disabled = false;
  document.querySelector('#hangupBtn').disabled = false;
  console.log("Console here 02");
}

async function hangUp(e) {
  const tracks = document.querySelector('#localVideo').srcObject.getTracks();
  tracks.forEach(track => {
    track.stop();
  });

  if (remoteStream) {
    remoteStream.getTracks().forEach(track => track.stop());
  }

  if (peerConnection) {
    peerConnection.close();
  }

  if (dataChannel) {
    try {
      dataChannel.close();
    } catch (err) {
      console.warn('Error closing DataChannel', err);
    }
    dataChannel = null;
  }

  setChatEnabled(false);
  setChatStatus('Not connected');

  setRobotControlsEnabled(false);
  setRobotStatus('Not connected');

  document.querySelector('#localVideo').srcObject = null;
  document.querySelector('#remoteVideo').srcObject = null;
  document.querySelector('#cameraBtn').disabled = false;
  document.querySelector('#joinBtn').disabled = true;
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = true;
  document.querySelector('#currentRoom').innerText = '';

  // Delete room on hangup
  if (roomId) {
    try {
      const db = firebase.firestore();
      const roomRef = db.collection('rooms').doc(roomId);
      const calleeCandidates = await roomRef.collection('calleeCandidates').get();
      calleeCandidates.forEach(async candidate => {
        await candidate.delete();
      });
      const callerCandidates = await roomRef.collection('callerCandidates').get();
      callerCandidates.forEach(async candidate => {
        await candidate.delete();
      });
      await roomRef.delete();
    } catch (err) {
      console.warn('Failed to delete room (Firestore). This can happen offline:', err);
    }
  }

  document.location.reload(true);
}

function registerPeerConnectionListeners() {
  peerConnection.addEventListener('icegatheringstatechange', () => {
    console.log(
        `ICE gathering state changed: ${peerConnection.iceGatheringState}`);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    console.log(`Connection state change: ${peerConnection.connectionState}`);
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    console.log(`Signaling state change: ${peerConnection.signalingState}`);
  });

  peerConnection.addEventListener('iceconnectionstatechange ', () => {
    console.log(
        `ICE connection state change: ${peerConnection.iceConnectionState}`);
  });
}

init();
