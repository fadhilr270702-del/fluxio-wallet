import React from 'react';

const STROKE = { stroke: 'currentColor', strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' };

export default function Icon({ name, className = 'icon' }) {
  switch (name) {
    case 'search':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M21 21l-4.35-4.35" {...STROKE}/><circle cx="11" cy="11" r="6" {...STROKE}/></svg>);
    case 'bell':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M15 17H9a3 3 0 0 1-3-3V10a6 6 0 1 1 12 0v4a3 3 0 0 1-3 3z" {...STROKE}/></svg>);
    case 'dashboard':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zM13 21h8V11h-8v10zM13 3v6h8V3h-8zM3 21h8v-6H3v6z" fill="currentColor"/></svg>);
    case 'wallet':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M2 7h18v10H2z" {...STROKE}/><circle cx="18" cy="12" r="1.5" fill="currentColor"/></svg>);
    case 'swap':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M7 7l-4 4 4 4" {...STROKE}/><path d="M17 17l4-4-4-4" {...STROKE}/></svg>);
    case 'nft':
      return (<svg className={className} viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" {...STROKE}/></svg>);

    case 'shield':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" {...STROKE}/></svg>);
    case 'check-shield':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" {...STROKE}/><path d="M9 12l2 2 4-4" {...STROKE}/></svg>);
    case 'key':
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="8" cy="15" r="4" {...STROKE}/><path d="M11 12l9-9M17 6l3 3M14 9l2.5 2.5" {...STROKE}/></svg>);
    case 'lock':
      return (<svg className={className} viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2.5" {...STROKE}/><path d="M8 11V7a4 4 0 0 1 8 0v4" {...STROKE}/></svg>);
    case 'link':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M9 15l6-6" {...STROKE}/><path d="M10 6.5l1-1a4 4 0 0 1 5.5 5.5l-1.5 1.5" {...STROKE}/><path d="M14 17.5l-1 1a4 4 0 0 1-5.5-5.5l1.5-1.5" {...STROKE}/></svg>);
    case 'layers':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5 9-5z" {...STROKE}/><path d="M3 13l9 5 9-5" {...STROKE}/></svg>);
    case 'puzzle':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M9 4h4a1.5 1.5 0 0 1 0 3 2 2 0 1 0 0 4 1.5 1.5 0 0 1 0 3v3H4v-4a1.5 1.5 0 0 1 3 0 2 2 0 1 0 4 0 1.5 1.5 0 0 1-3 0V9H4V4h5z" {...STROKE}/></svg>);
    case 'eye-off':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M3 3l18 18" {...STROKE}/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c5 0 9 3.6 10 7-.5 1.6-1.5 3-2.7 4.1M6.6 6.6C4.6 7.9 3.1 9.8 2 12c1 3.4 5 7 10 7 1.4 0 2.7-.3 3.9-.8" {...STROKE}/><path d="M9.9 10a3 3 0 0 0 4.1 4.1" {...STROKE}/></svg>);
    case 'zap':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" {...STROKE}/></svg>);
    case 'globe':
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" {...STROKE}/><path d="M3 12h18M12 3c2.5 2.5 4 5.8 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.8-4-9s1.5-6.5 4-9z" {...STROKE}/></svg>);
    case 'sprout':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M12 21v-9" {...STROKE}/><path d="M12 12c0-4 3-6 7-6 0 4-3 6-7 6z" {...STROKE}/><path d="M12 14c0-3.2-2.4-4.8-5.6-4.8 0 3.2 2.4 4.8 5.6 4.8z" {...STROKE}/></svg>);
    case 'arrow-right':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6" {...STROKE}/></svg>);
    case 'download':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5" {...STROKE}/><path d="M4 19h16" {...STROKE}/></svg>);
    case 'github':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-3.16 19.5c.5.1.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.35 1.08 2.92.83.09-.65.35-1.08.64-1.33-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.3 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" fill="currentColor"/></svg>);
    // Added for the Privacy Policy page (prompt 0122 Revision 1) — no
    // existing icon fit "policy changes over time" or "contact"; checked
    // the full switch above first, per that prompt's own instruction to
    // only add new inline SVG when nothing already matches.
    case 'clock':
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" {...STROKE}/><path d="M12 7v5l3.5 2" {...STROKE}/></svg>);
    case 'mail':
      return (<svg className={className} viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" {...STROKE}/><path d="M4 7l8 6 8-6" {...STROKE}/></svg>);
    default:
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" {...STROKE}/></svg>);
  }
}
