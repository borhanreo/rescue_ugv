const https = require('https');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mqtt = require('mqtt');
const { Server } = require('socket.io');

dotenv.config({ path: path.resolve(__dirname, '.env') });


const HTTPS_PORT = Number(process.env.HTTPS_PORT || 443);
const FIREBASE_TARGET = process.env.FIREBASE_TARGET || 'http://127.0.0.1:5500';
const MQTT_PROTOCOL = process.env.MQTT_PROTOCOL || 'mqtt';
const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || `rescue-web-${Math.random().toString(16).slice(2, 10)}`;
const MQTT_SUBSCRIBE_TOPIC = process.env.MQTT_SUBSCRIBE_TOPIC || '#';
const MQTT_PUBLISH_TOPIC = process.env.MQTT_PUBLISH_TOPIC || '';

const proxy = httpProxy.createProxyServer({
  target: FIREBASE_TARGET,
  ws: true
});

const options = {
  key: fs.readFileSync('./cert/server.key'),
  cert: fs.readFileSync('./cert/server.crt')
};

let mqttMessageCount = 0;
let lastMqttMessage = null;

const httpsServer = https.createServer(options, (req, res) => {
  if (req.url === '/health') {
    const body = JSON.stringify(
      {
        ok: true,
        proxyTarget: FIREBASE_TARGET,
        mqtt: {
          url: `${MQTT_PROTOCOL}://${MQTT_HOST}:${MQTT_PORT}`,
          connected: mqttClient.connected,
          topic: MQTT_SUBSCRIBE_TOPIC,
          messageCount: mqttMessageCount,
          lastMessage: lastMqttMessage,
        },
        socket: {
          clients: io.engine && typeof io.engine.clientsCount === 'number' ? io.engine.clientsCount : undefined,
        },
        timestamp: new Date().toISOString(),
      },
      null,
      2
    );
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }
  if (req.url && req.url.split('?')[0] === '/v_laser.txt') {
    const laserFilePath = path.join(__dirname, 'public', 'v_laser.txt');
    fs.readFile(laserFilePath, 'utf8', (err, fileContent) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="v_laser.txt"',
        'Cache-Control': 'no-store',
      });
      res.end(fileContent);
    });
    return;
  }
  if (req.url && req.url.startsWith('/socket.io/')) {
    return;
  }
  proxy.web(req, res);
});

const io = new Server(httpsServer, {
  serveClient: true,
  cors: {
    origin: '*',
  },
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
  }
  if (res) {
    res.end(JSON.stringify({ error: 'Proxy target unavailable' }));
  }
});

httpsServer.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/socket.io/')) {
    return;
  }
  proxy.ws(req, socket, head);
});

const mqttUrl = `${MQTT_PROTOCOL}://${MQTT_HOST}:${MQTT_PORT}`;
const mqttOptions = {
  clientId: MQTT_CLIENT_ID,
  reconnectPeriod: 2000,
};

if (MQTT_USERNAME) {
  mqttOptions.username = MQTT_USERNAME;
  mqttOptions.password = MQTT_PASSWORD;
}

const mqttClient = mqtt.connect(mqttUrl, mqttOptions);

io.on('connection', (socket) => {
  console.log(`Web client connected: ${socket.id}`);
  socket.emit('mqtt_status', {
    connected: mqttClient.connected,
    topic: MQTT_SUBSCRIBE_TOPIC,
  });

  socket.on('mqtt_publish', (message, ack) => {
    try {
      if (!mqttClient.connected) {
        const err = 'MQTT client not connected';
        if (typeof ack === 'function') ack({ ok: false, error: err });
        socket.emit('mqtt_publish_error', { error: err });
        return;
      }

      const topic = (message && typeof message === 'object' && typeof message.topic === 'string')
        ? message.topic.trim()
        : (MQTT_PUBLISH_TOPIC || '').trim();

      if (!topic) {
        const err = 'MQTT publish topic not set';
        if (typeof ack === 'function') ack({ ok: false, error: err });
        socket.emit('mqtt_publish_error', { error: err });
        return;
      }

      const payload = (message && typeof message === 'object' && typeof message.payload === 'string')
        ? message.payload
        : '';

      mqttClient.publish(topic, payload, { qos: 0, retain: false }, (err) => {
        if (err) {
          if (typeof ack === 'function') ack({ ok: false, error: err.message });
          socket.emit('mqtt_publish_error', { error: err.message, topic });
          return;
        }
        if (typeof ack === 'function') ack({ ok: true, topic });
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (typeof ack === 'function') ack({ ok: false, error: msg });
      socket.emit('mqtt_publish_error', { error: msg });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Web client disconnected: ${socket.id}`);
  });
});

mqttClient.on('connect', () => {
  console.log(`MQTT connected: ${mqttUrl}`);
  mqttClient.subscribe(MQTT_SUBSCRIBE_TOPIC, (err) => {
    if (err) {
      console.error('MQTT subscribe error:', err.message);
      io.emit('mqtt_status', { connected: false, topic: MQTT_SUBSCRIBE_TOPIC, error: err.message });
      return;
    }
    console.log(`MQTT subscribed: ${MQTT_SUBSCRIBE_TOPIC}`);
    io.emit('mqtt_status', { connected: true, topic: MQTT_SUBSCRIBE_TOPIC });
  });
});

mqttClient.on('reconnect', () => {
  io.emit('mqtt_status', { connected: false, topic: MQTT_SUBSCRIBE_TOPIC, reconnecting: true });
});

mqttClient.on('close', () => {
  io.emit('mqtt_status', { connected: false, topic: MQTT_SUBSCRIBE_TOPIC });
});

mqttClient.on('error', (err) => {
  console.error('MQTT error:', err.message);
  io.emit('mqtt_status', { connected: false, topic: MQTT_SUBSCRIBE_TOPIC, error: err.message });
});

mqttClient.on('message', (topic, payload) => {
  const payloadText = payload.toString('utf8');
  mqttMessageCount += 1;
  lastMqttMessage = {
    topic,
    payload: payloadText,
    timestamp: new Date().toISOString(),
  };
  console.log(`MQTT message received: topic=${topic}, payload=${payloadText}`);
  io.emit('mqtt_message', {
    topic,
    payload: payloadText,
    timestamp: new Date().toISOString(),
  });
});

httpsServer.listen(HTTPS_PORT, () => {
  console.log(`HTTPS proxy + MQTT bridge running at https://<your-public-ip>:${HTTPS_PORT}`);
  console.log(`Proxy target: ${FIREBASE_TARGET}`);
  console.log(`MQTT broker: ${mqttUrl}`);
  console.log(`MQTT topic: ${MQTT_SUBSCRIBE_TOPIC}`);
});