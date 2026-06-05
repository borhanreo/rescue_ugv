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
};

const SERVO_CMD_MAP = {
  servo1: 16,
  servo2: 17,
};

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

function connectMqttMonitor() {
  const bridgeOrigin = (() => {
    // 1) Explicit override via URL: ?bridge=https://your-public-ip[:port]
    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = (params.get('bridge') || '').trim();
      if (fromQuery) return fromQuery.replace(/\/$/, '');
    } catch {
      // ignore
    }

    // 2) Optional global override: window.MQTT_BRIDGE_ORIGIN = 'https://...'
    try {
      const fromGlobal = (window.MQTT_BRIDGE_ORIGIN || '').trim();
      if (fromGlobal) return fromGlobal.replace(/\/$/, '');
    } catch {
      // ignore
    }

    // 3) Heuristic default: if served from Firebase dev server (often :5500 over http),
    //    assume the bridge is the HTTPS proxy on the same hostname.
    const hostname = window.location.hostname;
    const isLikelyFirebaseDevServer = window.location.port === '5500' || window.location.protocol === 'http:';
    if (isLikelyFirebaseDevServer) return `https://${hostname}`;

    // Otherwise, same origin.
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

  setMqttStatus(`MQTT: Connecting to ${bridgeOrigin}...`);

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

    socket.on('connect', () => {
      setMqttStatus('MQTT: Web socket connected');
    });

    socket.on('disconnect', () => {
      setMqttStatus('MQTT: Web socket disconnected');
    });

    socket.on('connect_error', (err) => {
      const msg = (err && err.message) ? err.message : String(err || 'Unknown error');
      setMqttStatus(`MQTT: Web socket error - ${msg} (bridge: ${bridgeOrigin})`);
    });

    socket.on('mqtt_status', (status) => {
      if (!status || typeof status !== 'object') return;
      if (status.connected) {
        setMqttStatus(`MQTT: Connected (topic: ${status.topic || '#'})`);
        return;
      }
      if (status.reconnecting) {
        setMqttStatus('MQTT: Reconnecting...');
        return;
      }
      if (status.error) {
        setMqttStatus(`MQTT: Error - ${status.error}`);
        return;
      }
      setMqttStatus('MQTT: Disconnected');
    });

    socket.on('mqtt_message', (message) => {
      if (!message || typeof message !== 'object') return;
      appendMqttMessage(message.topic || '', message.payload || '', message.timestamp);
    });
  })();
}

function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => {
    setChatStatus('Connected');
    setChatEnabled(true);
    setRobotStatus('Connected');
    setRobotControlsEnabled(true);
  };
  dataChannel.onclose = () => {
    setChatStatus('Closed');
    setChatEnabled(false);
    setRobotStatus('Closed');
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
  setRobotStatus('Not connected');

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
  if (robotEls.status) robotEls.status.textContent = text;
}

function setRobotControlsEnabled(enabled) {
  robotEls.buttons.forEach((btn) => {
    btn.disabled = !enabled;
  });
  if (robotEls.servo1Slider) robotEls.servo1Slider.disabled = !enabled;
  if (robotEls.servo2Slider) robotEls.servo2Slider.disabled = !enabled;
  if (robotEls.speedSlider) robotEls.speedSlider.disabled = !enabled;
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
  sendRobotPayload(payload);
}

function sendRobotPayload(payload) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    setRobotStatus('Not connected');
    return;
  }
  const jsonText = JSON.stringify(payload);
  dataChannel.send(jsonText);
  console.log('Sent robot command:', jsonText);
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
