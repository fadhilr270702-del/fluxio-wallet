import React from 'react';

/**
 * Status/level pill used in the announcements table and form. `kind`
 * selects which set of values `value` is drawn from — keeps the CSS class
 * name unambiguous (e.g. a 'published' status pill and an 'info' level pill
 * never collide since they're different `kind`s even if a value string
 * ever matched by coincidence).
 */
export default function Badge({ value, kind = 'status' }) {
  return <span className={`badge badge--${value}`} data-kind={kind}>{value}</span>;
}
