import React, { useEffect, useState } from 'react';

/**
 * Real-time clock + full date, filling what used to be empty space in the
 * middle of the topbar. Plain `Date`, ticks once a second — no server
 * round-trip, no library. Shows the browser's own local time/locale.
 */
export default function HeaderClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="header-clock">
      <span className="header-clock__time">
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </span>
      <span className="header-clock__date">
        {now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </span>
    </div>
  );
}
