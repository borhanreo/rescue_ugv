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

const robotEls = {
  status: null,
  buttons: [],
};

const DEFAULT_CMD_V = '100';

const ROBOT_CMD_MAP = {
  forward: { t: 1, v: DEFAULT_CMD_V },
  back: { t: 2, v: DEFAULT_CMD_V },
  left: { t: 3, v: DEFAULT_CMD_V },
  right: { t: 4, v: DEFAULT_CMD_V },

  // Defaults for the additional requested buttons.
  // If your robot uses different codes/values, change these.
  pos_hold: { t: 5, v: DEFAULT_CMD_V },
  alt_hold: { t: 6, v: DEFAULT_CMD_V },
  extra_1: { t: 7, v: DEFAULT_CMD_V },
  extra_2: { t: 8, v: DEFAULT_CMD_V },
  extra_3: { t: 9, v: DEFAULT_CMD_V },
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

  if (!robotEls.status || robotEls.buttons.length === 0) {
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
}

function setRobotStatus(text) {
  if (robotEls.status) robotEls.status.textContent = text;
}

function setRobotControlsEnabled(enabled) {
  robotEls.buttons.forEach((btn) => {
    btn.disabled = !enabled;
  });
}

function sendRobotCommandByKey(cmdKey) {
  if (!cmdKey) return;
  const cmd = ROBOT_CMD_MAP[cmdKey];
  if (!cmd) {
    console.warn('Unknown robot command key:', cmdKey);
    return;
  }
  if (!dataChannel || dataChannel.readyState !== 'open') {
    setRobotStatus('Not connected');
    return;
  }
  const jsonText = JSON.stringify(cmd);
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
