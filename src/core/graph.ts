// The lanes of a commit graph, drawn the way a desktop git client does. Pure: newest commit first in,
// one row of line segments per commit out. A lane is a column; a line runs from a lane in one half
// of a row to a lane in the other half (the dot sits at the middle of the row).

import type { LaneRow } from "./views.ts";

export interface LaneInput {
  sha: string;
  parents: string[];
}

export function layoutLanes(commits: LaneInput[]): { rows: LaneRow[]; lanes: number } {
  // active[i]: the commit lane i is waiting for, or null when free.
  const active: (string | null)[] = [];
  const rows: LaneRow[] = [];
  let width = 1;
  const free = (): number => {
    const at = active.indexOf(null);
    return at >= 0 ? at : active.length;
  };
  for (const commit of commits) {
    const ends = active.flatMap((sha, index) => (sha === commit.sha ? [index] : []));
    const lane = ends[0] ?? free();
    const top = active.flatMap((sha, from) => (sha === null ? [] : [{ from, to: ends.includes(from) ? lane : from }]));
    for (const end of ends) active[end] = null;
    const bottom: LaneRow["bottom"] = [];
    active.forEach((sha, index) => {
      if (sha !== null) bottom.push({ from: index, to: index });
    });
    commit.parents.forEach((parent, index) => {
      let target = active.indexOf(parent);
      if (target < 0) {
        target = index === 0 ? lane : free();
        active[target] = parent;
      }
      bottom.push({ from: lane, to: target });
    });
    while (active.length > 0 && active[active.length - 1] === null) active.pop();
    width = Math.max(width, lane + 1, active.length, ...top.map((line) => line.from + 1), ...bottom.map((line) => line.to + 1));
    rows.push({ lane, top, bottom });
  }
  return { rows, lanes: width };
}
