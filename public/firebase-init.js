// Firebase Web SDK configuration.
// This app is served via proxy_server.js (not directly by Firebase Hosting),
// so the special "/__/firebase/init.js" endpoint that Firebase Hosting
// auto-generates is not reliably available (it requires "firebase serve" to
// be the one handling the request). This file replaces it with the same
// configuration values for project "fir-rtc-72050", so Firestore works
// regardless of how the page is served.
firebase.initializeApp({
  apiKey: "AIzaSyBv13TTEfg32xCWiZjnFdCRVidON5delQo",
  authDomain: "fir-rtc-72050.firebaseapp.com",
  databaseURL: "https://fir-rtc-72050-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "fir-rtc-72050",
  storageBucket: "fir-rtc-72050.firebasestorage.app",
  messagingSenderId: "435763490899",
});
