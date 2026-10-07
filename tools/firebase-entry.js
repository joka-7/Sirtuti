// Only the Firebase pieces Sirtuti uses. Rebuild with: npm run build:firebase
export { initializeApp } from 'firebase/app';
export {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from 'firebase/auth';
export {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDocs, getDocsFromServer, setDoc, deleteDoc
} from 'firebase/firestore';
