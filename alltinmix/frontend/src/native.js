// Bridge to the phone (Capacitor). On the web every function here is a harmless no-op / fallback.
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Share } from '@capacitor/share';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';

export const isNative = Capacitor.isNativePlatform();
/** The public website address, used for share links. Set VITE_WEB_URL in the app build (see .env.app.example). */
export const webOrigin = (import.meta.env.VITE_WEB_URL || window.location.origin).replace(/\/$/, '');

/** Open a payment page (Stripe / PayPal / Flutterwave). Inside the app this is an in-app browser; on the web we simply navigate. */
export async function openPayment(url, onClosed) {
  if (!isNative) { window.location.href = url; return; }
  const handle = await Browser.addListener('browserFinished', () => { handle.remove(); onClosed?.(); });
  await Browser.open({ url, presentationStyle: 'fullscreen' });
}

export async function shareLink({ title, text, path }) {
  const url = `${webOrigin}${path}`;
  try {
    if (isNative) await Share.share({ title, text, url, dialogTitle: title });
    else if (navigator.share) await navigator.share({ title, text, url });
    else { await navigator.clipboard.writeText(url); return 'copied'; }
  } catch { /* the user closed the share sheet */ }
  return 'shared';
}

export async function setStatusBar(theme) {
  if (!isNative) return;
  try {
    await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light });
    if (Capacitor.getPlatform() === 'android') await StatusBar.setBackgroundColor({ color: theme === 'dark' ? '#14181F' : '#111111' });
  } catch { /* not supported on this device */ }
}

/** Call once at start-up: hides the splash screen and wires the Android back button. */
export function initNative(navigate) {
  if (!isNative) return () => {};
  SplashScreen.hide().catch(() => {});
  const sub = CapApp.addListener('backButton', () => {
    if (window.history.state && window.history.state.idx > 0) navigate(-1);
    else CapApp.exitApp();
  });
  return () => { sub.then((h) => h.remove()); };
}
