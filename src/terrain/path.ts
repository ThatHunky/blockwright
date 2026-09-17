/**
 * Polylines on the block grid: the cells a walker actually steps through between the points
 * an assistant names.
 *
 * Lines are 4-connected — every move is one block north, south, east or west — because that is
 * how feet cross the grid. An 8-connected (Bresenham) line would step diagonally past the
 * corner of a block and so miss the one cell a player actually has to climb.
 */

export interface PathPoint {
  x: number;
  z: number;
  y?: number;
}

export interface PathCell {
  x: number;
  z: number;
  /** Expected feet height, interpolated between the given points; undefined when they gave none. */
  y?: number;
  /** Index of the polyline segment the cell belongs to (0 for a single-point path). */
  segment: number;
  /** Distance along the polyline from its first point, in blocks. */
  dist: number;
}

/** Accepts [x, z] and [x, y, z] tuples, as the tool schemas take them. */
export function pointsFromTuples(tuples: ReadonlyArray<ReadonlyArray<number>>): PathPoint[] {
  return tuples.map((t) => (t.length >= 3 ? { x: t[0], y: t[1], z: t[2] } : { x: t[0], z: t[1] }));
}

/** Cells of the 4-connected line from a to b, both ends included. */
export function gridLine(ax: number, az: number, bx: number, bz: number): Array<[number, number]> {
  const dx = Math.abs(bx - ax);
  const dz = Math.abs(bz - az);
  const sx = Math.sign(bx - ax);
  const sz = Math.sign(bz - az);
  const out: Array<[number, number]> = [[ax, az]];
  let ix = 0;
  let iz = 0;
  let x = ax;
  let z = az;
  while (ix < dx || iz < dz) {
    // Step along whichever axis is further behind the ideal line, measured at the middle of the
    // next step, so the staircase hugs the straight line from both sides equally.
    const tx = dx === 0 ? Infinity : (ix + 0.5) / dx;
    const tz = dz === 0 ? Infinity : (iz + 0.5) / dz;
    if (tx < tz) {
      x += sx;
      ix++;
    } else {
      z += sz;
      iz++;
    }
    out.push([x, z]);
  }
  return out;
}

/** Every cell along the polyline, without repeating the shared vertex between segments. */
export function pathCells(points: PathPoint[]): PathCell[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ x: points[0].x, z: points[0].z, y: points[0].y, segment: 0, dist: 0 }];
  const cells: PathCell[] = [];
  let start = 0;
  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s];
    const b = points[s + 1];
    const line = gridLine(a.x, a.z, b.x, b.z);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = line.length - 1;
    for (let i = s === 0 ? 0 : 1; i < line.length; i++) {
      const [x, z] = line[i];
      // Distance is the projection onto the true segment, so a staircase along a diagonal still
      // measures as the diagonal it approximates.
      const along = len === 0 ? 0 : Math.max(0, Math.min(len, ((x - a.x) * (b.x - a.x) + (z - a.z) * (b.z - a.z)) / len));
      const y = a.y !== undefined && b.y !== undefined ? a.y + ((b.y - a.y) * i) / Math.max(1, steps) : i === 0 ? a.y : i === steps ? b.y : undefined;
      cells.push({ x, z, y, segment: s, dist: start + along });
    }
    start += len;
  }
  return cells;
}
