// Vendored from creater-agent apps/agent/src/services/creator-canvas-placement.ts (feat/super-creator, 2026-11-16):
// the Creator Agent's placement rules, so cards this CLI places sit exactly where Flo would put them.
// Keep in step with that file; only this header differs.
// Where new work goes on the desk (docs/flo-architecture-foundation.md §6 item 3).
// Gestalt, not chosen coordinates:
//   proximity   a result sits beside the node it came from;
//   figure      with no source, it goes into what the user is looking at, right first, then down;
//   grouping    the results of one request form one group, in generation order;
//   spacing     nothing is placed closer than the canvas gap to existing content.
// Pure geometry. Positions are in flow coordinates: rectangles are top-left
// boxes; a node's stored position is the top centre and is converted by the
// writer, not here.

export type CanvasRect = { x: number; y: number; width: number; height: number };
export type CanvasSize = { width: number; height: number };

/** The canvas's own gap between nodes (frontend CANVAS_NODE_PLACEMENT.nodeGap): new work keeps it from other content. */
export const CANVAS_NODE_GAP = 32;
// Inside a group of the Agent's results (DK 2026-11-15: five poem cards sat edge to edge in a tight frame): cards a
// generous gutter apart, the frame clear of them all round, like the storyboard board's own breathing room.
/** The gap between the cards of one group. */
export const CANVAS_GROUP_GAP = 48;
/** The inner padding of a group, between its frame and its cards. */
export const CANVAS_GROUP_PADDING = 40;
/** The width of a new media node when nothing else says (frontend DEFAULT_PLACEMENT_NODE_WIDTH). */
export const CANVAS_DEFAULT_NODE_WIDTH = 384;
/** Results in one group share at most this many columns. */
export const CANVAS_GROUP_COLUMNS = 4;
/** The shape a group aims for when the browser sent no view: a laptop's canvas area. */
const DEFAULT_VIEW_ASPECT = 16 / 10;

export type PlacementContext = {
  /** Top-level boxes already on the canvas: ungrouped nodes and whole groups. Group members are inside their group. */
  obstacles: CanvasRect[];
  /** What the user is looking at, in flow coordinates, when the browser sent it. */
  view?: CanvasRect | undefined;
  /** The node the new work came from, when it is on the canvas. */
  anchor?: CanvasRect | undefined;
};

const LATTICE_RADIUS = 40;

/** A new box conflicts with an existing one when either, grown by the gap, touches the other. */
const conflicts = (rect: CanvasRect, other: CanvasRect) => (
  rect.x - CANVAS_NODE_GAP < other.x + other.width
  && rect.x + rect.width + CANVAS_NODE_GAP > other.x
  && rect.y - CANVAS_NODE_GAP < other.y + other.height
  && rect.y + rect.height + CANVAS_NODE_GAP > other.y
);

const clear = (rect: CanvasRect, obstacles: readonly CanvasRect[]) => (
  obstacles.every(obstacle => !conflicts(rect, obstacle))
);

const centreOf = (rect: CanvasRect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

const insideView = (rect: CanvasRect, view: CanvasRect) => (
  rect.x >= view.x && rect.y >= view.y
  && rect.x + rect.width <= view.x + view.width && rect.y + rect.height <= view.y + view.height
);

/** Lattice of top-left positions around a point, in rings: the nearest candidates come first. */
const latticeAround = (reference: { x: number; y: number }, size: CanvasSize) => {
  const step = Math.max(CANVAS_NODE_GAP, Math.round(Math.min(size.width, size.height) / 2));
  const candidates: CanvasRect[] = [];
  for (let i = -LATTICE_RADIUS; i <= LATTICE_RADIUS; i += 1) {
    for (let j = -LATTICE_RADIUS; j <= LATTICE_RADIUS; j += 1) {
      candidates.push({
        x: Math.round(reference.x + i * step - size.width / 2),
        y: Math.round(reference.y + j * step - size.height / 2),
        width: size.width,
        height: size.height,
      });
    }
  }
  const distance = (rect: CanvasRect) => {
    const centre = centreOf(rect);
    return Math.hypot(centre.x - reference.x, centre.y - reference.y);
  };
  return candidates
    .map(rect => ({ rect, distance: distance(rect) }))
    .sort((a, b) => a.distance - b.distance || a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .map(({ rect }) => rect);
};

/** Beside a source node: right, below, left, above, then the nearest free lattice point. */
const besideAnchor = (anchor: CanvasRect, size: CanvasSize, obstacles: readonly CanvasRect[]) => {
  const gap = CANVAS_NODE_GAP;
  const aligned: CanvasRect[] = [
    { x: anchor.x + anchor.width + gap, y: anchor.y, ...size },
    { x: anchor.x, y: anchor.y + anchor.height + gap, ...size },
    { x: anchor.x - size.width - gap, y: anchor.y, ...size },
    { x: anchor.x, y: anchor.y - size.height - gap, ...size },
  ];
  const found = [...aligned, ...latticeAround(centreOf(anchor), size)].find(rect => clear(rect, obstacles));
  if (!found) throw new Error("No free space near the source node.");
  return found;
};

/**
 * In the view, right first, then down (as the canvas places what the user adds): from the view's centre, the first
 * clear spot along the row to the right, then the rows below, each starting again at the centre. Once the view is
 * full, the rows below it, within its width. Undefined when none of that is clear.
 */
const rightThenDown = (size: CanvasSize, view: CanvasRect, obstacles: readonly CanvasRect[]) => {
  const gap = CANVAS_NODE_GAP;
  const left = Math.round(Math.max(view.x, view.x + view.width / 2 - size.width / 2));
  const top = Math.round(Math.max(view.y, view.y + view.height / 2 - size.height / 2));
  const right = view.x + view.width - size.width;
  // Only what stands in the columns searched can block a spot there (a canvas can hold thousands of nodes elsewhere).
  const inColumns = obstacles.filter(rect => rect.x < view.x + view.width + gap && rect.x + rect.width + gap > left);
  // Candidate columns and rows: the start, and a gap past every such obstacle's right or bottom edge.
  const xs = [...new Set([left, ...inColumns.map(rect => rect.x + rect.width + gap)])]
    .filter(x => x >= left && x <= Math.max(left, right)).sort((a, b) => a - b);
  const lowest = inColumns.reduce((bottom, rect) => Math.max(bottom, rect.y + rect.height), view.y + view.height);
  const ys = [...new Set([top, ...inColumns.map(rect => rect.y + rect.height + gap), lowest + gap])]
    .filter(y => y >= top).sort((a, b) => a - b);
  for (const y of ys) {
    for (const x of xs) {
      const rect = { x, y, width: size.width, height: size.height };
      if (clear(rect, inColumns)) return rect;
    }
  }
  return undefined;
};

/**
 * Without a source: in the user's view, right first, then down (rightThenDown); failing that, the free space nearest
 * the view. With no view either, just beside the existing work's top row.
 */
const inEmptySpace = (size: CanvasSize, context: PlacementContext) => {
  const { obstacles, view } = context;
  if (view) {
    const placed = rightThenDown(size, view, obstacles);
    if (placed) return placed;
  }
  const reference = view
    ? centreOf(view)
    : obstacles.length === 0
      ? { x: 0, y: 0 }
      : {
        x: Math.max(...obstacles.map(rect => rect.x + rect.width)) + CANVAS_NODE_GAP + size.width / 2,
        y: Math.min(...obstacles.map(rect => rect.y)) + size.height / 2,
      };
  const candidates = latticeAround(reference, size).filter(rect => clear(rect, obstacles));
  if (view) {
    const inside = candidates.find(rect => insideView(rect, view));
    if (inside) return inside;
  }
  if (candidates.length === 0) throw new Error("No free space on the canvas.");
  return candidates[0]!;
};

/** One result: a single node, beside its source when there is one. */
export const placeSingle = (size: CanvasSize, context: PlacementContext): CanvasRect => (
  context.anchor
    ? besideAnchor(context.anchor, size, context.obstacles)
    : inEmptySpace(size, context)
);

export type PlacedGroup = {
  /** The group box, in flow coordinates. */
  group: CanvasRect;
  /** Each member's top-left, relative to the group box, in generation order. */
  members: Array<{ x: number; y: number; width: number; height: number }>;
};

/**
 * How many columns a group of `count` cards of this size takes: the grid whose shape is closest to the view's, every row
 * full but the last, and the last at least half full (five go 3 + 2, four 2 × 2, three in a row on a wide view). The
 * view is brought to the whole group once it lands, so the view's width is a shape to match, not a limit.
 */
const groupColumns = (count: number, cell: CanvasSize, viewAspect: number) => {
  let best = 1;
  let bestScore = Infinity;
  for (let columns = 1; columns <= Math.min(count, CANVAS_GROUP_COLUMNS); columns += 1) {
    const rows = Math.ceil(count / columns);
    const last = count - (rows - 1) * columns;
    if (rows > 1 && last < Math.ceil(columns / 2)) continue;
    const width = columns * cell.width + (columns - 1) * CANVAS_GROUP_GAP;
    const height = rows * cell.height + (rows - 1) * CANVAS_GROUP_GAP;
    const score = Math.abs(Math.log(width / height / viewAspect));
    if (score < bestScore - 1e-9) {
      best = columns;
      bestScore = score;
    }
  }
  return best;
};

/**
 * The inside of a group: results in generation order on a grid (columns as wide as their widest card, rows as tall as
 * their tallest), a gutter between cards and padding all round.
 */
export const groupLayout = (sizes: CanvasSize[], view?: CanvasRect) => {
  if (sizes.length === 0) throw new Error("A group needs at least one member.");
  const cell = {
    width: sizes.reduce((sum, size) => sum + size.width, 0) / sizes.length,
    height: sizes.reduce((sum, size) => sum + size.height, 0) / sizes.length,
  };
  const viewAspect = view && view.width > 0 && view.height > 0 ? view.width / view.height : DEFAULT_VIEW_ASPECT;
  const columns = groupColumns(sizes.length, cell, viewAspect);
  const columnWidths = Array.from({ length: columns }, (_, column) => Math.max(...sizes.filter((_, index) => index % columns === column).map(size => size.width)));
  const rowCount = Math.ceil(sizes.length / columns);
  const rowHeights = Array.from({ length: rowCount }, (_, row) => Math.max(...sizes.slice(row * columns, row * columns + columns).map(size => size.height)));
  const offset = (lengths: number[], index: number) => lengths.slice(0, index).reduce((sum, length) => sum + length + CANVAS_GROUP_GAP, 0);
  const members = sizes.map((size, index) => ({
    x: CANVAS_GROUP_PADDING + offset(columnWidths, index % columns),
    y: CANVAS_GROUP_PADDING + offset(rowHeights, Math.floor(index / columns)),
    width: size.width,
    height: size.height,
  }));
  return {
    width: offset(columnWidths, columns) - CANVAS_GROUP_GAP + CANVAS_GROUP_PADDING * 2,
    height: offset(rowHeights, rowCount) - CANVAS_GROUP_GAP + CANVAS_GROUP_PADDING * 2,
    members,
  };
};

/** Several results from one request, placed as a new group. */
export const placeGroup = (sizes: CanvasSize[], context: PlacementContext): PlacedGroup => {
  const layout = groupLayout(sizes, context.view);
  return { group: placeSingle({ width: layout.width, height: layout.height }, context), members: layout.members };
};

/** Whether a box stays a gap away from everything. */
export const isClear = (rect: CanvasRect, obstacles: readonly CanvasRect[]) => clear(rect, obstacles);
