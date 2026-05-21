# Firebase + WebRTC Codelab
### Full code solution can be found under the branch: _solution_
This is the GitHub repo for the FirebaseRTC codelab. This will teach you how 
to use Firebase Cloud Firestore for signalling in a WebRTC video chat application.

The solution to this codelab can be seen in the _solution_ branch.

See http://webrtc.org for details.
### for firebases 
create firestore databases
### following this instruction
https://webrtc.org/getting-started/firebase-rtc-codelab

### Run command 
``` firebase serve --only hosting```
### run in cloud
```firebase serve --host 0.0.0.0 -p 5500```

## Required: Enable Cloud Firestore
This app uses **Cloud Firestore** for signalling (`rooms`, `callerCandidates`, `calleeCandidates`).

If you see errors like:
- `FirebaseError: The database (default) does not exist ...`
- `Could not reach Cloud Firestore backend`

Create/enable Firestore for your Firebase project:
1. Firebase Console → **Build** → **Firestore Database**
2. Click **Create database** (choose **Test mode** for quick demo)
3. Reload the page and try **Create room** / **Join room** again

This repo also includes a demo rule set in `firestore.rules`. To deploy rules:
```bash
firebase deploy --only firestore:rules
```

### for https install proxy server
```npm install http-proxy```
### Run proxy server
```sudo node proxy_server.js ```





# Auto start of Cloud machine

🧩 Step 1 – Create a Startup Script
We’ll combine both commands in one script.


### For webRTC server firebases
```sudo nano /usr/local/bin/start_firebase_and_proxy.sh```



bash

---
#!/bin/bash
# --------------------------------------
# Script: start_firebase_and_proxy.sh
# Purpose: Start Firebase and then Proxy Server
# --------------------------------------

cd /home/bjit/borhan/rescue_ugv || exit

# 1️⃣ Start Firebase and wait until it exits
echo "Starting Firebase Serve..."
cd /home/bjit/borhan/rescue_ugv
/usr/bin/firebase serve --host 0.0.0.0 -p 5500
echo "Firebase Done"
# 2️⃣ Start proxy server only after Firebase process completes
sleep 5
cd
cd /home/bjit/borhan/rescue_ugv
echo "Starting Proxy Server..."
sudo /usr/bin/node /home/bjit/borhan/rescue_ugv/proxy_server.js >> proxy.log 2>&1 &
echo "✅ Proxy server started!"
---
## Permission
```sudo chmod +x /usr/local/bin/start_firebase_and_proxy.sh```


### for Proxy server
```sudo nano /usr/local/bin/start_proxy.sh```


Now paste the following:
---
#!/bin/bash
# --------------------------------------
# Script: start_firebase_and_proxy.sh
# Purpose: Start Firebase and then Proxy Server
# --------------------------------------

cd /home/bjit/borhan/rescue_ugv || exit

# 1️⃣ Start Firebase and wait until it exits
cd /home/bjit/borhan/rescue_ugv
echo "Starting Proxy Server..."
sudo /usr/bin/node /home/bjit/borhan/rescue_ugv/proxy_server.js
echo "✅ Proxy server started!"
---
👉 Replace:

/home/youruser/my-firebase-project with your actual project directory
Paths to firebase and node if they differ (which firebase, which node)
Make it executable:

## permission
```sudo chmod +x /usr/local/bin/start_proxy.sh```


⚙️ Step 2 – Create a systemd Service
bash

### for firebaseWEBRTC server
```sudo nano /etc/systemd/system/firebase-proxy.service```

Paste this configuration:

ini

---
[Unit]
Description=Firebase + Proxy Startup Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bjit
WorkingDirectory=/home/bjit/borhan/rescue_ugv

ExecStart=/usr/local/bin/start_firebase_and_proxy.sh

Restart=on-failure

[Install]
WantedBy=multi-user.target
---

### for proxy server
```sudo nano /etc/systemd/system/proxy.service```



---
[Unit]
Description=Proxy Startup Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bjit
WorkingDirectory=/home/bjit/borhan/rescue_ugv

ExecStart=/usr/local/bin/start_proxy.sh

Restart=on-failure

[Install]
---
💡 Notes:

The service waits for the network to be online first
Uses your regular user, not root
If your proxy process needs root privileges, we’ll address that below 👇

 Edit /etc/sudoers securely using:

bash

### Open this 
```sudo visudo```
2️⃣ Add this line at the bottom (replace with your username and exact path):

### need to add button line 
```bjit ALL=(ALL) NOPASSWD: /usr/bin/node /home/bjit/borhan/rescue_ugv/proxy_server.js```


###⚡ Step 3 – Enable and Start the Service

```sudo systemctl daemon-reload```
```sudo systemctl enable firebase-proxy.service```
```sudo systemctl start firebase-proxy.service```
```sudo systemctl status firebase-proxy.service```
```sudo systemctl restart firebase-proxy.service```

### Show Log 
```sudo journalctl -u firebase-proxy.service -xe```


### For proxy service only
```sudo systemctl daemon-reload```
```sudo systemctl enable proxy.service```
```sudo systemctl start proxy.service```
```sudo systemctl status proxy.service```
```sudo systemctl restart proxy.service```