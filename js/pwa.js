// Service worker registration, install prompt and update checks.
import { isIOS, isStandalone } from './utils.js';

export const APP_VERSION = '1.0.0';
let deferredPrompt = null;
let registration = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function installState() {
  if (isStandalone()) return 'installed';
  if (deferredPrompt) return 'available';
  if (isIOS()) return 'ios';
  return 'unavailable';
}

export async function promptInstall() {
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  notify();
  return outcome === 'accepted';
}

export async function checkForUpdate() {
  if (!registration) return false;
  await registration.update();
  return !!(registration.installing || registration.waiting);
}

export function initPWA() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    notify();
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; notify(); });

  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!('serviceWorker' in navigator) || !secure) return;
  const register = async () => {
    try {
      registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    } catch (e) {
      console.warn('[ParMap] Service worker registration failed', e);
    }
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
