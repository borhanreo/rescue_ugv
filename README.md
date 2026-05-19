# Firebase + WebRTC Codelab
### Full code solution can be found under the branch: _solution_
This is the GitHub repo for the FirebaseRTC codelab. This will teach you how 
to use Firebase Cloud Firestore for signalling in a WebRTC video chat application.

The solution to this codelab can be seen in the _solution_ branch.

See http://webrtc.org for details.

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
```sudo node proxy-server.js ```