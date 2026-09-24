/**
 * `01`, `02`, … as the contents rail and the pages number their sections.
 *
 * Its own module rather than beside `ContentsRail`, because that file is
 * `'use client'` and a server component cannot call a function exported from one.
 */
export const sectionNumber = (index: number): string => String(index + 1).padStart(2, '0');
