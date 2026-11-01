import React from 'react';

// Mirrors apps/web/src/components/Icon.jsx's stroke-icon pattern (same
// STROKE constants, same switch-on-name shape) but only carries the names
// the admin panel actually uses — no marketing-site icons here.
const STROKE = { stroke: 'currentColor', strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' };

export default function Icon({ name, className = 'icon' }) {
  switch (name) {
    case 'dashboard':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zM13 21h8V11h-8v10zM13 3v6h8V3h-8zM3 21h8v-6H3v6z" fill="currentColor"/></svg>);
    case 'megaphone':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M3 10v4a1 1 0 0 0 1 1h2l1 5h2l-1-5h2l8 4V6l-8 4H4a1 1 0 0 0-1 1z" {...STROKE}/></svg>);
    case 'broadcast':
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.4" fill="currentColor"/><path d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5 5a9.8 9.8 0 0 0 0 14M19 5a9.8 9.8 0 0 1 0 14" {...STROKE}/></svg>);
    case 'chart':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M4 20V10M11 20V4M18 20v-7" {...STROKE}/><path d="M2 20h20" {...STROKE}/></svg>);
    case 'settings':
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" {...STROKE}/><path d="M19.4 13a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V19a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H4a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H10a1.7 1.7 0 0 0 1-1.55V4a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V10a1.7 1.7 0 0 0 1.55 1H20a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" {...STROKE}/></svg>);
    case 'logout':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" {...STROKE}/><path d="M16 17l5-5-5-5" {...STROKE}/><path d="M21 12H9" {...STROKE}/></svg>);
    case 'plus':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" {...STROKE}/></svg>);
    case 'edit':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" {...STROKE}/></svg>);
    case 'trash':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" {...STROKE}/></svg>);
    case 'check-shield':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" {...STROKE}/><path d="M9 12l2 2 4-4" {...STROKE}/></svg>);
    case 'layers':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5 9-5z" {...STROKE}/><path d="M3 13l9 5 9-5" {...STROKE}/></svg>);
    case 'lock':
      return (<svg className={className} viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2.5" {...STROKE}/><path d="M8 11V7a4 4 0 0 1 8 0v4" {...STROKE}/></svg>);
    case 'eye-off':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M3 3l18 18" {...STROKE}/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c5 0 9 3.6 10 7-.5 1.6-1.5 3-2.7 4.1M6.6 6.6C4.6 7.9 3.1 9.8 2 12c1 3.4 5 7 10 7 1.4 0 2.7-.3 3.9-.8" {...STROKE}/><path d="M9.9 10a3 3 0 0 0 4.1 4.1" {...STROKE}/></svg>);
    case 'send':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M21 3L3 10.5l7.5 2.5M21 3l-7.5 18-2.5-8M21 3L10.5 13" {...STROKE}/></svg>);
    case 'users':
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2" {...STROKE}/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" {...STROKE}/><path d="M16 8.5a3 3 0 1 1 1 5.8" {...STROKE}/><path d="M15.5 14.3c2.5.4 4.5 2.7 4.5 5.7" {...STROKE}/></svg>);
    case 'refresh':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.6" {...STROKE}/><path d="M4 4v4.6h4.6" {...STROKE}/><path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.4" {...STROKE}/><path d="M20 20v-4.6h-4.6" {...STROKE}/></svg>);
    case 'clock':
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" {...STROKE}/><path d="M12 7v5l3.5 2" {...STROKE}/></svg>);
    case 'sun':
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2" {...STROKE}/><path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" {...STROKE}/></svg>);
    case 'moon':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" {...STROKE}/></svg>);
    case 'link':
      return (<svg className={className} viewBox="0 0 24 24"><path d="M9.5 14.5l5-5" {...STROKE}/><path d="M11 6.5l1.4-1.4a4 4 0 0 1 5.6 5.6L16.5 12" {...STROKE}/><path d="M13 17.5l-1.4 1.4a4 4 0 0 1-5.6-5.6L7.5 12" {...STROKE}/></svg>);
    case 'image':
      return (<svg className={className} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5" {...STROKE}/><circle cx="8.5" cy="9.5" r="1.6" {...STROKE}/><path d="M21 16l-5.5-5.5a2 2 0 0 0-2.8 0L4 19" {...STROKE}/></svg>);
    case 'video':
      // Added in prompt 0132 for "Broadcast terakhir" cards' media badge —
      // distinguishes a video attachment from 'image' above rather than
      // reusing the same icon for both (the prompt's own explicit request).
      return (<svg className={className} viewBox="0 0 24 24"><rect x="3" y="5" width="14" height="14" rx="2.5" {...STROKE}/><path d="M17 9.5l4-2.5v10l-4-2.5z" {...STROKE}/></svg>);
    case 'copy':
      // Added in prompt 0132 for the "Salin ke form" button on each recent
      // broadcast card.
      return (<svg className={className} viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2.2" {...STROKE}/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" {...STROKE}/></svg>);
    case 'smile':
      // Added in prompt 0147 for EmojiPickerButton's trigger — a plain
      // stroke smiley, matching this file's own icon language, rather than
      // a raw emoji character (which would look visually inconsistent next
      // to every other SVG toolbar/icon-btn icon here).
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" {...STROKE}/><path d="M8.5 10h.01M15.5 10h.01" {...STROKE}/><path d="M8 14.5a4.5 4.5 0 0 0 8 0" {...STROKE}/></svg>);
    default:
      return (<svg className={className} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" {...STROKE}/></svg>);
  }
}
