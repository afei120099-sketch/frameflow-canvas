'use client';
import { useSyncExternalStore } from 'react';
import { AUTO_VOICE_KEY, AUTO_VOICE_EVENT, readAutoVoicePreference } from '../lib/h3-speaker-policy';
function subscribe(refresh: () => void) {
    window.addEventListener(AUTO_VOICE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener(AUTO_VOICE_EVENT, refresh); window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
}
export function useAutoRoleVoice() {
  const enabled = useSyncExternalStore(subscribe, readAutoVoicePreference, () => true);
  const change = (value: boolean) => {
    window.localStorage.setItem(AUTO_VOICE_KEY, String(value));
    window.dispatchEvent(new Event(AUTO_VOICE_EVENT));
  };
  return [enabled, change] as const;
}
