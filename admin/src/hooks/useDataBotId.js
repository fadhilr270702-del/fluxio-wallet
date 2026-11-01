import { useContext } from 'react';
import { DataBotContext } from '../app/DataBotContext.jsx';

/**
 * Same split-into-its-own-file reasoning as `useBotContext.js` — keeps
 * "which component owns the state" unambiguous. Deliberately does NOT
 * throw when used outside a `<DataBotProvider>` (unlike `useBotContext()`,
 * which does) — see `DataBotContext.jsx`'s own header for why: this
 * context is optional/scoped by design, not an app-wide hard requirement,
 * so reading it with no provider installed is a normal, expected case
 * (every real leaf consumer treats the resulting `null` as "no context
 * value available" via `resolveDataBotId()`, not as an error on its own).
 */
export default function useDataBotId() {
  return useContext(DataBotContext);
}
