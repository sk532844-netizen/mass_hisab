// Firebase প্রজেক্টের সাথে সংযোগ — lazy init, যাতে env var না থাকলেও
// app crash না করে (শুধু "setup pending" নোটিশ দেখাবে)।
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// সবগুলো config মান আছে কিনা — UI-এ "setup pending" নোটিশের জন্য।
export function isConfigured() {
  return Object.values(firebaseConfig).every(
    (v) => typeof v === 'string' && v.length > 0,
  );
}

let db = null;

// Config না থাকলে বন্ধুত্বপূর্ণ বাংলা error — App.jsx এটা catch করে দেখায়।
export function getDb() {
  if (!isConfigured()) {
    throw new Error('Firebase সেটআপ এখনো হয়নি — FIREBASE_SETUP.md দেখে কনফিগ যোগ করো।');
  }
  if (!db) db = getFirestore(initializeApp(firebaseConfig));
  return db;
}
