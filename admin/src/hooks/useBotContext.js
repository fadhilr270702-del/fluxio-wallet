import { useContext } from 'react';
import { BotContext } from '../app/BotContext.jsx';

/** Same split-into-its-own-file reasoning as useAuth.js — keeps "which component owns the state" unambiguous. */
export default function useBotContext() {
  const ctx = useContext(BotContext);
  if (!ctx) throw new Error('useBotContext() must be used within <BotContextProvider>');
  return ctx;
}
