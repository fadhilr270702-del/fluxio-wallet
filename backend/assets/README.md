# backend/assets/

Static assets referenced directly by backend code — not user uploads (those
stay purely in-memory per-request, see `adminTelegramBroadcastRoutes.js`'s
own multer setup), and not part of the database.

Currently holds exactly one expected file:

- `welcome-banner.png` — the image sent alongside the `/start` welcome
  reply (prompt 0135, `backend/src/telegram/welcome.js`). Optional: if this
  file isn't present, the welcome reply falls back to a plain text message
  with the same wording, no error. Checked fresh on every send (not cached
  at server startup), so dropping the file in later takes effect
  immediately, no restart needed.
