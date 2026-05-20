const https = require('https');
const httpProxy = require('http-proxy');
const fs = require('fs');

const proxy = httpProxy.createProxyServer({
  target: 'http://127.0.0.1:5500',
  ws: true
});

const options = {
  key: fs.readFileSync('./cert/server.key'),
  cert: fs.readFileSync('./cert/server.crt')
};

https.createServer(options, (req, res) => {
  proxy.web(req, res);
}).listen(443, () => {
  console.log('✅ HTTPS proxy running at https://<your-public-ip>');
});