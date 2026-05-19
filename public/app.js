mdc.ripple.MDCRipple.attachTo(document.querySelector('.mdc-button'));

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
  };
  dataChannel.onclose = () => {
    setChatStatus('Closed');
    setChatEnabled(false);
  };
  dataChannel.onerror = (err) => {
    console.error('DataChannel error:', err);
  };
  dataChannel.onmessage = (event) => {
    appendChatMessage('Peer', String(event.data ?? ''));
  };
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
}

async function createRoom() {
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#joinBtn').disabled = true;
  const db = firebase.firestore();

  console.log('Create PeerConnection with configuration: ', configuration);
  peerConnection = new RTCPeerConnection(configuration);

  // Caller creates the DataChannel.
  setupDataChannel(peerConnection.createDataChannel('chat'));
  setChatStatus('Connecting...');

  registerPeerConnectionListeners();

  // Add code for creating a room here
  const roomRef = await db.collection('rooms').doc();
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

async function joinRoomById(roomId) {
  const db = firebase.firestore();
  const roomRef = db.collection('rooms').doc(`${roomId}`);
  const roomSnapshot = await roomRef.get();
  console.log('Got room:', roomSnapshot.exists);

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

  document.querySelector('#localVideo').srcObject = null;
  document.querySelector('#remoteVideo').srcObject = null;
  document.querySelector('#cameraBtn').disabled = false;
  document.querySelector('#joinBtn').disabled = true;
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = true;
  document.querySelector('#currentRoom').innerText = '';

  // Delete room on hangup
  if (roomId) {
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
